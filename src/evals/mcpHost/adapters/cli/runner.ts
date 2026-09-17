import { spawn } from 'node:child_process';
import type {
  CLIConfig,
  LLMToolCall,
  MCPHostSimulationResult,
} from '../../mcpHostTypes.js';
import { parseStreamJson, createJsonParser } from './parsers.js';
import { ClaudeStartup } from './claudeStartup.js';

class ProcessFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB

/**
 * Returns a parser function for the given output format.
 */
export function getParser(
  format: CLIConfig['outputFormat']
): (stdout: string) => MCPHostSimulationResult {
  switch (format ?? 'stream-json') {
    case 'stream-json':
      return parseStreamJson;
    case 'json':
      return createJsonParser({
        toolCalls: 'toolCalls',
        response: 'response',
        success: 'success',
      });
  }
}

/**
 * Interpolates `{{scenario}}` in each arg string.
 */
export function interpolateArgs(args: string[], scenario: string): string[] {
  return args.map((arg) => arg.replace(/\{\{scenario\}\}/g, scenario));
}

/**
 * Runs a CLI host: interpolates `{{scenario}}` in args, spawns the process
 * directly (no shell), and parses stdout according to `outputFormat`.
 *
 * Because the process is spawned without a shell, special characters in
 * the scenario (quotes, newlines, `$`, backticks, etc.) are passed through
 * safely as literal argument values.
 */
export async function runCLIHost(
  cliConfig: CLIConfig,
  scenario: string,
  signal?: AbortSignal
): Promise<MCPHostSimulationResult> {
  const timeout = cliConfig.timeout ?? DEFAULT_TIMEOUT;
  const args = interpolateArgs(cliConfig.args, scenario);

  const startTime = Date.now();
  const isClaude = cliConfig.claudeMcpServers !== undefined;
  if (isClaude && cliConfig.outputFormat === 'json') {
    return {
      success: false,
      toolCalls: [],
      error: 'Claude MCP startup validation requires stream-json output.',
      diagnostics: { failureKind: 'output' },
    };
  }
  const startup = cliConfig.claudeMcpServers?.length
    ? new ClaudeStartup(cliConfig.claudeMcpServers)
    : undefined;

  let stdout: string;
  try {
    const result = await spawnProcess(cliConfig.command, args, {
      timeout,
      env: isClaude
        ? {
            ...cliConfig.env,
            MCP_CONNECTION_NONBLOCKING: 'false',
            MCP_CONNECT_TIMEOUT_MS:
              cliConfig.env?.MCP_CONNECT_TIMEOUT_MS ??
              process.env.MCP_CONNECT_TIMEOUT_MS ??
              '30000',
          }
        : cliConfig.env,
      signal,
      isClaude,
      onStdout: startup ? (chunk) => startup.push(chunk) : undefined,
    });
    stdout = result.stdout;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    if (isClaude) {
      let partial: MCPHostSimulationResult = { success: false, toolCalls: [] };
      if (err instanceof ProcessFailure) {
        try {
          partial = getParser(cliConfig.outputFormat)(err.stdout);
        } catch {
          /* Keep the process failure, never echo raw output. */
        }
      }
      return {
        ...partial,
        success: false,
        error:
          message.includes('timed out') || message.includes('TIMEOUT')
            ? `CLI host timed out after ${elapsed}ms (limit: ${timeout}ms).`
            : `CLI host process failed: ${message}`,
        diagnostics: {
          ...startup?.diagnostics,
          failureKind:
            message.includes('timed out') || message.includes('TIMEOUT')
              ? 'timeout'
              : message.includes('MCP connection failed')
                ? 'startup'
                : message.includes('capture limit')
                  ? 'output'
                  : 'process',
        },
      };
    }

    if (message.includes('TIMEOUT') || message.includes('timed out')) {
      return {
        success: false,
        toolCalls: [],
        error:
          `CLI host timed out after ${elapsed}ms (limit: ${timeout}ms). ` +
          `Increase timeout via mcpHostConfig.cli.timeout.`,
      };
    }

    return {
      success: false,
      toolCalls: [],
      error: `CLI host process failed: ${message}`,
    };
  }

  const parse = getParser(cliConfig.outputFormat);

  let result: MCPHostSimulationResult;
  try {
    result = parse(stdout);
  } catch (err) {
    return {
      success: false,
      toolCalls: [],
      error:
        (isClaude
          ? 'Failed to parse Claude CLI output.'
          : `Failed to parse CLI host output: ${err instanceof Error ? err.message : String(err)}`) +
        (isClaude ? '' : `\nstdout (first 500 chars): ${stdout.slice(0, 500)}`),
      ...(isClaude
        ? {
            diagnostics: {
              ...startup?.diagnostics,
              failureKind: 'output' as const,
            },
          }
        : {}),
    };
  }

  const validationError = validateSimulationResult(result);
  if (validationError) {
    return {
      success: false,
      toolCalls: [],
      error: `CLI host returned invalid result: ${validationError}`,
      ...(isClaude
        ? {
            diagnostics: {
              ...startup?.diagnostics,
              failureKind: 'output' as const,
            },
          }
        : {}),
    };
  }

  if (isClaude && !result.success)
    result.diagnostics = { failureKind: 'process' };
  if (startup) {
    result.diagnostics = { ...result.diagnostics, ...startup.diagnostics };
    if (startup.error)
      return {
        ...result,
        success: false,
        error: startup.error,
        diagnostics: { ...startup.diagnostics, failureKind: 'startup' },
      };
  }
  return result;
}

export function validateSimulationResult(result: unknown): string | null {
  if (result === null || typeof result !== 'object') {
    return `Expected object, got ${typeof result}`;
  }

  const obj = result as Record<string, unknown>;

  if (typeof obj.success !== 'boolean') {
    return `"success" must be a boolean, got ${typeof obj.success}`;
  }

  if (!Array.isArray(obj.toolCalls)) {
    return `"toolCalls" must be an array, got ${typeof obj.toolCalls}`;
  }

  for (let i = 0; i < obj.toolCalls.length; i++) {
    const tc = obj.toolCalls[i] as LLMToolCall;
    if (typeof tc.name !== 'string') {
      return `toolCalls[${i}].name must be a string, got ${typeof tc.name}`;
    }
    if (typeof tc.arguments !== 'object' || tc.arguments === null) {
      return `toolCalls[${i}].arguments must be an object, got ${typeof tc.arguments}`;
    }
  }

  return null;
}

/**
 * Spawns a process directly (no shell) and closes stdin immediately.
 *
 * Using spawn without a shell means args are passed as-is to the process,
 * avoiding shell injection. Closing stdin prevents CLI hosts like Claude
 * Code from waiting for input.
 */
function spawnProcess(
  command: string,
  args: string[],
  options: {
    timeout: number;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    isClaude?: boolean;
    onStdout?: (chunk: Buffer) => string | undefined;
  }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    const ownedGroup = options.isClaude && process.platform !== 'win32';
    const child = spawn(command, args, {
      detached: ownedGroup,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
    });

    // Close stdin immediately so the CLI doesn't wait for input
    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER) {
        stdoutChunks.push(chunk);
      } else if (options.isClaude) {
        fail(new Error('Claude output exceeded its capture limit.'));
        return;
      }
      const error = options.onStdout?.(chunk);
      if (error) fail(new Error(error));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER) {
        stderrChunks.push(chunk);
      } else if (options.isClaude)
        fail(new Error('Claude output exceeded its capture limit.'));
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromHost);
    }
    let stopped = false;
    function stop() {
      if (stopped) return;
      stopped = true;
      if (ownedGroup && child.pid) {
        // This group was created exclusively for this invocation, not inherited
        // from the runner. Include owned MCP servers and Claude subprocesses.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            child.kill('SIGKILL');
        }
      } else child.kill('SIGKILL');
    }
    function fail(error: Error) {
      stop();
      cleanup();
      reject(
        options.isClaude
          ? new ProcessFailure(
              error.message,
              Buffer.concat(stdoutChunks).toString('utf-8')
            )
          : error
      );
    }
    function abortFromHost() {
      const reason: unknown = options.signal?.reason;
      fail(
        reason instanceof Error
          ? reason
          : new Error(typeof reason === 'string' ? reason : 'CLI host aborted.')
      );
    }
    if (options.signal) {
      options.signal.addEventListener('abort', abortFromHost, { once: true });
    } else {
      // Preserve standalone CLI timeout behavior when there is no owner signal.
      timer = setTimeout(() => {
        if (options.isClaude)
          fail(new Error(`Process timed out after ${options.timeout}ms`));
        else {
          child.kill('SIGTERM');
          reject(new Error(`Process timed out after ${options.timeout}ms`));
        }
      }, options.timeout);
    }

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    if (ownedGroup) child.once('exit', stop);
    child.on('close', (code) => {
      cleanup();
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (code !== 0) {
        const message = `Command failed with exit code ${code ?? 'null'}`;
        reject(
          options.isClaude
            ? new ProcessFailure(message, stdout)
            : new Error(message + (stderr ? `\nstderr: ${stderr}` : ''))
        );

        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
