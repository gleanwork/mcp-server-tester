import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  installPlugins,
  resetPluginsForTests,
} from '../../plugins/extensions.js';
import type { EvalCaseResult } from '../../types/reporter.js';
import { comparePairwise } from '../../evals/pairwiseComparison.js';
import type { JudgeInput } from '../judgeContract.js';
import {
  agenticJudge,
  agenticPairwiseJudge,
  agentJudgeRuntimes,
} from './agenticJudge.js';
import type { AgentJudgeRuntime, AgentJudgeTask } from './runtime.js';

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
        steps: [{ tool: 'Read', input: 'case.json' }],
        runtime: 'fake',
        model: task.model ?? 'fake-model',
      };
    },
  });
}

const original = { ...agentJudgeRuntimes };
afterEach(() => {
  Object.assign(agentJudgeRuntimes, original);
  for (const key of Object.keys(agentJudgeRuntimes))
    if (!(key in original)) delete agentJudgeRuntimes[key];
  resetPluginsForTests();
});

describe('agenticJudge', () => {
  it('writes the full evidence, runs the configured runtime, and parses the verdict', async () => {
    const seen: { task?: AgentJudgeTask; files?: Record<string, string> } = {};
    agentJudgeRuntimes['claude-agent'] = fakeRuntime(
      () => ({ score: 8 }),
      seen
    );
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
    agentJudgeRuntimes.codex = fakeRuntime(() => ({}), seen);
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
    agentJudgeRuntimes.codex = () => ({
      id: 'fake',
      async run(task) {
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
    agentJudgeRuntimes.codex = fakeRuntime(() => ({}));
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

  it('gives a/ the baseline and b/ the candidate, in both orders', async () => {
    const seenA: string[] = [];
    agentJudgeRuntimes.codex = fakeRuntime((_task, files) => {
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
