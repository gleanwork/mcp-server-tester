import { spawn } from 'node:child_process';
import type {
  CLIConfig,
  LLMToolCall,
  MCPHostSimulationResult,
} from '../../mcpHostTypes.js';
import { parseStreamJson, createJsonParser } from './parsers.js';

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
  scenario: string
): Promise<MCPHostSimulationResult> {
  const timeout = cliConfig.timeout ?? DEFAULT_TIMEOUT;
  const args = interpolateArgs(cliConfig.args, scenario);

  const startTime = Date.now();

  let stdout: string;
  try {
    const result = await spawnProcess(cliConfig.command, args, { timeout });
    stdout = result.stdout;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

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
        `Failed to parse CLI host output: ${err instanceof Error ? err.message : String(err)}` +
        `\nstdout (first 500 chars): ${stdout.slice(0, 500)}`,
    };
  }

  const validationError = validateSimulationResult(result);
  if (validationError) {
    return {
      success: false,
      toolCalls: [],
      error: `CLI host returned invalid result: ${validationError}`,
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
  options: { timeout: number }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER) {
        stderrChunks.push(chunk);
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Process timed out after ${options.timeout}ms`));
    }, options.timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');

      if (code !== 0) {
        reject(
          new Error(
            `Command failed with exit code ${code ?? 'null'}` +
              (stderr ? `\nstderr: ${stderr}` : '')
          )
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}
