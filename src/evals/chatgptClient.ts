import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { variantToolMetadata } from './evalConfig.js';
import type {
  ClientBatchRequest,
  ClientDefinition,
  ClientRunContext,
  ClientRunResult,
  TraceEvent,
} from './evalFrameworkTypes.js';
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
  requireIdenticalClientSettings,
  runDesktopBatch,
} from './desktopBatch.js';
import {
  CHATGPT_MAX_ACTIONS,
  chatgptMaxActionsSummary,
} from './chatgpt/maxActions.js';
import {
  CHATGPT_APP_REASONING_EFFORTS,
  reasoningEffortOption,
} from './reasoningEffort.js';
import {
  LINUX_CHATGPT_PLATFORM,
  MAC_CHATGPT_PLATFORM,
  chatgptPlatformFor,
  type ChatgptPlatform,
} from './chatgptSetup/platform.js';
import type { ChatgptSurface } from './chatgpt/driver.js';
import {
  COMPUTER_USE_PROVIDER_GONE,
  fixedProviderGone,
  maxActionsRenamed,
  osName,
} from './desktopOS.js';
import { removedClientOptions } from './renamedKeys.js';

/**
 * A product the ChatGPT desktop app runs, and so a client (ADR 0011):
 * ChatGPT's work surface (`chatgpt`) or Codex (`codex-app`). Both drive the
 * same app, so they share its desktop lease.
 */
interface DesktopProduct {
  /** The client's name. */
  readonly client: 'chatgpt' | 'codex-app';
  /** The surface the drivers select. */
  readonly surface: ChatgptSurface;
  /** The product in messages: `ChatGPT`, `Codex app`. */
  readonly label: string;
}

const CHATGPT_PRODUCT: DesktopProduct = {
  client: 'chatgpt',
  surface: 'chatgpt-work',
  label: 'ChatGPT',
};

const CODEX_APP_PRODUCT: DesktopProduct = {
  client: 'codex-app',
  surface: 'codex',
  label: 'Codex app',
};

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
      ),
      /** Gone: the client fixes its provider. */
      ...removedClientOptions({
        provider: fixedProviderGone(product.client, 'openai'),
      }),
      /** The trial's time limit in ms (default 300000). */
      timeout: z.number().int().positive().default(300_000),
      env: z.record(z.string(), z.string()).optional(),
      /** Client-owned: plugins installed into the fresh Linux profile. */
      plugins: MarketplacePluginsSchema.optional().refine(
        (plugins) => !plugins?.some((p) => p.blockMcpServers?.length),
        'ChatGPT does not support plugins[].blockMcpServers; use plugins[].mcp.'
      ),
      configPath: z.string().min(1).optional(),
      requireMcpCalls: z.boolean().optional(),
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
        ),
      /** Gone: the action budget is `maxActions`. */
      nativeMaxActions: z
        .never({ message: maxActionsRenamed('nativeMaxActions') })
        .optional(),
      computerUseModel: z
        .string()
        .regex(/^[A-Za-z0-9._:-]+$/)
        .optional(),
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
  const events: TraceEvent[] = turn.toolCalls.map((call) => {
    const server = servers.find(
      (server) => server.label && call.name.startsWith(`${server.label}.`)
    );
    const source =
      call.source ?? (server || servers.length === 1 ? 'mcp' : 'builtin');
    return {
      kind: call.kind ?? 'tool_call',
      source,
      name:
        server && call.source !== 'builtin'
          ? call.name.slice(server.label!.length + 1)
          : call.name,
      server:
        source === 'builtin'
          ? undefined
          : (call.server ??
            server?.label ??
            (servers.length === 1 ? servers[0]?.label : undefined)),
      arguments: call.arguments,
      output: call.output,
      ...(call.isError !== undefined ? { isError: call.isError } : {}),
      ...(call.rawName !== undefined ? { rawName: call.rawName } : {}),
      id: call.id,
      ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
      ...(call.startedAt ? { startedAt: call.startedAt } : {}),
      ...(call.completedAt ? { completedAt: call.completedAt } : {}),
      ...(call.results !== undefined ? { results: call.results } : {}),
    };
  });
  return {
    finalText: (turn.success ? turn.response : undefined) ?? '',
    error: turn.success ? undefined : turn.error,
    usage: turn.usage,
    ...(turn.modelCalls?.length ? { modelCalls: turn.modelCalls } : {}),
    events,
  };
}

async function runBatch(
  requests: ClientBatchRequest[],
  context: ClientRunContext,
  platform: ChatgptPlatform,
  product: DesktopProduct
): Promise<ClientRunResult[]> {
  if (!requests.length) return [];
  const { label } = product;
  if ((context.evalConfig.concurrency ?? 1) !== 1)
    throw new Error(`${label} desktop requires concurrency 1.`);
  if (variantToolMetadata(context.evalConfig, context.variant))
    throw new Error(
      `${label} desktop does not support tool metadata (\`tools\`).`
    );
  const schema = SCHEMAS[product.client];
  const configs = requests.map((request) => schema.parse(request.config));
  if (requests.some((request) => !request.input.prompt.trim()))
    throw new Error(`${label} requires a non-empty input.`);
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
  const appSession = new ChatgptAppSession('batch');
  return runDesktopBatch<ChatgptAppSession>(
    {
      name: label,
      lease: {
        directory: join(
          platform.lockHome(appConfigs[0]!),
          '.mcp-server-tester'
        ),
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
      async runCase(_session, request, index, ledger) {
        const config = configs[index]!;
        const serverConfig = prepared[index]!;
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
          appConfigs[index]!,
          appSession,
          { caseId: request.caseId }
        );
        const trace = turnRunResult(result, request.input.servers);
        if (trace.error)
          trace.error = redactClientSecrets(trace.error, secrets);
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
          continuation: executionTrusted ? 'allowed' : 'reset',
        };
      },
    },
    requests,
    context.reportResult,
    context.acquire
  );
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
        "Linux: MST's ChatGPT image (`--env docker`)",
      ],
      credentials: [
        'macOS: `ANTHROPIC_API_KEY` or an LLM gateway, for the Computer Use planner',
        'Linux image: `OPENAI_API_KEY`, or a gateway that serves the Responses API (`OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`)',
      ],
      setup: ['Docker: `mst env setup docker --config <a ChatGPT eval>`'],
    },
  },
  'codex-app': {
    description: 'The Codex surface of the ChatGPT desktop app',
    requirements: {
      os: ['macos', 'linux'],
      install: [
        'macOS: the ChatGPT app, signed in with access to Codex, the Xcode Command Line Tools, and Accessibility and Screen Recording permission for the terminal that runs MST',
        "Linux: MST's ChatGPT image (`--env docker`), which runs Codex in the ChatGPT app",
      ],
      credentials: [
        'macOS: `ANTHROPIC_API_KEY` or an LLM gateway, for the Computer Use planner',
        'Linux image: `OPENAI_API_KEY`, or a gateway that serves the Responses API (`OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`)',
      ],
      setup: ['Docker: `mst env setup docker --config <a Codex app eval>`'],
    },
  },
};

/**
 * A client of the ChatGPT app. Without `platform`, how it runs follows from
 * the OS of the machine that runs the batch, read when the batch starts.
 */
function desktopClient(
  product: DesktopProduct,
  platform?: ChatgptPlatform
): ClientDefinition {
  const platformNow = () => platform ?? chatgptPlatformFor(process.platform);
  return {
    schema: SCHEMAS[product.client],
    ...PRODUCT_DEFINITIONS[product.client],
    evidence: 'structured',
    // Not verified against MST's local tool-variant proxy.
    toolSurfaceProxy: false,
    // One ChatGPT app window drives one conversation at a time.
    maxConcurrency: 1,
    runBatch(requests, context) {
      return runBatch(requests, context, platformNow(), product);
    },
    async run(input, config, context) {
      return (
        await runBatch(
          [{ caseId: 'single', trial: 0, input, config }],
          context,
          platformNow(),
          product
        )
      )[0]!;
    },
  };
}

/** The built-in `chatgpt` and `codex-app`: the trial's machine picks the OS. */
export const CHATGPT_APP_CLIENTS = {
  chatgpt: desktopClient(CHATGPT_PRODUCT),
  'codex-app': desktopClient(CODEX_APP_PRODUCT),
} as const;

// Each product pinned to one OS, whatever this machine runs.
export const CHATGPT_LINUX_CLIENT = desktopClient(
  CHATGPT_PRODUCT,
  LINUX_CHATGPT_PLATFORM
);
export const CHATGPT_CLIENT = desktopClient(
  CHATGPT_PRODUCT,
  MAC_CHATGPT_PLATFORM
);
export const CODEX_APP_LINUX_CLIENT = desktopClient(
  CODEX_APP_PRODUCT,
  LINUX_CHATGPT_PLATFORM
);
export const CODEX_APP_CLIENT = desktopClient(
  CODEX_APP_PRODUCT,
  MAC_CHATGPT_PLATFORM
);
