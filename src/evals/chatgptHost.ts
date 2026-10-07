import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { variantToolMetadata } from './evalConfig.js';
import type {
  ClientBatchRequest,
  ClientDefinition,
  ClientRunContext,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import { runExternalHostScenario } from './externalHost/runtime.js';
import { ChatgptAppSession } from './chatgptSetup/session.js';
import { chatgptServers } from './chatgptSetup/config.js';
import {
  MarketplacePluginsSchema,
  hostPluginMcpServers,
  resolveHostPluginCredentials,
} from './hostPlugins.js';
import type { ExternalHostConfig } from './externalHost/types.js';
import { simulationToHostRun } from './hostTrace.js';
import { hostSecretValues, redactHostSecrets } from './hostSecrets.js';
import {
  requireIdenticalHostSettings,
  runDesktopBatch,
} from './desktopBatch.js';
import { NATIVE_MAX_ACTIONS } from './chatgpt/linuxContract.js';
import {
  LINUX_CHATGPT_PLATFORM,
  MAC_CHATGPT_PLATFORM,
  type ChatgptPlatform,
} from './chatgptSetup/platform.js';

const Schema = z
  .object({
    type: z.string(),
    model: z.string().min(1),
    reasoningEffort: z
      .enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .optional(),
    provider: z.literal('openai').optional(),
    timeout: z.number().int().positive().default(300_000),
    env: z.record(z.string(), z.string()).optional(),
    /** Host-owned: plugins installed into the fresh Linux profile. */
    plugins: MarketplacePluginsSchema.optional().refine(
      (plugins) => !plugins?.some((p) => p.blockMcpServers?.length),
      'ChatGPT does not support plugins[].blockMcpServers; use plugins[].mcp.'
    ),
    configPath: z.string().min(1).optional(),
    requireMcpCalls: z.boolean().optional(),
    surface: z.enum(['chatgpt-work', 'codex']).default('chatgpt-work'),
    correlation: z
      .enum(['exact_prompt', 'prompt_marker'])
      .default('exact_prompt'),
    computerUseProvider: z.literal('anthropic-computer-use').optional(),
    nativeMaxActions: z
      .number()
      .int()
      .min(1)
      .max(NATIVE_MAX_ACTIONS.max)
      .optional(),
    computerUseModel: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    computerUseMaxActions: z.number().int().min(1).max(64).optional(),
    options: z
      .never({
        message:
          '`clientOptions.options` is gone: set its keys in `clientOptions` directly (`clientOptions.surface`, not `clientOptions.options.surface`).',
      })
      .optional(),
  })
  .strict();

async function runBatch(
  requests: ClientBatchRequest[],
  context: ClientRunContext,
  platform: ChatgptPlatform
): Promise<ClientRunResult[]> {
  if (!requests.length) return [];
  if ((context.evalConfig.concurrency ?? 1) !== 1)
    throw new Error('ChatGPT desktop requires concurrency 1.');
  if (variantToolMetadata(context.evalConfig, context.variant))
    throw new Error(
      'ChatGPT desktop does not support tool metadata (`tools`).'
    );
  const configs = requests.map((request) => Schema.parse(request.config));
  if (requests.some((request) => !request.input.prompt.trim()))
    throw new Error('ChatGPT requires non-empty scenarios.');
  requireIdenticalHostSettings('ChatGPT', configs);
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
    resolveHostPluginCredentials(config.plugins ?? [], credentialEnv[index]!)
  );
  // Every error this batch surfaces is redacted against these values.
  const secrets = [
    ...new Set(
      requests.flatMap((request, index) =>
        hostSecretValues(credentialEnv[index]!, request.input.servers, [
          ...Object.values(prepared[index]!.environment),
          ...Object.values(pluginCredentials[index]!),
        ])
      )
    ),
  ];
  const externalConfigs: ExternalHostConfig[] = requests.map(
    (request, index) => {
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
        driver: platform.driver,
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
          surface: config.surface,
          nativeMaxActions: config.nativeMaxActions,
          ...platform.hostOptions(config, environment),
          computerUseEnvironment: environment,
        },
      };
    }
  );
  if (
    externalConfigs.some(
      (config) => !isDeepStrictEqual(config, externalConfigs[0])
    )
  )
    throw new Error(
      'ChatGPT batch requires identical MCP servers, credentials, and environment.'
    );
  // One desktop per run: claimed before any lifecycle operation, because
  // another process must not stop the active app.
  const appSession = new ChatgptAppSession('batch');
  return runDesktopBatch<ChatgptAppSession>(
    {
      name: 'ChatGPT',
      lease: {
        directory: join(
          platform.lockHome(externalConfigs[0]!),
          '.mcp-server-tester'
        ),
        file: 'chatgpt-desktop.lock',
      },
      secrets,
      resetVerb: 'restarted',
      async prepare() {
        await appSession.prepare(externalConfigs[0]!);
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
          ...hostPluginMcpServers(config.plugins ?? []).map(
            (target) => target.server
          ),
        ]);
        // Eval prompts stay unchanged. Server selection is verified from native calls,
        // not enforced by adding evaluator instructions to the model's context.
        const result = await runExternalHostScenario(
          request.input.prompt,
          {
            ...externalConfigs[index]!,
            options: {
              ...externalConfigs[index]!.options,
              managedChatgptSession: appSession,
            },
          },
          { caseId: request.caseId }
        );
        const trace = simulationToHostRun(result, request.input.servers);
        if (trace.error) trace.error = redactHostSecrets(trace.error, secrets);
        if (result.success) {
          const id = result.clientMetadata.session.id;
          if (!id || !result.clientMetadata.session.turnId || !ledger.claim(id))
            trace.error =
              'ChatGPT requires a distinct native session and turn for each fresh query; refusing duplicate attribution.';
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
          (call) => call.source !== 'host'
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
          measurementError =
            'ChatGPT called an MCP server outside the configured evaluation server selection.';
        else if (
          executionTrusted &&
          config.requireMcpCalls &&
          !selectedCalls.length
        )
          measurementError =
            'ChatGPT completed without calling a required evaluation MCP tool on the configured server selection.';
        if (measurementError) trace.error = measurementError;
        const caseResult: ClientRunResult = {
          ...trace,
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
              hostToolCallCount: result.toolCalls.filter(
                (call) => call.source === 'host'
              ).length,
              unexpectedServers,
              ...(measurementError ? { error: measurementError } : {}),
            },
            clientMetadata: result.clientMetadata,
            computerUse: result.clientMetadata.computerUse,
            nativeController: result.clientMetadata.nativeController,
            // Failed bound turns keep their partial native history.
            ...(result.conversationHistory
              ? { conversationHistory: result.conversationHistory }
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
    requests
  );
}

function chatgptHost(platform: ChatgptPlatform): ClientDefinition {
  return {
    schema: Schema,
    evidence: 'structured',
    // Not verified against MST's local tool-variant proxy.
    toolSurfaceProxy: false,
    // One ChatGPT app window drives one conversation at a time.
    maxConcurrency: 1,
    runBatch(requests, context) {
      return runBatch(requests, context, platform);
    },
    async run(input, config, context) {
      return (
        await runBatch(
          [{ caseId: 'single', trial: 0, input, config }],
          context,
          platform
        )
      )[0]!;
    },
  };
}

export const CHATGPT_LINUX_HOST = chatgptHost(LINUX_CHATGPT_PLATFORM);
export const CHATGPT_HOST = chatgptHost(MAC_CHATGPT_PLATFORM);
