import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { variantToolMetadata } from './evalConfig.js';
import type {
  ClientDefinition,
  ClientRunContext,
  ClientRunResult,
  ClientSessionOptions,
} from './evalFrameworkTypes.js';
import { toolCallEvents } from './clientTrace.js';
import { runChatgptTurn, type ChatgptTurn } from './chatgpt/turn.js';
import type { ChatgptAppConfig } from './chatgpt/config.js';
import { ChatgptAppSession } from './chatgptSetup/session.js';
import { chatgptServers } from './chatgptSetup/config.js';
import {
  MarketplacePluginsSchema,
  clientPluginMcpServers,
  resolveClientPluginCredentials,
} from './clientPlugins.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { endingOf } from './trialEnding.js';
import { clientSecretValues, redactClientSecrets } from './clientSecrets.js';
import {
  collectClientBatch,
  openDesktopSession,
  requireIdenticalClientSettings,
  type DesktopClientAdapter,
} from './desktopBatch.js';
import {
  CHATGPT_MAX_ACTIONS,
  chatgptMaxActionsSummary,
} from './chatgpt/maxActions.js';
import {
  CHATGPT_APP_REASONING_EFFORTS,
  reasoningEffortOption,
} from './reasoningEffort.js';
import type { ChatgptDesktop } from './chatgpt/desktop.js';
import { chatgptMacos } from './chatgpt/macos.js';
import { chatgptLinux } from './chatgpt/linux.js';
import { codexAppMacos } from './codex-app/macos.js';
import { codexAppLinux } from './codex-app/linux.js';
import {
  CHATGPT_PRODUCT,
  CODEX_APP_PRODUCT,
  type DesktopProduct,
} from './chatgpt/product.js';
import {
  COMPUTER_USE_PROVIDER_GONE,
  fixedProviderGone,
  maxActionsRenamed,
  osName,
} from './desktopOS.js';
import { removedClientOptions } from './renamedKeys.js';
import { DEFAULT_COMPUTER_USE_MODEL } from './cowork/computerUseLoop.js';

/**
 * Why `clientOptions.surface` fails: the surface is the client now (ADR
 * 0011), and the message names the client to use for `value`.
 */
function surfaceGone(product: DesktopProduct, value: unknown): string {
  const wanted =
    value === 'codex'
      ? CODEX_APP_PRODUCT
      : value === 'chatgpt-work'
        ? CHATGPT_PRODUCT
        : undefined;
  const gone = '`clientOptions.surface` is gone:';
  if (!wanted)
    return `${gone} use the \`chatgpt\` client for ChatGPT Work, or \`codex-app\` for the Codex surface.`;
  const surface =
    wanted === CODEX_APP_PRODUCT ? 'the Codex surface' : 'ChatGPT Work';
  return wanted === product
    ? `${gone} remove it. \`${product.client}\` always drives ${surface}.`
    : `${gone} use the \`${wanted.client}\` client for ${surface}, and remove \`surface\`.`;
}

const schemaOf = (product: DesktopProduct) =>
  z
    .object({
      type: z.string(),
      model: z.string().min(1),
      /** How hard the model reasons, selected in the app. */
      reasoningEffort: reasoningEffortOption(
        product.client,
        CHATGPT_APP_REASONING_EFFORTS
      ).meta({ 'x-defaultDescription': 'app default' }),
      /** Gone: the client fixes its provider. */
      ...removedClientOptions({
        provider: fixedProviderGone(product.client, 'openai'),
      }),
      /** The trial's time limit in ms (default 300000). */
      timeout: z.number().int().positive().default(300_000),
      env: z.record(z.string(), z.string()).optional().meta({
        'x-defaultDescription': 'inherited environment; no extra variables',
      }),
      /** Client-owned: plugins installed into the fresh Linux profile. */
      plugins: MarketplacePluginsSchema.optional()
        .refine(
          (plugins) => !plugins?.some((p) => p.blockMcpServers?.length),
          'ChatGPT does not support plugins[].blockMcpServers; use plugins[].mcp.'
        )
        .meta({
          'x-defaultDescription': 'no marketplace plugins (Linux only)',
        }),
      configPath: z.string().min(1).optional().meta({
        'x-defaultDescription':
          'app profile config.toml on the trial machine (OS-specific)',
      }),
      requireMcpCalls: z.boolean().optional().meta({ default: false }),
      /** Gone: the surface is the client (`chatgpt` or `codex-app`). */
      surface: z
        .never({ error: (issue) => surfaceGone(product, issue.input) })
        .optional(),
      correlation: z
        .enum(['exact_prompt', 'prompt_marker'])
        .default('exact_prompt'),
      /** Gone: the trial's OS decides (ADR 0011). */
      computerUseProvider: z
        .never({ message: COMPUTER_USE_PROVIDER_GONE })
        .optional(),
      /**
       * The most actions the desktop automation may take to send a case's
       * prompt. Its range and default depend on the OS the trial runs on
       * (`CHATGPT_MAX_ACTIONS`), so it is checked against that OS, when the
       * eval config loads if MST knows it, and on the trial's machine.
       */
      maxActions: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          `The most actions the desktop automation may take to send a case's prompt: ${chatgptMaxActionsSummary()}.`
        )
        .meta({
          'x-defaultDescription': `macOS: ${CHATGPT_MAX_ACTIONS.darwin.default}; Linux: ${CHATGPT_MAX_ACTIONS.linux.default}`,
        }),
      /** Gone: the action budget is `maxActions`. */
      nativeMaxActions: z
        .never({ message: maxActionsRenamed('nativeMaxActions') })
        .optional(),
      computerUseModel: z
        .string()
        .regex(/^[A-Za-z0-9._:-]+$/)
        .optional()
        .meta({
          'x-defaultDescription': `macOS: MST_COWORK_CUA_MODEL or ${DEFAULT_COMPUTER_USE_MODEL}; Linux: no planner`,
        }),
      /** Gone: the action budget is `maxActions`. */
      computerUseMaxActions: z
        .never({ message: maxActionsRenamed('computerUseMaxActions') })
        .optional(),
      options: z
        .never({
          message:
            '`clientOptions.options` is gone: set its keys in `clientOptions` directly (`clientOptions.model`, not `clientOptions.options.model`).',
        })
        .optional(),
    })
    .strict();

const SCHEMAS = {
  chatgpt: schemaOf(CHATGPT_PRODUCT),
  'codex-app': schemaOf(CODEX_APP_PRODUCT),
};

/**
 * The ChatGPT app's options that the OS a trial runs on can't use, or can't
 * use as set. macOS runs Computer Use (with `computerUseModel` as its
 * planner) on the installed app; Linux runs the accessibility automation in a
 * fresh profile, the only one `plugins` install into. `maxActions` is either
 * one's budget, with that OS's range. Checked when the eval config loads,
 * when MST knows the OS its trials run on, and again on the machine that
 * runs them.
 */
export function chatgptOptionIssues(
  options: {
    computerUseModel?: unknown;
    maxActions?: unknown;
    plugins?: readonly unknown[];
  },
  os: NodeJS.Platform
): string[] {
  const issues: string[] = [];
  const on = osName(os);
  if (os !== 'darwin' && options.computerUseModel !== undefined)
    issues.push(
      `computerUseModel is the planner of Computer Use on macOS, and this trial runs on ${on}, which has no planner.`
    );
  const budget =
    os === 'darwin' || os === 'linux' ? CHATGPT_MAX_ACTIONS[os] : undefined;
  if (
    budget &&
    options.maxActions !== undefined &&
    !(
      Number.isInteger(options.maxActions) &&
      (options.maxActions as number) >= 1 &&
      (options.maxActions as number) <= budget.max
    )
  )
    issues.push(
      `maxActions is ${JSON.stringify(options.maxActions)}, and on ${on}, where this trial runs, it is 1 to ${budget.max} (default ${budget.default}).`
    );
  if (os !== 'linux' && options.plugins?.length)
    issues.push(
      `plugins install into the fresh profile ChatGPT runs on Linux, and this trial runs on ${on}, which runs the installed app.`
    );
  return issues;
}

/**
 * The trial's result from its native turn: the answer, or the turn's error,
 * with its native calls as events. A call names its server; on a one-server
 * trial, an MCP call that names none came from that server.
 */
function turnRunResult(
  turn: ChatgptTurn,
  servers: MCPConfig[]
): ClientRunResult {
  return {
    finalText: (turn.success ? turn.response : undefined) ?? '',
    error: turn.success ? undefined : turn.error,
    usage: turn.usage,
    ...(turn.modelCalls?.length ? { modelCalls: turn.modelCalls } : {}),
    events: toolCallEvents(turn.toolCalls, servers),
  };
}

function desktopAdapter(
  requests: ClientSessionOptions[],
  context: ClientRunContext,
  platform: ChatgptDesktop
): DesktopClientAdapter<ChatgptAppSession> {
  requests = structuredClone(requests);
  const { product } = platform;
  const { label } = product;
  if ((context.evalConfig.concurrency ?? 1) !== 1)
    throw new Error(`${label} desktop requires concurrency 1.`);
  if (variantToolMetadata(context.evalConfig, context.variant))
    throw new Error(
      `${label} desktop does not support tool metadata (\`tools\`).`
    );
  const schema = SCHEMAS[product.client];
  const configs = requests.map((request) => schema.parse(request.config));
  requireIdenticalClientSettings(label, configs);
  const osIssues = chatgptOptionIssues(configs[0]!, platform.os);
  if (osIssues.length)
    throw new Error(`${label} can't run this trial: ${osIssues.join(' ')}`);
  const credentialEnv = requests.map((request, index) => ({
    ...process.env,
    ...context.env,
    ...request.input.env,
    ...configs[index]!.env,
  }));
  const prepared = requests.map((request, index) =>
    chatgptServers(request.input.servers, credentialEnv[index]!)
  );
  // Plugin credentials use the same environment lookup as direct servers.
  const pluginCredentials = configs.map((config, index) =>
    resolveClientPluginCredentials(config.plugins ?? [], credentialEnv[index]!)
  );
  // Every error this batch surfaces is redacted against these values.
  const secrets = [
    ...new Set(
      requests.flatMap((request, index) =>
        clientSecretValues(credentialEnv[index]!, request.input.servers, [
          ...Object.values(prepared[index]!.environment),
          ...Object.values(pluginCredentials[index]!),
        ])
      )
    ),
  ];
  const appConfigs: ChatgptAppConfig[] = requests.map((request, index) => {
    const config = configs[index]!;
    const serverConfig = prepared[index]!;
    const environment = Object.fromEntries(
      Object.entries({
        ...context.env,
        ...request.input.env,
        ...config.env,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined)
    );
    return {
      os: platform.os,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      timeoutMs: config.timeout,
      correlation: {
        strategy: config.correlation,
        includeInPrompt: config.correlation === 'prompt_marker',
      },
      codexSetup: {
        configPath: config.configPath,
        servers: serverConfig.servers,
      },
      ...(config.plugins?.length
        ? {
            plugins: config.plugins,
            pluginCredentials: pluginCredentials[index]!,
          }
        : {}),
      options: {
        environment: { ...config.env, ...serverConfig.environment },
        computerUseModel: config.computerUseModel,
        surface: product.surface,
        // The budget of the OS's automation: Computer Use on macOS, the
        // accessibility automation on Linux.
        maxActions:
          config.maxActions ?? CHATGPT_MAX_ACTIONS[platform.os].default,
        // Linux launches the app in the environment it is given.
        ...(platform.os === 'linux' ? { desktopEnvironment: environment } : {}),
        computerUseEnvironment: environment,
      },
    };
  });
  if (appConfigs.some((config) => !isDeepStrictEqual(config, appConfigs[0])))
    throw new Error(
      `${label} batch requires identical MCP servers, credentials, and environment.`
    );
  // One desktop per run: claimed before any lifecycle operation, because
  // another process must not stop the active app. `chatgpt` and
  // `codex-app` drive the same app, so they claim the same lease.
  const appSession = new ChatgptAppSession(platform, 'batch');
  return {
    name: label,
    lease: {
      directory: join(platform.lockHome(appConfigs[0]!), '.mcp-server-tester'),
      file: 'chatgpt-desktop.lock',
    },
    secrets,
    resetVerb: 'restarted',
    async prepare() {
      await appSession.prepare(appConfigs[0]!);
      return appSession;
    },
    reset: () => appSession.restart(),
    dispose: () => appSession.dispose(),
    batchTelemetry: () => appSession.telemetry,
    async runCase(_session, request, _index, ledger) {
      const config = configs[0]!;
      const serverConfig = prepared[0]!;
      const started = Date.now();
      // Plugin MCP servers are eval servers under their own names.
      const serverLabels = new Set([
        ...serverConfig.servers.map((server) => server.label),
        ...clientPluginMcpServers(config.plugins ?? []).map(
          (target) => target.server
        ),
      ]);
      // Eval prompts stay unchanged. Server selection is verified from native calls,
      // not enforced by adding evaluator instructions to the model's context.
      const result = await runChatgptTurn(
        request.input.prompt,
        appConfigs[0]!,
        appSession,
        { caseId: request.caseId }
      );
      const trace = turnRunResult(result, requests[0]!.input.servers);
      if (trace.error) trace.error = redactClientSecrets(trace.error, secrets);
      if (result.success) {
        const id = result.clientMetadata.session.id;
        if (!id || !result.clientMetadata.session.turnId || !ledger.claim(id))
          trace.error = `${label} requires a distinct native session and turn for each fresh query; refusing duplicate attribution.`;
      }
      if (trace.usage) {
        // Native OpenAI input totals include cache reads; V2 counts cache separately.
        const uncached =
          trace.usage.inputTokens -
          (trace.usage.cacheReadInputTokens ?? 0) -
          (trace.usage.cacheCreationInputTokens ?? 0);
        if (uncached < 0)
          trace.error = 'Native cached input exceeds total input tokens.';
        else trace.usage = { ...trace.usage, inputTokens: uncached };
      }
      // Native/controller/evidence failures restart the app before the next case.
      // A completed, attributed turn can fail the MCP measurement without a restart.
      const executionTrusted = result.success && !trace.error;
      const mcpCalls = result.toolCalls.filter(
        (call) => call.source !== 'builtin'
      );
      const selectedCalls = mcpCalls.filter(
        (call) => call.server && serverLabels.has(call.server)
      );
      const unexpectedServers = [
        ...new Set(
          mcpCalls
            .filter((call) => !call.server || !serverLabels.has(call.server))
            .map((call) => call.server ?? '(unattributed)')
        ),
      ];
      let measurementError: string | undefined;
      if (executionTrusted && unexpectedServers.length)
        measurementError = `${label} called an MCP server outside the configured evaluation server selection.`;
      else if (
        executionTrusted &&
        config.requireMcpCalls &&
        !selectedCalls.length
      )
        measurementError = `${label} completed without calling a required evaluation MCP tool on the configured server selection.`;
      if (measurementError) trace.error = measurementError;
      const session = result.clientMetadata?.session;
      // How a failed turn ended, from the failure kind the turn typed
      // (ADR 0010): the metadata goes under telemetry, where no reader
      // looks. A completed turn that missed the servers is a trial.
      const ending =
        trace.ending ??
        (result.success
          ? undefined
          : endingOf({
              error: trace.error,
              clientMetadata: result.clientMetadata,
            }));
      const caseResult: ClientRunResult = {
        ...trace,
        ...(ending ? { ending } : {}),
        // The native turn's own times, when it was bound.
        ...(session?.startedAt ? { startedAt: session.startedAt } : {}),
        ...(session?.completedAt ? { completedAt: session.completedAt } : {}),
        durationMs: Date.now() - started,
        ...(result.success ? { llmDurationMs: result.llmDurationMs } : {}),
        telemetry: {
          caseExecution: {
            status: executionTrusted ? 'completed' : 'failed',
            continuation: executionTrusted ? 'allowed' : 'restart',
          },
          mcpSelection: {
            status: !executionTrusted
              ? 'not-evaluated'
              : measurementError
                ? 'failed'
                : 'passed',
            required: config.requireMcpCalls === true,
            selectedServers: [...serverLabels],
            configuredMcpCallCount: selectedCalls.length,
            externalMcpCallCount: mcpCalls.length,
            builtinToolCallCount: result.toolCalls.filter(
              (call) => call.source === 'builtin'
            ).length,
            unexpectedServers,
            ...(measurementError ? { error: measurementError } : {}),
          },
          clientMetadata: result.clientMetadata,
          computerUse: result.clientMetadata.computerUse,
          nativeController: result.clientMetadata.nativeController,
          // Failed bound turns keep their partial native history. It
          // quotes the prompt and the answer, so it is content, which
          // stored results drop unless they keep full traces.
          ...(result.conversationHistory
            ? { content: { conversationHistory: result.conversationHistory } }
            : {}),
          ...(result.success ? { mcpDurationMs: result.mcpDurationMs } : {}),
        },
      };
      return {
        result: caseResult,
        continuation: executionTrusted ? 'continue' : 'reset',
      };
    },
  };
}

/** What each product is and what a machine needs to run it (`mst clients`). */
const PRODUCT_DEFINITIONS: Record<
  DesktopProduct['client'],
  Pick<ClientDefinition, 'description' | 'requirements'>
> = {
  chatgpt: {
    description: 'The ChatGPT desktop app',
    requirements: {
      os: ['macos', 'linux'],
      install: [
        'macOS: the ChatGPT app, signed in, the Xcode Command Line Tools, and Accessibility and Screen Recording permission for the terminal that runs MST',
        "Linux: MST's ChatGPT image (`--runner docker`)",
      ],
      credentials: [
        'macOS: `ANTHROPIC_API_KEY` or an LLM gateway, for the Computer Use planner',
        'Linux image: `OPENAI_API_KEY`, or a gateway that serves the Responses API (`OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`)',
      ],
      setup: ['Docker: `mst runner setup docker --config <a ChatGPT eval>`'],
    },
  },
  'codex-app': {
    description: 'The Codex surface of the ChatGPT desktop app',
    requirements: {
      os: ['macos', 'linux'],
      install: [
        'macOS: the ChatGPT app, signed in with access to Codex, the Xcode Command Line Tools, and Accessibility and Screen Recording permission for the terminal that runs MST',
        "Linux: MST's ChatGPT image (`--runner docker`), which runs Codex in the ChatGPT app",
      ],
      credentials: [
        'macOS: `ANTHROPIC_API_KEY` or an LLM gateway, for the Computer Use planner',
        'Linux image: `OPENAI_API_KEY`, or a gateway that serves the Responses API (`OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`)',
      ],
      setup: ['Docker: `mst runner setup docker --config <a Codex app eval>`'],
    },
  },
};

/**
 * A client of the ChatGPT app. Without `platform`, how it runs follows from
 * the OS of the machine that runs the batch, read when the batch starts.
 */
function desktopClient(
  product: DesktopProduct,
  platform?: ChatgptDesktop
): ClientDefinition {
  // Resolve once when the batch opens, never while loading coordinator config.
  function desktopNow(): ChatgptDesktop {
    if (platform) return platform;
    const os = process.platform;
    if (os === 'darwin')
      return product.client === 'chatgpt' ? chatgptMacos : codexAppMacos;
    if (os === 'linux')
      return product.client === 'chatgpt' ? chatgptLinux : codexAppLinux;
    throw new Error(`The ChatGPT app runs on macOS or Linux, not ${os}.`);
  }
  const definition: ClientDefinition = {
    schema: SCHEMAS[product.client],
    ...PRODUCT_DEFINITIONS[product.client],
    evidence: 'structured',
    // Not verified against MST's local tool-variant proxy.
    toolSurfaceProxy: false,
    // One ChatGPT app window drives one conversation at a time.
    maxConcurrency: 1,
    async open(options, context) {
      return openDesktopSession(
        desktopAdapter([options], context, desktopNow())
      );
    },
    async run(input, config, context) {
      if (!input.prompt.trim())
        throw new Error(`${product.label} requires a non-empty input.`);
      return (
        await collectClientBatch(
          definition,
          [{ caseId: 'single', trial: 0, input, config }],
          context
        )
      )[0]!;
    },
  };
  return definition;
}

/** The built-in `chatgpt` and `codex-app`: the trial's machine picks the OS. */
export const CHATGPT_APP_CLIENTS = {
  chatgpt: desktopClient(CHATGPT_PRODUCT),
  'codex-app': desktopClient(CODEX_APP_PRODUCT),
} as const;

// Each product pinned to one OS, whatever this machine runs.
export const CHATGPT_LINUX_CLIENT = desktopClient(
  CHATGPT_PRODUCT,
  chatgptLinux
);
export const CHATGPT_CLIENT = desktopClient(CHATGPT_PRODUCT, chatgptMacos);
export const CODEX_APP_LINUX_CLIENT = desktopClient(
  CODEX_APP_PRODUCT,
  codexAppLinux
);
export const CODEX_APP_CLIENT = desktopClient(CODEX_APP_PRODUCT, codexAppMacos);
