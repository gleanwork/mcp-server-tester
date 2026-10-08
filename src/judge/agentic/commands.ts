/**
 * Workspace commands: plugin helpers an agentic judge can run, such as a
 * trace parser. A command is a trusted program the plugin ships; the agent
 * only chooses its arguments.
 *
 * Codex runs commands itself, through its sandboxed shell. The Claude
 * runtime has no shell, so it offers each command as a tool that runs the
 * program with the given arguments (no shell parsing), in the workspace, with
 * a minimal environment and a timeout. That process is not OS-sandboxed: a
 * command must itself only read what it is given, as a read-only parser does.
 */

import { execFile } from 'node:child_process';
import { z } from 'zod';
import { runtimeEnv, type WorkspaceCommand } from './runtime.js';

/** An in-process tool the agent can call. It runs in the judge's process. */
export interface AgentJudgeTool {
  name: string;
  description: string;
  /** Zod raw shape of the arguments. */
  input: Record<string, z.ZodType>;
  /** Returns text for the agent. Receives the workspace root. */
  run(args: Record<string, unknown>, workspace: string): Promise<string>;
}

/** Most output a command returns to the agent. */
const MAX_COMMAND_OUTPUT = 200_000;

/** How the agent is told to run a command from a shell. */
function commandUsage(command: WorkspaceCommand): string {
  return `${command.argv.join(' ')} <args>`;
}

/** A command as an in-process tool for runtimes without a shell. */
export function commandTool(command: WorkspaceCommand): AgentJudgeTool {
  return {
    name: command.name,
    description: `${command.description}\nRuns: ${commandUsage(command)}`,
    input: {
      args: z.array(z.string()).describe('Arguments after the command'),
    },
    run: (input, workspace) =>
      new Promise((resolvePromise, reject) => {
        const [program, ...lead] = command.argv;
        if (!program) {
          reject(new Error(`Command ${command.name} has no program`));
          return;
        }
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        execFile(
          program,
          [...lead, ...args],
          {
            cwd: workspace,
            env: runtimeEnv([]),
            timeout: command.timeoutMs ?? 60_000,
            maxBuffer: MAX_COMMAND_OUTPUT * 4,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`;
            const text =
              out.length > MAX_COMMAND_OUTPUT
                ? `${out.slice(0, MAX_COMMAND_OUTPUT)}\n…[output truncated; narrow the query]`
                : out;
            if (err && !stdout)
              reject(new Error(`${err.message}\n${text}`.trim()));
            else resolvePromise(text);
          }
        );
      }),
  };
}
