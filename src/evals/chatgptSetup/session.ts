import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { isChatgptBuiltinServer } from '../externalHost/builtins/chatgptTrace.js';
import { defaultChatgptConfigHome } from './macController.js';
import {
  installCodexConfig,
  resolveCodexSetup,
  type CodexConfigInstallation,
} from '../codexSetup/config.js';
import type { ExternalHostConfig } from '../externalHost/types.js';
import type { SemanticDesktopTelemetry } from '../cowork/driver.js';
import {
  chatgptSurface,
  readLaunchEnvironment,
  stringOption,
  validateChatgptConfig,
  type ChatgptApplicationController,
} from '../chatgpt/driver.js';
import { NativeChatgptDriverError } from '../chatgpt/linux.js';
import { chatgptPlatform } from './platform.js';

const activeApplications = new Set<string>();

interface ChatgptLifecycleState {
  controller: ChatgptApplicationController;
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
  const platform = chatgptPlatform(config);
  return {
    platform: platform.name,
    application: platform.application(config, binding),
    setup,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    surface: chatgptSurface(config),
    environment: readLaunchEnvironment(config.options?.environment),
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
    nativeSetup: undefined as SemanticDesktopTelemetry | undefined,
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
      const platform = chatgptPlatform(config);
      const settings = sessionSettings(config, binding);
      this.#settings = settings;
      const lease = `${platform.name}:${settings.application.leaseKey}`;
      if (activeApplications.has(lease))
        throw new Error(
          'Another MST run is already managing this ChatGPT application.'
        );
      activeApplications.add(lease);
      this.#lease = lease;
      if (platform.permissionNotice)
        process.stderr.write(platform.permissionNotice);
      const controller = await platform.controller(settings.application);
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
          platform.isolatedConfigHome ||
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
      if (platform.verifyReady) {
        this.telemetry.nativeSetup = await platform.verifyReady(config);
        this.record('setup', 'verify_surface');
      }
      this.#ready = true;
      this.telemetry.setupStatus = 'completed';
    } catch (error) {
      this.telemetry.setupStatus = 'failed';
      if (error instanceof NativeChatgptDriverError)
        this.telemetry.nativeSetup = error.telemetry;
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
