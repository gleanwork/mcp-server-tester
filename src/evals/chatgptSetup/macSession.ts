import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { isChatgptBuiltinServer } from '../externalHost/builtins/chatgptTrace.js';
import {
  defaultChatgptAppPath,
  defaultChatgptBundleId,
  defaultChatgptConfigHome,
  getChatgptApplicationController,
} from './macController.js';
import {
  installCodexConfig,
  resolveCodexSetup,
  type CodexConfigInstallation,
} from '../codexSetup/config.js';
import type { ExternalHostConfig } from '../externalHost/types.js';
import {
  readLaunchEnvironment,
  stringOption,
  validateChatgptConfig,
} from '../chatgpt/driver.js';

const activeApplications = new Set<string>();

interface ChatgptLifecycleState {
  controller: Awaited<ReturnType<typeof getChatgptApplicationController>>;
  wasRunning: boolean;
  stopped: boolean;
  launchAttempted: boolean;
  installation?: CodexConfigInstallation;
}

function sessionSettings(
  config: ExternalHostConfig,
  binding?: Record<string, unknown>
) {
  const configName =
    stringOption(binding, 'configName') ??
    stringOption(config.options, 'codexConfigName');
  const setup = config.codexSetup
    ? resolveCodexSetup(config.codexSetup, configName)
    : undefined;
  if (setup?.servers.some((server) => isChatgptBuiltinServer(server.label)))
    throw new Error(
      'ChatGPT MCP server labels must not collide with built-in host tool namespaces.'
    );
  if (setup && basename(setup.configPath) !== 'config.toml')
    throw new Error(
      'ChatGPT loads CODEX_HOME/config.toml; configPath must end in config.toml.'
    );
  return {
    setup,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    environment: readLaunchEnvironment(config.options?.environment),
    appPath:
      stringOption(binding, 'appPath') ??
      stringOption(config.options, 'chatgptAppPath') ??
      defaultChatgptAppPath(),
    bundleId:
      stringOption(binding, 'bundleId') ??
      stringOption(config.options, 'chatgptBundleId') ??
      defaultChatgptBundleId(),
    sessionsRoot: stringOption(config.options, 'chatgptSessionRoot'),
  };
}

/** One app/config transaction. Per-query native baselines and run state never live here. */
export class ChatgptAppSession {
  #lifecycle?: ChatgptLifecycleState;
  #lease?: string;
  #settings?: ReturnType<typeof sessionSettings>;
  #ready = false;
  #disposed = false;
  sessionsRoot?: string;
  readonly telemetry = {
    id: randomUUID(),
    scope: 'batch' as 'batch' | 'case',
    setupStatus: 'not-started' as 'not-started' | 'completed' | 'failed',
    cleanupStatus: 'not-started' as 'not-started' | 'completed' | 'failed',
    setupDurationMs: 0,
    cleanupDurationMs: 0,
    events: [] as Array<{
      phase: 'setup' | 'cleanup';
      operation: string;
      completedAt: string;
    }>,
  };

  constructor(scope: 'batch' | 'case' = 'batch') {
    this.telemetry.scope = scope;
  }

  async prepare(
    config: ExternalHostConfig,
    binding?: Record<string, unknown>
  ): Promise<void> {
    if (this.#settings || this.#disposed)
      throw new Error('ChatGPT app session cannot be prepared twice.');
    const started = Date.now();
    try {
      validateChatgptConfig(config);
      const settings = sessionSettings(config, binding);
      this.#settings = settings;
      if (activeApplications.has(settings.bundleId))
        throw new Error(
          'Another MST run is already managing this ChatGPT application.'
        );
      activeApplications.add(settings.bundleId);
      this.#lease = settings.bundleId;
      process.stderr.write(
        '[mst:chatgpt] Anthropic Computer Use requires Screen Recording and Accessibility permission. Keep ChatGPT visible and the desktop idle.\n'
      );
      const controller = await getChatgptApplicationController({
        appPath: settings.appPath,
        bundleId: settings.bundleId,
      });
      const wasRunning = (await controller.state()).running;
      const lifecycle = (this.#lifecycle = {
        controller,
        wasRunning,
        stopped: false,
        launchAttempted: false,
      } as ChatgptLifecycleState);
      if (wasRunning) {
        await controller.stop();
        this.record('setup', 'stop');
      }
      lifecycle.stopped = true;
      const environment = { ...settings.environment };
      if (config.codexSetup) {
        lifecycle.installation = await installCodexConfig(config.codexSetup, {
          configName: settings.setup?.configName,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
        });
        this.record('setup', 'install_config');
        const configHome = dirname(lifecycle.installation.configPath);
        if (
          configHome !== defaultChatgptConfigHome() ||
          environment.CODEX_HOME !== undefined
        )
          environment.CODEX_HOME = configHome;
      }
      this.sessionsRoot =
        settings.sessionsRoot ??
        join(
          environment.CODEX_HOME ??
            process.env.CODEX_HOME ??
            defaultChatgptConfigHome(),
          'sessions'
        );
      lifecycle.launchAttempted = true;
      await controller.start(environment);
      this.record('setup', 'start');
      this.#ready = true;
      this.telemetry.setupStatus = 'completed';
    } catch (error) {
      this.telemetry.setupStatus = 'failed';
      throw error;
    } finally {
      this.telemetry.setupDurationMs = Date.now() - started;
    }
  }

  assertCompatible(
    config: ExternalHostConfig,
    binding?: Record<string, unknown>
  ): void {
    if (
      !this.#ready ||
      this.#disposed ||
      !isDeepStrictEqual(this.#settings, sessionSettings(config, binding))
    )
      throw new Error(
        'ChatGPT batch app session is unavailable or has different settings.'
      );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    const started = Date.now();
    try {
      const lifecycle = this.#lifecycle;
      if (lifecycle?.stopped) {
        if (lifecycle.launchAttempted) {
          await lifecycle.controller.stop();
          this.record('cleanup', 'stop');
        }
        if (lifecycle.installation) {
          await lifecycle.installation.restore({ archiveChanges: true });
          this.record('cleanup', 'restore_config');
        }
        if (lifecycle.wasRunning) {
          await lifecycle.controller.start();
          this.record('cleanup', 'start');
        }
      }
      this.telemetry.cleanupStatus = 'completed';
    } catch (error) {
      this.telemetry.cleanupStatus = 'failed';
      throw error;
    } finally {
      this.telemetry.cleanupDurationMs = Date.now() - started;
      if (this.#lease) activeApplications.delete(this.#lease);
    }
  }

  private record(phase: 'setup' | 'cleanup', operation: string): void {
    this.telemetry.events.push({
      phase,
      operation,
      completedAt: new Date().toISOString(),
    });
  }
}
