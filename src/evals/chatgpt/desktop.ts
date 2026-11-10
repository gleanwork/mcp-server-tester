import type { SemanticDesktopTelemetry } from '../cowork/interaction.js';
import type { ChatgptApplicationController } from './driver.js';
import type { ChatgptPromptOpener } from './linuxDesktop.js';
import type { ChatgptAppConfig } from './config.js';
import type { ChatgptPlatformProfile } from '../chatgptSetup/linuxProfile.js';
import type { ChatgptTurn, ChatgptTurnState } from './turn.js';
import type { DesktopProduct } from './product.js';
import type { ClientApp } from '../installedApp.js';

/** Comparable application identity; `leaseKey` claims the app within this process. */
interface ChatgptApplication {
  leaseKey: string;
  appPath?: string;
  bundleId?: string;
  desktopEnvironment?: NodeJS.ProcessEnv;
  /** Session-owned config.toml; overrides codexSetup.configPath. */
  configPath?: string;
}

/** Native operations supplied by one product's concrete OS entry point. */
export interface ChatgptDesktop {
  readonly product: DesktopProduct;
  readonly name: 'macos' | 'linux';
  readonly os: 'darwin' | 'linux';
  /** Linux always owns an isolated profile, so CODEX_HOME is always explicit. */
  readonly isolatedConfigHome: boolean;
  readonly permissionNotice?: string;
  /** Directory that holds the cross-process desktop lock. */
  lockHome(config: ChatgptAppConfig): string;
  application(
    config: ChatgptAppConfig,
    binding?: Record<string, unknown>
  ): ChatgptApplication;
  controller?(
    application: ChatgptApplication
  ): Promise<ChatgptApplicationController>;
  createProfile?(
    application: ChatgptApplication
  ): Promise<ChatgptPlatformProfile>;
  verifyReady?(
    config: ChatgptAppConfig,
    openPrompt: ChatgptPromptOpener
  ): Promise<SemanticDesktopTelemetry>;
  validate(config: ChatgptAppConfig): void;
  /**
   * The installed app and its version, which each trial records as
   * `clientTelemetry.clientApp`; undefined when the app can't say.
   */
  app(application: ChatgptApplication): Promise<ClientApp | undefined>;
  /** How long a fresh native session may take to appear after submission. */
  readonly bindingWindowMs: number;
  /** Whether native transcripts escape Markdown in the recorded prompt. */
  readonly nativeMarkdownEscapes: boolean;
  submit(state: ChatgptTurnState): Promise<ChatgptTurn | void>;
}
