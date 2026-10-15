import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { activeChatOwnership, confirmChatgptQuitPrompt } from './quitPrompt.js';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { isChatgptBuiltinServer } from '../externalClient/builtins/chatgptTrace.js';
import { defaultChatgptConfigHome } from './macController.js';
import {
  installCodexConfig,
  resolveCodexSetup,
  type CodexBuiltinToolPolicy,
  type CodexConfigInstallation,
  type CodexSetupConfig,
} from '../codexSetup/config.js';
import type { ExternalClientConfig } from '../externalClient/types.js';
import type { SemanticDesktopTelemetry } from '../cowork/driver.js';
import {
  chatgptSurface,
  readLaunchEnvironment,
  stringOption,
  validateChatgptConfig,
  type ChatgptApplicationController,
} from '../chatgpt/driver.js';
import { NativeChatgptDriverError } from '../chatgpt/linux.js';
import { saveStallScreenshot } from '../chatgpt/stallScreenshot.js';
import { chatgptPlatform } from './platform.js';
import type {
  ChatgptPlatformProfile,
  LinuxChatgptReadiness,
} from './linuxProfile.js';
import { clientPluginMcpServers } from '../clientPlugins.js';
import type { McpServerReadiness } from '../mcpReadiness.js';
import { preflightChatgptMcpServers } from './mcpPreflight.js';
import { McpReadinessError } from '../mcpReadiness.js';

const activeApplications = new Set<string>();

interface ChatgptLifecycleState {
  controller: ChatgptApplicationController;
  wasRunning: boolean;
  stopped: boolean;
  launchAttempted: boolean;
  installation?: CodexConfigInstallation;
}

/** Linux owns config even without MCP servers: keyring login needs it. */
function effectiveSetup(
  config: ExternalClientConfig,
  configPath: string | undefined
): CodexSetupConfig | undefined {
  if (!configPath) return config.codexSetup;
  return { ...(config.codexSetup ?? { servers: [] }), configPath };
}

function sessionSettings(
  config: ExternalClientConfig,
  binding?: Record<string, unknown>
) {
  const configName =
    stringOption(binding, 'configName') ??
    stringOption(config.options, 'codexConfigName');
  const platform = chatgptPlatform(config);
  const application = platform.application(config, binding);
  const codexSetup = effectiveSetup(config, application.configPath);
  const setup = codexSetup
    ? resolveCodexSetup(codexSetup, configName)
    : undefined;
  const pluginLabels = clientPluginMcpServers(config.plugins ?? []).map(
    (target) => target.server
  );
  if (
    setup?.servers.some((server) => isChatgptBuiltinServer(server.label)) ||
    pluginLabels.some(isChatgptBuiltinServer)
  )
    throw new Error(
      'ChatGPT MCP server labels must not collide with built-in tool namespaces.'
    );
  if (setup && basename(setup.configPath) !== 'config.toml')
    throw new Error(
      'ChatGPT loads CODEX_HOME/config.toml; configPath must end in config.toml.'
    );
  if (config.plugins?.length && !platform.createProfile)
    throw new Error('ChatGPT client plugins require the Linux fresh profile.');
  return {
    platform: platform.name,
    application,
    codexSetup,
    setup,
    plugins: config.plugins ?? [],
    pluginCredentials: config.pluginCredentials ?? {},
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    surface: chatgptSurface(config),
    environment: readLaunchEnvironment(config.options?.environment),
    sessionsRoot: stringOption(config.options, 'chatgptSessionRoot'),
  };
}

/** One app/config transaction. Per-query native baselines and run state never live here. */
/** OpenAI's own marketplaces; their plugins are the app's built-in tools. */
const OPENAI_MARKETPLACES = new Set([
  'openai-bundled',
  'openai-primary-runtime',
]);
/** Built-ins that let the model act outside the servers under test. */
const MAC_DISABLED_BUILTINS = new Set([
  'unified-computer-use@openai-bundled',
  'browser@openai-bundled',
]);
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9._-]+$/;

/**
 * macOS runs in the user's own profile, so turn off what would answer
 * instead of the servers under test, for the run only (the config is
 * restored after): ChatGPT's account connectors (`apps`, the `codex_apps`
 * server), web search and the in-app browser, computer use, and every plugin the
 * user installed (their skills and MCP servers).
 */
async function macBuiltinToolPolicy(
  configPath: string
): Promise<CodexBuiltinToolPolicy> {
  let plugins: string[] = [];
  try {
    const parsed = parseToml(await readFile(configPath, 'utf8')) as {
      plugins?: unknown;
    };
    if (parsed.plugins && typeof parsed.plugins === 'object')
      plugins = Object.keys(parsed.plugins);
  } catch {
    // No readable config: nothing installed to turn off.
  }
  return {
    webSearch: 'disabled',
    disabledPlugins: [
      ...new Set([
        ...MAC_DISABLED_BUILTINS,
        ...plugins.filter(
          (id) =>
            PLUGIN_ID.test(id) &&
            !OPENAI_MARKETPLACES.has(id.slice(id.indexOf('@') + 1))
        ),
      ]),
    ],
    // The in-app browser is a second way to the web, and its New tab sits
    // where the planner looks for New chat.
    disabledFeatures: ['apps', 'in_app_browser'],
  };
}

export class ChatgptAppSession {
  #lifecycle?: ChatgptLifecycleState;
  #profile?: ChatgptPlatformProfile;
  #lease?: string;
  #settings?: ReturnType<typeof sessionSettings>;
  #ready = false;
  #disposed = false;
  #launch?: {
    config: ExternalClientConfig;
    environment: Record<string, string>;
    platform: ReturnType<typeof chatgptPlatform>;
  };
  sessionsRoot?: string;
  /** Linux: where native evidence is copied before profile teardown. */
  evidenceDir?: string;
  /**
   * macOS Codex surface: an empty, trusted folder each task opens in (a Codex
   * task needs one). ChatGPT Work makes its own. Linux's profile owns its own.
   */
  workspace?: string;
  /** Queries MST submitted, to tell its chats from any others. */
  readonly #submitted = new Set<string>();
  /** When MST last launched the app. */
  #launchedAtMs?: number;
  readonly telemetry = {
    id: randomUUID(),
    scope: 'batch' as 'batch' | 'case',
    setupStatus: 'not-started' as 'not-started' | 'completed' | 'failed',
    cleanupStatus: 'not-started' as 'not-started' | 'completed' | 'failed',
    setupDurationMs: 0,
    cleanupDurationMs: 0,
    /** Restarts after failed cases; each case still gets exactly one send. */
    recoveryCount: 0,
    recoveryDurationMs: 0,
    nativeSetup: undefined as SemanticDesktopTelemetry | undefined,
    /** Linux: whether a display screenshot was saved after a failed surface check. */
    prepareScreenshot: undefined as 'captured' | 'unavailable' | undefined,
    /** Linux login and MCP readiness, sanitized. */
    nativeReadiness: undefined as LinuxChatgptReadiness | undefined,
    /** macOS direct MCP preflight, sanitized. Linux records it in nativeReadiness. */
    mcpPreflight: undefined as McpServerReadiness[] | undefined,
    events: [] as Array<{
      phase: 'setup' | 'recovery' | 'cleanup';
      operation: string;
      completedAt: string;
    }>,
  };

  constructor(scope: 'batch' | 'case' = 'batch') {
    this.telemetry.scope = scope;
  }

  async prepare(
    config: ExternalClientConfig,
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
      if (!platform.createProfile && settings.setup?.servers.length) {
        // Before stopping the user's app: a dead server must not look like a
        // model failure. Linux runs the same gate inside its fresh profile.
        const preflight = await preflightChatgptMcpServers(
          settings.setup.servers,
          settings.environment
        );
        this.telemetry.mcpPreflight = preflight.servers;
        this.record('setup', 'verify_mcp');
        if (!preflight.passed)
          throw new McpReadinessError('ChatGPT', preflight.servers);
      }
      if (platform.permissionNotice)
        process.stderr.write(platform.permissionNotice);
      if (platform.createProfile) {
        this.#profile = await platform.createProfile(settings.application);
        this.telemetry.nativeReadiness = this.#profile.readiness;
        this.evidenceDir = this.#profile.evidenceDir;
        this.record('setup', 'create_profile');
      }
      const controller =
        this.#profile?.controller ??
        (await platform.controller?.(settings.application));
      if (!controller)
        throw new Error('ChatGPT platform has no application controller.');
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
      if (settings.codexSetup) {
        if (!this.#profile && chatgptSurface(config) === 'codex')
          this.workspace = await realpath(
            await mkdtemp(join(tmpdir(), 'mst-chatgpt-workspace-'))
          );
        lifecycle.installation = await installCodexConfig(settings.codexSetup, {
          configName: settings.setup?.configName,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          ...(this.workspace ? { trustedProject: this.workspace } : {}),
          ...(!this.#profile
            ? {
                builtinToolPolicy: await macBuiltinToolPolicy(
                  settings.codexSetup.configPath ??
                    join(defaultChatgptConfigHome(), 'config.toml')
                ),
              }
            : {}),
          ...this.#profile?.install,
        });
        this.record('setup', 'install_config');
        const configHome = dirname(
          this.#profile?.configPath ?? lifecycle.installation.configPath
        );
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
      if (this.#profile) {
        if (!settings.setup)
          throw new Error('ChatGPT platform profile requires a native config.');
        // Login, direct MCP preflight, and app-server status: before any prompt.
        await this.#profile.beforeStart(
          settings.setup,
          environment,
          settings.plugins,
          settings.pluginCredentials
        );
        this.record('setup', 'verify_login_and_mcp');
      }
      lifecycle.launchAttempted = true;
      this.#launch = { config, environment, platform };
      await this.#start('setup');
      this.#ready = true;
      this.telemetry.setupStatus = 'completed';
    } catch (error) {
      this.telemetry.setupStatus = 'failed';
      if (error instanceof NativeChatgptDriverError)
        this.telemetry.nativeSetup = error.telemetry;
      // Not yet in the installed config: nothing else will remove it.
      if (this.workspace && !this.#lifecycle?.installation) {
        await rm(this.workspace, { recursive: true, force: true });
        this.workspace = undefined;
      }
      throw error;
    } finally {
      this.telemetry.setupDurationMs = Date.now() - started;
    }
  }

  async #start(phase: 'setup' | 'recovery'): Promise<void> {
    const { config, environment, platform } = this.#launch!;
    this.#launchedAtMs = Date.now();
    await this.#lifecycle!.controller.start(environment);
    this.record(phase, 'start');
    if (platform.verifyReady) {
      try {
        this.telemetry.nativeSetup = await platform.verifyReady(
          config,
          (prompt) => this.openPrompt(prompt)
        );
      } catch (error) {
        // Show what blocked the surface; capture never changes the failure.
        if (this.evidenceDir) {
          const screenshot = await saveStallScreenshot({
            evidenceDir: this.evidenceDir,
            caseId: phase,
            display: environment.DISPLAY ?? process.env.DISPLAY,
            xauthority: environment.XAUTHORITY ?? process.env.XAUTHORITY,
            label: 'prepare',
          });
          this.telemetry.prepareScreenshot = screenshot.path
            ? 'captured'
            : 'unavailable';
        }
        throw error;
      }
      this.record(phase, 'verify_surface');
    }
  }

  /**
   * After a failed case: stop and restart the owned app with the same profile,
   * config, and environment, then verify the surface again. Never sends. A failed
   * restart leaves the session unready, so no further case can use it.
   */
  async restart(): Promise<void> {
    if (!this.#ready || this.#disposed || !this.#launch)
      throw new Error('ChatGPT app session is not running.');
    this.#ready = false;
    const started = Date.now();
    try {
      await this.#stopOwned('recovery');
      this.record('recovery', 'stop');
      await this.#start('recovery');
      this.#ready = true;
    } finally {
      this.telemetry.recoveryCount += 1;
      this.telemetry.recoveryDurationMs += Date.now() - started;
    }
  }

  /** Record a query before submitting it, so cleanup can tell MST's chats apart. */
  noteSubmission(query: string): void {
    this.#submitted.add(query.trim());
  }

  /**
   * Quit the app MST launched. A stalled case leaves its chat mid-turn, and
   * ChatGPT then asks "Quit ChatGPT? Active local chats on this machine will
   * be interrupted". Confirm it only when every active chat is one MST started
   * in this run (macOS, with the user's own profile); otherwise refuse as before.
   */
  async #stopOwned(phase: 'recovery' | 'cleanup'): Promise<void> {
    const { controller } = this.#lifecycle!;
    try {
      await controller.stop();
      return;
    } catch (error) {
      if (
        this.#profile ||
        this.#launchedAtMs === undefined ||
        !this.sessionsRoot ||
        !(await controller.state()).running
      )
        throw error;
      const chats = await activeChatOwnership(
        this.sessionsRoot,
        this.#launchedAtMs,
        this.#submitted
      );
      if (chats.active === 0 || chats.unowned > 0) throw error;
      if (!(await confirmChatgptQuitPrompt())) throw error;
      this.record(phase, 'confirm_quit');
      const deadline = Date.now() + 20_000;
      while ((await controller.state()).running) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  /** Deep-link draft hand-off through the owned app. Never sends. */
  async openPrompt(prompt: string): Promise<void> {
    const lifecycle = this.#lifecycle;
    if (this.#disposed || !lifecycle?.launchAttempted)
      throw new Error('ChatGPT app session is not running.');
    if (!lifecycle.controller.openPrompt)
      throw new Error('ChatGPT platform cannot open native drafts.');
    await lifecycle.controller.openPrompt(prompt);
  }

  assertCompatible(
    config: ExternalClientConfig,
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
          await this.#stopOwned('cleanup');
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
      if (this.#profile && (!lifecycle || lifecycle.stopped)) {
        await this.#profile.dispose();
        this.record('cleanup', 'dispose_profile');
      }
      if (this.workspace) {
        await rm(this.workspace, { recursive: true, force: true });
        this.record('cleanup', 'remove_workspace');
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

  private record(
    phase: 'setup' | 'recovery' | 'cleanup',
    operation: string
  ): void {
    this.telemetry.events.push({
      phase,
      operation,
      completedAt: new Date().toISOString(),
    });
  }
}
