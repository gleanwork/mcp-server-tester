import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  installPlugins,
  resetPluginsForTests,
} from '../../plugins/extensions.js';
import type { EvalCaseResult } from '../../types/reporter.js';
import { comparePairwise } from '../../evals/pairwiseComparison.js';
import type { JudgeInput } from '../judgeContract.js';
import { agenticJudge, agenticPairwiseJudge } from './agenticJudge.js';
import type {
  AgentJudgeRuntime,
  AgentJudgeStep,
  AgentJudgeTask,
} from './runtime.js';

// The built-in runtimes, replaced per test: judges choose them only by name.
const runtimes = vi.hoisted(
  () => ({}) as Record<string, (() => AgentJudgeRuntime) | undefined>
);
vi.mock('./codexRuntime.js', () => ({
  codexRuntime: () => runtimes.codex!(),
}));
vi.mock('./claudeRuntime.js', () => ({
  claudeRuntime: () => runtimes['claude-agent']!(),
}));

const input: JudgeInput = {
  case: {
    id: 'c1',
    input: { prompt: 'What is the launch date?' },
    expected: { answer: 'March 3' },
    tags: [],
    metadata: {},
  },
  trial: {
    response: {},
    text: 'It launches March 3.',
    events: [
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'search',
        arguments: { q: 'launch' },
        output: 'x'.repeat(50_000),
      },
    ],
  },
};

/** A runtime that records what it saw in the workspace, then answers. */
function fakeRuntime(
  answer: (task: AgentJudgeTask, files: Record<string, string>) => unknown,
  seen: { task?: AgentJudgeTask; files?: Record<string, string> } = {}
): () => AgentJudgeRuntime {
  return () => ({
    id: 'fake',
    async run(task) {
      const files: Record<string, string> = {};
      const walk = async (dir: string, prefix = ''): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
          else files[rel] = await readFile(join(dir, entry.name), 'utf-8');
        }
      };
      await walk(task.workspace);
      seen.task = task;
      seen.files = files;
      const json = answer(task, files);
      return {
        text: JSON.stringify(json),
        json,
        usage: { inputTokens: 10, outputTokens: 5, durationMs: 1 },
        turns: 3,
        steps: [{ tool: 'Read' }],
        runtime: 'fake',
        model: task.model ?? 'fake-model',
      };
    },
  });
}

afterEach(() => {
  for (const key of Object.keys(runtimes)) delete runtimes[key];
  vi.unstubAllEnvs();
  resetPluginsForTests();
});

describe('agenticJudge', () => {
  it('runs on the Claude Agent runtime unless options choose Codex', async () => {
    const ran: string[] = [];
    runtimes['claude-agent'] = fakeRuntime(() => (ran.push('claude'), {}));
    runtimes.codex = fakeRuntime(() => (ran.push('codex'), {}));
    const judge = agenticJudge({
      buildPrompt: () => ({ prompt: 'p' }),
      parseScore: () => ({ score: 1 }),
    });
    await judge.evaluate(input, {});
    await judge.evaluate(input, { runtime: 'codex' });
    expect(ran).toEqual(['claude', 'codex']);
  });

  it("keeps each step's tool, never its input or output, in the score's metadata", async () => {
    runtimes['claude-agent'] = () => ({
      id: 'fake',
      async run() {
        return {
          text: '{}',
          json: {},
          usage: {},
          // A runtime that reports more is cut down to the audit fields.
          steps: [
            {
              tool: 'Read',
              isError: false,
              input: '{"file_path":"trace/events.json"}',
              output: 'xxxxxxxxxxxx',
            } as AgentJudgeStep,
          ],
          runtime: 'fake',
        };
      },
    });
    const judge = agenticJudge({
      buildPrompt: () => ({ prompt: 'p' }),
      parseScore: () => ({ score: 1 }),
    });
    const score = await judge.evaluate(input, {});
    expect(
      (score.metadata as { agent: { steps: unknown } }).agent.steps
    ).toEqual([{ tool: 'Read', isError: false }]);
    expect(JSON.stringify(score)).not.toContain('xxxxxxxx');
  });

  it('preflight names the credential its runtime is missing', async () => {
    const judge = agenticJudge({
      buildPrompt: () => ({ prompt: 'p' }),
      parseScore: () => ({ score: 1 }),
    });
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_AUTH_TOKEN',
      'MST_LLM_AUTH_COMMAND',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
    ])
      vi.stubEnv(name, '');
    await expect(judge.preflight!({})).rejects.toThrow('ANTHROPIC_API_KEY');
    await expect(judge.preflight!({ runtime: 'codex' })).rejects.toThrow(
      'OPENAI_API_KEY'
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    await expect(judge.preflight!({})).resolves.toBeUndefined();
    await expect(
      judge.preflight!({ runtime: 'codex' })
    ).resolves.toBeUndefined();
  });

  it('writes the full evidence, runs the configured runtime, and parses the verdict', async () => {
    const seen: { task?: AgentJudgeTask; files?: Record<string, string> } = {};
    runtimes['claude-agent'] = fakeRuntime(() => ({ score: 8 }), seen);
    const judge = agenticJudge({
      defaults: { runtime: 'codex', model: 'default-model', maxTurns: 10 },
      files: () => [{ path: 'scripts/helper.py', content: 'print(1)\n' }],
      commands: [
        {
          name: 'helper',
          description: 'h',
          argv: ['python3', 'scripts/helper.py'],
        },
      ],
      buildPrompt: ({ case: c }) => ({
        system: 'S',
        prompt: `Q: ${c.input.prompt}`,
      }),
      outputSchema: { type: 'object' },
      parseScore: (out) => ({
        score: (out.json as { score: number }).score / 10,
        metadata: { label: 'ok' },
      }),
      version: 'v1',
    });
    const options = judge.schema.parse({
      runtime: 'claude-agent',
      model: 'm2',
    }) as Record<string, unknown>;
    const verdict = await judge.evaluate(input, options);

    expect(verdict.score).toBe(0.8);
    expect(verdict.provider).toBe('fake');
    expect(verdict.model).toBe('m2');
    expect(verdict.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(verdict.metadata).toMatchObject({
      label: 'ok',
      agent: { runtime: 'fake', turns: 3, version: 'v1' },
    });
    expect(seen.task).toMatchObject({
      system: 'S',
      prompt: 'Q: What is the launch date?',
      maxTurns: 10,
    });
    expect(seen.task?.commands?.[0]?.name).toBe('helper');
    // Nothing is truncated.
    const events = JSON.parse(seen.files!['trace/events.json']!);
    expect(events[0].output).toHaveLength(50_000);
    expect(seen.files!['response.md']).toBe('It launches March 3.');
    expect(JSON.parse(seen.files!['case.json']!).expected.answer).toBe(
      'March 3'
    );
    expect(seen.files!['scripts/helper.py']).toBe('print(1)\n');
  });

  it('removes the workspace afterwards, also on error', async () => {
    const seen: { task?: AgentJudgeTask } = {};
    runtimes['claude-agent'] = fakeRuntime(() => ({}), seen);
    const judge = agenticJudge({
      buildPrompt: () => ({ prompt: 'p' }),
      parseScore: () => {
        throw new Error('bad answer');
      },
    });
    await expect(judge.evaluate(input, {})).rejects.toThrow('bad answer');
    await expect(stat(seen.task!.workspace)).rejects.toThrow();
  });

  it('creates a private workspace', async () => {
    let mode = 0;
    runtimes['claude-agent'] = () => ({
      id: 'fake',
      async run(task: AgentJudgeTask) {
        mode = (await stat(task.workspace)).mode & 0o777;
        return { text: '', usage: {}, steps: [], runtime: 'fake' };
      },
    });
    const judge = agenticJudge({
      buildPrompt: () => ({ prompt: 'p' }),
      parseScore: () => ({ score: 1 }),
    });
    await judge.evaluate(input, {});
    expect(mode).toBe(0o700);
  });

  it('rejects files that would leave the workspace', async () => {
    runtimes['claude-agent'] = fakeRuntime(() => ({}));
    for (const path of ['../escape.txt', '/etc/escape', 'a/../../escape', '']) {
      const judge = agenticJudge({
        files: () => [{ path, content: 'x' }],
        buildPrompt: () => ({ prompt: 'p' }),
        parseScore: () => ({ score: 1 }),
      });
      await expect(judge.evaluate(input, {})).rejects.toThrow(
        /Invalid workspace path|escapes the workspace/
      );
    }
  });

  it("copies the trial's stored artifacts into artifacts/, leaving the copy alone", async () => {
    const stored = await mkdtemp(join(tmpdir(), 'mst-stored-'));
    try {
      await mkdir(join(stored, 'outputs'), { recursive: true });
      await writeFile(join(stored, 'audit.jsonl'), '{}\n');
      await writeFile(join(stored, 'outputs', 'plan.md'), '# Plan\n');
      await symlink('/etc/hosts', join(stored, 'outputs', 'link'));
      const seen: { files?: Record<string, string> } = {};
      runtimes['claude-agent'] = fakeRuntime(() => ({}), seen);
      const judge = agenticJudge({
        buildPrompt: () => ({ prompt: 'p' }),
        parseScore: () => ({ score: 1 }),
      });
      await judge.evaluate(
        { ...input, trial: { ...input.trial, artifactsDir: stored } },
        {}
      );
      expect(seen.files!['artifacts/audit.jsonl']).toBe('{}\n');
      expect(seen.files!['artifacts/outputs/plan.md']).toBe('# Plan\n');
      expect(seen.files).not.toHaveProperty('artifacts/outputs/link');
      expect(await readFile(join(stored, 'outputs', 'plan.md'), 'utf-8')).toBe(
        '# Plan\n'
      );
    } finally {
      await rm(stored, { recursive: true, force: true });
    }
  });

  it('gives a trial without artifacts no artifacts/ directory', async () => {
    const seen: { files?: Record<string, string> } = {};
    runtimes['claude-agent'] = fakeRuntime(() => ({}), seen);
    const judge = agenticJudge({
      buildPrompt: () => ({ prompt: 'p' }),
      parseScore: () => ({ score: 1 }),
    });
    await judge.evaluate(input, {});
    expect(
      Object.keys(seen.files!).filter((f) => f.startsWith('artifacts/'))
    ).toEqual([]);
  });

  it('rejects unknown options and keeps plugin options', () => {
    const judge = agenticJudge({
      schema: z.object({ rubric: z.string().optional() }),
      buildPrompt: () => ({ prompt: 'p' }),
      parseScore: () => ({ score: 1 }),
    });
    expect(judge.schema.parse({ rubric: 'r', runtime: 'codex' })).toEqual({
      rubric: 'r',
      runtime: 'codex',
    });
    expect(() => judge.schema.parse({ runtime: 'shell' })).toThrow();
    expect(() => judge.schema.parse({ apiKey: 'k' })).toThrow();
  });
});

describe('agenticPairwiseJudge', () => {
  function result(id: string, text: string): EvalCaseResult {
    return {
      id,
      datasetName: 'd',
      source: 'eval',
      pass: true,
      scores: {},
      durationMs: 1,
      request: { input: `q-${id}` },
      response: { response: text, events: [] },
    } as EvalCaseResult;
  }

  it("gives each side its trial's artifacts, as a/artifacts and b/artifacts", async () => {
    const dirs = await Promise.all(
      ['base', 'cand'].map(async (name) => {
        const dir = await mkdtemp(join(tmpdir(), `mst-stored-${name}-`));
        await writeFile(join(dir, 'audit.jsonl'), `${name}\n`);
        return dir;
      })
    );
    try {
      const seen: Array<Record<string, string>> = [];
      runtimes['claude-agent'] = fakeRuntime((_task, files) => {
        seen.push(files);
        return {
          winner: files['a/artifacts/audit.jsonl'] === 'base\n' ? 'B' : 'A',
        };
      });
      installPlugins([
        {
          meta: { name: 'p', namespace: 'p' },
          pairwiseJudges: {
            logs: agenticPairwiseJudge({
              buildPrompt: () => ({
                prompt: 'compare a/artifacts and b/artifacts',
              }),
              parsePreference: (out) => ({
                preference:
                  (out.json as { winner: string }).winner === 'A'
                    ? 'baseline'
                    : 'candidate',
              }),
            }),
          },
        },
      ]);
      const withArtifacts = (id: string, text: string, dir: string) =>
        ({
          ...result(id, text),
          artifacts: { dir, include: ['**'] },
        }) as unknown as EvalCaseResult;
      const out = await comparePairwise({
        baseline: {
          name: 'base',
          caseResults: [withArtifacts('c', 'x', dirs[0]!)],
        },
        candidate: {
          name: 'cand',
          caseResults: [withArtifacts('c', 'y', dirs[1]!)],
        },
        judges: [{ type: 'p/pairwise-judge/logs' }],
      });
      // Both orders: each side's own log, never the other's.
      expect(
        seen.map((f) => [
          f['a/artifacts/audit.jsonl'],
          f['b/artifacts/audit.jsonl'],
        ])
      ).toEqual(
        expect.arrayContaining([
          ['base\n', 'cand\n'],
          ['cand\n', 'base\n'],
        ])
      );
      expect(out.cases[0]!.preferences[0]!.preference).toBe('candidate');
    } finally {
      await Promise.all(
        dirs.map((dir) => rm(dir, { recursive: true, force: true }))
      );
    }
  });

  it('gives a/ the baseline and b/ the candidate, in both orders', async () => {
    const seenA: string[] = [];
    runtimes['claude-agent'] = fakeRuntime((_task, files) => {
      seenA.push(files['a/response.md']!);
      // Prefer the longer response.
      return {
        winner:
          files['a/response.md']!.length >= files['b/response.md']!.length
            ? 'A'
            : 'B',
      };
    });
    installPlugins([
      {
        meta: { name: 'p', namespace: 'p' },
        pairwiseJudges: {
          longer: agenticPairwiseJudge({
            buildPrompt: () => ({ prompt: 'compare a/ and b/' }),
            parsePreference: (out) => ({
              preference:
                (out.json as { winner: string }).winner === 'A'
                  ? 'baseline'
                  : 'candidate',
            }),
          }),
        },
      },
    ]);
    const out = await comparePairwise({
      baseline: { name: 'base', caseResults: [result('c', 'short')] },
      candidate: {
        name: 'cand',
        caseResults: [result('c', 'a much longer answer')],
      },
      judges: [{ type: 'p/pairwise-judge/longer' }],
    });
    expect(seenA.sort()).toEqual(['a much longer answer', 'short']);
    const verdict = out.cases[0]!.preferences[0]!;
    expect(verdict.preference).toBe('candidate');
    expect(verdict.consistent).toBe(true);
  });
});
