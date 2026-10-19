/**
 * The Codex SDK agent judge runtime. Opt in with `runtime: "codex"`.
 *
 * Codex runs in its OS sandbox in `read-only` mode: the agent can run shell
 * commands (so plugin scripts in the workspace run as they are), but it
 * cannot write files or reach the network. It is NOT confined to the
 * workspace: read-only means its shell can read any file the user running
 * MST can, by absolute path. Use it only where that is acceptable; the
 * Claude Agent runtime, the default, confines reads to the workspace.
 *
 * In a worker container, Codex's sandbox can't start: bubblewrap needs user
 * namespaces, which Docker's seccomp and AppArmor profiles (and hosts that
 * restrict unprivileged user namespaces, such as Ubuntu 24.04) deny. Every
 * shell command then fails, and the judge decides without its evidence; the
 * judge's preflight (`probeCodexSandbox`) fails first instead. An
 * image whose container is a disposable sandbox sets MST_JUDGE_SANDBOX=container:
 * Codex runs without its own sandbox, confined by the container, which can
 * write only its own files and reach what its network allows.
 *
 * It starts with a fresh, empty CODEX_HOME, which is also its HOME, so the
 * caller's config, login, rules, session history and dotfiles aren't loaded,
 * and it gets only the environment variables listed in `env`. Its endpoint
 * and credential come from `resolveLLMEndpoint('openai')`.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadJudgeSdk } from '../adapterSupport.js';
import { resolveLLMEndpoint } from '../../llm/endpoint.js';
import {
  runtimeEnv,
  type AgentJudgeResult,
  type AgentJudgeRuntime,
  type AgentJudgeStep,
  type AgentJudgeTask,
} from './runtime.js';

/** The part of `@openai/codex-sdk` the runtime uses. */
interface CodexSdk {
  Codex: new (options: Record<string, unknown>) => {
    startThread(options: Record<string, unknown>): {
      run(
        input: string,
        options: Record<string, unknown>
      ): Promise<{
        items: Array<Record<string, unknown> & { type: string }>;
        finalResponse: string;
        usage: {
          input_tokens: number;
          cached_input_tokens?: number;
          output_tokens: number;
          reasoning_output_tokens?: number;
        } | null;
      }>;
    };
  };
}

export interface CodexRuntimeOptions {
  /** Path to the codex binary. Defaults to the SDK's bundled one. */
  codexPath?: string;
  /** Extra environment variable names to pass through, such as proxy settings. */
  env?: readonly string[];
}

const DEFAULT_CODEX_JUDGE_MODEL = 'gpt-5.5';

/**
 * Codex's sandbox mode from MST_JUDGE_SANDBOX: `os` (the default), its own
 * read-only OS sandbox; `container`, none, because the machine is a
 * disposable container that is the sandbox (see above).
 */
export function codexSandboxMode(
  env: NodeJS.ProcessEnv = process.env
): 'read-only' | 'danger-full-access' {
  const value = env.MST_JUDGE_SANDBOX?.trim() || 'os';
  if (value === 'os') return 'read-only';
  if (value === 'container') return 'danger-full-access';
  throw new Error(
    `MST_JUDGE_SANDBOX must be "os" or "container", not "${value}".`
  );
}

function stepOf(
  item: Record<string, unknown> & { type: string }
): AgentJudgeStep | undefined {
  switch (item.type) {
    case 'command_execution':
      return {
        tool: 'shell',
        isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
      };
    case 'mcp_tool_call':
      return {
        tool: `${String(item.server)}.${String(item.tool)}`,
        isError: item.status === 'failed',
      };
    case 'web_search':
      return { tool: 'web_search' };
    case 'file_change':
      return { tool: 'file_change', isError: true };
    default:
      return undefined;
  }
}

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_FILE = 'mst-sandbox-probe.txt';

/**
 * The `@openai/codex` CLI launcher the SDK runs, from where `@openai/codex-sdk`
 * resolves for MST: the SDK's own dependency, so the probe runs the same
 * binary as the judge.
 */
export function codexLauncherPath(): string {
  const here = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  );
  // The SDK's package exports only its entry, so find its directory.
  const sdkDir = (here.resolve.paths('@openai/codex-sdk') ?? [])
    .map((dir) => join(dir, '@openai', 'codex-sdk'))
    .find((dir) => existsSync(join(dir, 'package.json')));
  if (!sdkDir)
    throw new Error(
      'Codex judge requires the `@openai/codex-sdk` package. Install it with: npm install @openai/codex-sdk'
    );
  return createRequire(join(sdkDir, 'package.json')).resolve(
    '@openai/codex/bin/codex.js'
  );
}

/**
 * Fails unless Codex's read-only sandbox can run a command that reads a file:
 * `codex sandbox` on a file written to a temporary directory, with no model
 * call. Whatever stops the sandbox (no user namespaces, a seccomp or AppArmor
 * profile, a missing helper), the judge's commands would all fail and its
 * verdicts would be guesses, so this fails the judge's preflight, with the
 * sandbox's own error. Nothing to check with MST_JUDGE_SANDBOX=container.
 */
export async function probeCodexSandbox(
  options: { launcher?: string; env?: readonly string[] } = {}
): Promise<void> {
  if (codexSandboxMode() !== 'read-only') return;
  const launcher = options.launcher ?? codexLauncherPath();
  const dir = await mkdtemp(join(tmpdir(), 'mst-codex-probe-'));
  try {
    const home = join(dir, 'home');
    const work = join(dir, 'work');
    await mkdir(home);
    await mkdir(work);
    const sentinel = `mst-sandbox-probe ${Date.now()}`;
    await writeFile(join(work, PROBE_FILE), sentinel);
    let stdout = '';
    let failure: string | undefined;
    try {
      ({ stdout } = await promisify(execFile)(
        process.execPath,
        [launcher, 'sandbox', '--', 'cat', PROBE_FILE],
        {
          cwd: work,
          env: runtimeEnv(options.env ?? [], { CODEX_HOME: home, HOME: home }),
          timeout: PROBE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        }
      ));
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      failure = (e.stderr || e.message || String(err)).trim();
    }
    if (failure === undefined && stdout.trim() === sentinel) return;
    throw new Error(
      `Codex judge's read-only sandbox can't run commands here, so it couldn't read its evidence: ` +
        `${lastLines(failure ?? `the sandboxed command printed ${JSON.stringify(stdout.slice(0, 200))}`)}. ` +
        `In a container that is itself the sandbox, set MST_JUDGE_SANDBOX=container.`
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The last lines of a probe's error output, which say why it failed. */
function lastLines(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim());
  const reasons = lines.filter((l) => !l.startsWith('WARNING:'));
  return (reasons.length ? reasons : lines)
    .slice(-3)
    .join(' ')
    .slice(0, 600)
    .replace(/[.\s]+$/, '');
}

/** A Codex SDK runtime. */
export function codexRuntime(
  options: CodexRuntimeOptions = {}
): AgentJudgeRuntime {
  return {
    id: 'codex',
    async run(task: AgentJudgeTask): Promise<AgentJudgeResult> {
      // As every OpenAI-shaped call in MST: OPENAI_API_KEY, or a gateway.
      const endpoint = await resolveLLMEndpoint('openai');
      if (!endpoint.apiKey)
        throw new Error(
          'Codex judge runtime requires an API key. Set OPENAI_API_KEY, or OPENAI_BASE_URL and MST_LLM_AUTH_COMMAND for a gateway.'
        );
      const { Codex } = await loadJudgeSdk<CodexSdk>(
        () => import('@openai/codex-sdk'),
        'Codex',
        '@openai/codex-sdk'
      );
      const home = await mkdtemp(join(tmpdir(), 'mst-codex-home-'));
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), task.timeoutMs);
      try {
        const codex = new Codex({
          apiKey: endpoint.apiKey,
          ...(endpoint.overridden && { baseUrl: endpoint.baseURL }),
          ...(options.codexPath !== undefined && {
            codexPathOverride: options.codexPath,
          }),
          env: runtimeEnv(options.env ?? [], { CODEX_HOME: home, HOME: home }),
          // Fresh CODEX_HOME already has no config, rules or history; these
          // also turn off what a future default might add.
          config: {
            history: { persistence: 'none' },
            shell_environment_policy: { inherit: 'core' },
          },
        });
        const thread = codex.startThread({
          model: task.model ?? DEFAULT_CODEX_JUDGE_MODEL,
          sandboxMode: codexSandboxMode(),
          workingDirectory: task.workspace,
          skipGitRepoCheck: true,
          approvalPolicy: 'never',
          networkAccessEnabled: false,
          webSearchMode: 'disabled',
          ...(task.effort !== undefined && {
            modelReasoningEffort: task.effort,
          }),
        });
        const input = task.system
          ? `${task.system}\n\n${task.prompt}`
          : task.prompt;
        const turn = await thread.run(input, {
          signal: controller.signal,
          ...(task.outputSchema !== undefined && {
            outputSchema: task.outputSchema,
          }),
        });
        const steps = turn.items
          .map(stepOf)
          .filter((s): s is AgentJudgeStep => s !== undefined);
        let json: unknown;
        if (task.outputSchema !== undefined) {
          try {
            json = JSON.parse(turn.finalResponse);
          } catch {
            json = undefined;
          }
        }
        return {
          text: turn.finalResponse,
          ...(json !== undefined && { json }),
          usage: {
            inputTokens: turn.usage?.input_tokens ?? 0,
            outputTokens: turn.usage?.output_tokens ?? 0,
            ...(turn.usage?.cached_input_tokens !== undefined && {
              cacheReadInputTokens: turn.usage.cached_input_tokens,
            }),
            ...(turn.usage?.reasoning_output_tokens !== undefined && {
              reasoningOutputTokens: turn.usage.reasoning_output_tokens,
            }),
            durationMs: Date.now() - started,
          },
          turns: turn.items.filter((i) => i.type === 'agent_message').length,
          steps,
          runtime: 'codex',
          model: task.model ?? DEFAULT_CODEX_JUDGE_MODEL,
        };
      } catch (err) {
        if (controller.signal.aborted)
          throw new Error(`Codex judge timed out after ${task.timeoutMs} ms`);
        throw err;
      } finally {
        clearTimeout(timer);
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}
