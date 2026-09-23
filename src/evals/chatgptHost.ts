import { mkdir, open, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type {
  HostBatchRequest,
  HostDefinition,
  HostRunContext,
  HostRunResult,
} from './evalFrameworkTypes.js';
import { runExternalHostScenario } from './externalHost/runtime.js';
import { ChatgptAppSession } from './chatgptSetup/macSession.js';
import { chatgptServers } from './chatgptSetup/config.js';
import type { ExternalHostConfig } from './externalHost/types.js';
import { simulationToHostTrace } from './hostTrace.js';
import { NATIVE_MAX_ACTIONS } from './chatgpt/linuxContract.js';

import { linuxChatgptHome } from './chatgpt/linux.js';

const DRIVER = 'openai.chatgpt.agent.desktop-app.macos';
const LINUX_DRIVER = 'openai.chatgpt.agent.desktop-app.linux';
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
    options: z
      .object({
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
      })
      .strict()
      .default({
        correlation: 'exact_prompt',
        surface: 'chatgpt-work',
      }),
  })
  .strict();

async function runBatch(
  requests: HostBatchRequest[],
  context: HostRunContext,
  driver = DRIVER
): Promise<HostRunResult[]> {
  if (!requests.length) return [];
  if ((context.manifest.concurrency ?? 1) !== 1)
    throw new Error('ChatGPT desktop requires concurrency 1.');
  if (context.arm?.toolOverrides || context.manifest.toolOverrides)
    throw new Error(
      'ChatGPT desktop does not support tool description overrides.'
    );
  const configs = requests.map((request) => Schema.parse(request.config));
  if (requests.some((request) => !request.input.scenario.trim()))
    throw new Error('ChatGPT requires non-empty scenarios.');
  if (
    configs.some(
      (config) => JSON.stringify(config) !== JSON.stringify(configs[0])
    )
  )
    throw new Error('ChatGPT batch requires identical host settings.');
  const prepared = requests.map((request, index) =>
    chatgptServers(request.input.servers, {
      ...process.env,
      ...context.env,
      ...request.input.env,
      ...configs[index]!.env,
    })
  );
  const externalConfigs: ExternalHostConfig[] = requests.map(
    (request, index) => {
      const config = configs[index]!;
      const serverConfig = prepared[index]!;
      return {
        driver,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        timeoutMs: config.timeout,
        correlation: {
          strategy: config.options.correlation,
          includeInPrompt: config.options.correlation === 'prompt_marker',
        },
        codexSetup: {
          configPath: config.options.configPath,
          servers: serverConfig.servers,
        },
        options: {
          environment: { ...config.env, ...serverConfig.environment },
          computerUseProvider:
            driver === LINUX_DRIVER
              ? config.options.computerUseProvider
              : (config.options.computerUseProvider ??
                'anthropic-computer-use'),
          computerUseModel: config.options.computerUseModel,
          computerUseMaxActions:
            driver === LINUX_DRIVER
              ? config.options.computerUseMaxActions
              : (config.options.computerUseMaxActions ?? 32),
          surface: config.options.surface,
          nativeMaxActions: config.options.nativeMaxActions,
          desktopEnvironment:
            driver === LINUX_DRIVER
              ? Object.fromEntries(
                  Object.entries({
                    ...context.env,
                    ...request.input.env,
                    ...config.env,
                  }).filter(([, value]) => value !== undefined)
                )
              : undefined,
          computerUseEnvironment: Object.fromEntries(
            Object.entries({
              ...context.env,
              ...request.input.env,
              ...config.env,
            }).filter(([, value]) => value !== undefined)
          ),
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
  // Claim before any lifecycle operation: another process must not stop the active app.
  const directory = join(
    driver === LINUX_DRIVER
      ? linuxChatgptHome({
          ...process.env,
          ...(externalConfigs[0]!.options
            ?.desktopEnvironment as NodeJS.ProcessEnv),
        })
      : homedir(),
    '.mcp-server-tester'
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'chatgpt-desktop.lock');
  const lease = await open(path, 'wx', 0o600).catch(() => {
    throw new Error(
      'ChatGPT desktop is locked by another run or an interrupted run. Use one worker; inspect stale locks before removing them.'
    );
  });
  const results: HostRunResult[] = [];
  const session = new ChatgptAppSession('batch');
  const usedSessions = new Set<string>();
  let batchBlocked = false;
  let executionError: unknown;
  let executionFailed = false;
  let cleanupError: Error | undefined;
  try {
    await lease.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
    );
    await session.prepare(externalConfigs[0]!);
    for (const [index, request] of requests.entries()) {
      if (batchBlocked) {
        results.push({
          finalText: '',
          events: [],
          error:
            'Not submitted because a previous ChatGPT execution or evidence failure blocked the batch. No automatic retries were attempted.',
          telemetry: {
            caseExecution: { status: 'not-submitted', continuation: 'blocked' },
          },
        });
        continue;
      }
      const config = configs[index]!;
      const serverConfig = prepared[index]!;
      const started = Date.now();
      const serverLabels = new Set(
        serverConfig.servers.map((server) => server.label)
      );
      // Eval prompts stay unchanged. Server selection is verified from native calls,
      // not enforced by adding evaluator instructions to the model's context.
      const result = await runExternalHostScenario(
        request.input.scenario,
        {
          ...externalConfigs[index]!,
          options: {
            ...externalConfigs[index]!.options,
            managedChatgptSession: session,
          },
        },
        { caseId: request.caseId }
      );
      const trace = simulationToHostTrace(result, request.input.servers);
      if (result.success) {
        const id = result.externalHost.session.id;
        if (!id || !result.externalHost.session.turnId || usedSessions.has(id))
          trace.error =
            'ChatGPT requires a distinct native session and turn for each fresh query; refusing duplicate attribution.';
        else usedSessions.add(id);
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
      // Native/controller/evidence failures block further submissions. A completed,
      // reliably attributed turn can fail the MCP measurement without blocking peers.
      const executionTrusted = result.success && !trace.error;
      batchBlocked = !executionTrusted;
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
        config.options.requireMcpCalls &&
        !selectedCalls.length
      )
        measurementError =
          'ChatGPT completed without calling a required evaluation MCP tool on the configured server selection.';
      if (measurementError) trace.error = measurementError;
      results.push({
        ...trace,
        durationMs: Date.now() - started,
        ...(result.success ? { llmDurationMs: result.llmDurationMs } : {}),
        telemetry: {
          caseExecution: {
            status: executionTrusted ? 'completed' : 'failed',
            continuation: executionTrusted ? 'allowed' : 'blocked',
          },
          mcpSelection: {
            status: !executionTrusted
              ? 'not-evaluated'
              : measurementError
                ? 'failed'
                : 'passed',
            required: config.options.requireMcpCalls === true,
            selectedServers: [...serverLabels],
            configuredMcpCallCount: selectedCalls.length,
            externalMcpCallCount: mcpCalls.length,
            hostToolCallCount: result.toolCalls.filter(
              (call) => call.source === 'host'
            ).length,
            unexpectedServers,
            ...(measurementError ? { error: measurementError } : {}),
          },
          externalHost: result.externalHost,
          computerUse: result.externalHost.computerUse,
          nativeController: result.externalHost.nativeController,
          ...(result.success
            ? {
                conversationHistory: result.conversationHistory,
                mcpDurationMs: result.mcpDurationMs,
              }
            : {}),
        },
      });
    }
  } catch (error) {
    executionFailed = true;
    executionError = error;
  } finally {
    let cleanupFailed = false;
    try {
      await session.dispose();
    } catch (error) {
      cleanupFailed = true;
      const message = `ChatGPT batch cleanup failed; desktop lock retained for inspection: ${error instanceof Error ? error.message : String(error)}`;
      for (const result of results) {
        result.error = [result.error, message].filter(Boolean).join(' ');
        result.telemetry = {
          ...result.telemetry,
          batchFailure: { kind: 'cleanup_failed', error: message },
        };
      }
      cleanupError = new Error(message);
    } finally {
      for (const [index, result] of results.entries()) {
        result.telemetry = {
          ...result.telemetry,
          batchLifecycle: session.telemetry,
          batchCase: {
            index,
            caseId: requests[index]!.caseId,
            count: requests.length,
          },
        };
      }
      await lease.close();
      if (!cleanupFailed) await unlink(path);
    }
  }
  if (executionFailed) {
    if (cleanupError)
      throw new AggregateError(
        [executionError, cleanupError],
        'ChatGPT execution and batch cleanup failed.'
      );
    throw executionError instanceof Error
      ? executionError
      : new Error(
          typeof executionError === 'string'
            ? executionError
            : 'ChatGPT batch execution failed.'
        );
  }
  if (cleanupError && !results.length) throw cleanupError;
  return results;
}

export const CHATGPT_LINUX_HOST: HostDefinition = {
  name: LINUX_DRIVER,
  schema: Schema,
  evidence: 'structured',
  runBatch(requests, context) {
    return runBatch(requests, context, LINUX_DRIVER);
  },
  async run(input, config, context) {
    return (
      await runBatch(
        [{ caseId: 'single', iteration: 0, input, config }],
        context,
        LINUX_DRIVER
      )
    )[0]!;
  },
};

export const CHATGPT_HOST: HostDefinition = {
  name: DRIVER,
  schema: Schema,
  evidence: 'structured',
  runBatch,
  async run(input, config, context) {
    return (
      await runBatch(
        [{ caseId: 'single', iteration: 0, input, config }],
        context
      )
    )[0]!;
  },
};
