import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PairwiseJudgeInput } from '../pairwiseContract.js';
import type { AgentJudgeRuntime, AgentJudgeTask } from './runtime.js';
import {
  aIsCandidate,
  firstJsonObject,
  parseSlotVerdict,
  pythonJson,
  stagedPairwiseJudge,
  type StagedJudgeBundle,
} from './stagedJudge.js';

const runtimes = vi.hoisted(
  () => ({}) as Record<string, (() => AgentJudgeRuntime) | undefined>
);
vi.mock('./codexRuntime.js', () => ({
  codexRuntime: () => runtimes.codex!(),
  probeCodexSandbox: async () => {},
}));
vi.mock('./claudeRuntime.js', () => ({
  claudeRuntime: () => runtimes['claude-agent']!(),
}));

afterEach(() => {
  for (const key of Object.keys(runtimes)) delete runtimes[key];
});

function pair(caseId = 'c1'): PairwiseJudgeInput {
  const trial = (text: string) => ({ response: {}, text, events: [] });
  return {
    case: {
      id: caseId,
      input: { prompt: 'q?' },
      expected: {},
      tags: [],
      metadata: {},
    },
    baseline: trial('baseline answer'),
    candidate: trial('candidate answer'),
  };
}

/** Answers by stage (the prompt's first line), recording each task and the workspace it saw. */
function scripted(answers: Record<string, string>) {
  const tasks: Array<{ stage: string; task: AgentJudgeTask; files: string[] }> =
    [];
  runtimes['claude-agent'] = () => ({
    id: 'fake',
    async run(task) {
      const stage = task.prompt.split('\n')[0]!;
      const files: string[] = [];
      const walk = async (dir: string, prefix = ''): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(join(dir, e.name), rel);
          else files.push(rel);
        }
      };
      await walk(task.workspace);
      tasks.push({ stage, task, files: files.sort() });
      const text = answers[stage];
      if (text === undefined) throw new Error(`no answer for ${stage}`);
      return {
        text,
        usage: { inputTokens: 10, outputTokens: 2 },
        turns: 1,
        steps: [{ tool: 'Shell' }],
        runtime: 'fake',
        model: 'fake-model',
      };
    },
  });
  return tasks;
}

const BUNDLE: StagedJudgeBundle = {
  schemaVersion: 1,
  name: 'three-stage',
  files: [{ path: 'prompts/gather.md', content: 'gather\nRead a/ and b/.' }],
  stages: [
    {
      id: 'gather',
      prompt: [{ file: 'prompts/gather.md' }],
      forbidKeys: ['preferred', 'gap_score'],
    },
    {
      id: 'quality',
      after: ['gather'],
      writes: [
        {
          path: 'context.json',
          content: [
            { json: { notes: '{{stages.gather.text}}', q: '{{case.input}}' } },
          ],
        },
      ],
      prompt: [{ text: 'quality\nContext: {{workspace}}/context.json' }],
      output: 'verdict',
    },
    {
      id: 'overall',
      after: ['quality'],
      prompt: [
        { text: 'overall\n' },
        { json: { quality: '{{stages.quality.json}}' }, format: 'python' },
      ],
      output: 'verdict',
    },
  ],
  result: { overall: 'overall', dimensions: { quality: 'quality' } },
};

describe('stagedPairwiseJudge', () => {
  it('runs the stages in order, quoting earlier answers, and maps slots to sides', async () => {
    const input = pair();
    const candidateIsA = aIsCandidate(['c1']);
    const winner = candidateIsA ? 'A' : 'B';
    const tasks = scripted({
      gather: 'A cites the doc; B guesses.',
      quality: `{"preferred": "${winner}", "gap_score": 3, "explanation": "q"}`,
      overall: `Verdict:\n\`\`\`json\n{"preferred": "${winner}", "gap_score": 2, "explanation": "o"}\n\`\`\``,
    });
    const judge = stagedPairwiseJudge(BUNDLE);
    expect(judge.swapPositions).toBe(false);
    expect(judge.requires).toBeUndefined();
    expect(
      stagedPairwiseJudge({ ...BUNDLE, requires: ['candidate.artifactsDir'] })
        .requires
    ).toEqual(['candidate.artifactsDir']);
    const pref = await judge.compare(input, {});

    expect(tasks.map((t) => t.stage)).toEqual(['gather', 'quality', 'overall']);
    expect(pref).toMatchObject({
      preference: 'candidate',
      strength: 0.4,
      reasoning: 'o',
      dimensions: {
        quality: { preference: 'candidate', strength: 0.6, reasoning: 'q' },
      },
      provider: 'fake',
      metadata: {
        judge: 'three-stage',
        slotA: candidateIsA ? 'candidate' : 'baseline',
      },
    });
    expect(pref.usage).toMatchObject({ inputTokens: 30, outputTokens: 6 });
    expect(pref.version).toMatch(/^[0-9a-f]{64}$/);
    // The overall stage saw the slot verdict, in Python's json.dumps form.
    expect(tasks[2]!.task.prompt).toContain(
      `{"quality": {"explanation": "q", "gap_score": 3, "preferred": "${winner}"}}`
    );
    // The quality stage's context file was written before it ran.
    expect(tasks[1]!.files).toContain('context.json');
    expect(tasks[0]!.files).not.toContain('context.json');
    // Slot A holds whichever run the hash picked; nothing names the sides.
    const ws = tasks[0]!.files;
    expect(ws).toEqual(
      expect.arrayContaining([
        'a/response.md',
        'b/response.md',
        'case.json',
        'prompts/gather.md',
      ])
    );
  });

  it('reads the stage context with placeholders filled', async () => {
    let context = '';
    const tasks = scripted({
      gather: 'notes',
      quality: '{"preferred": "tie", "gap_score": 0}',
      overall: '{"preferred": "tie", "gap_score": 0}',
    });
    const original = runtimes['claude-agent']!;
    runtimes['claude-agent'] = () => {
      const inner = original();
      return {
        id: inner.id,
        async run(task) {
          if (task.prompt.startsWith('quality'))
            context = await readFile(
              join(task.workspace, 'context.json'),
              'utf8'
            );
          return inner.run(task);
        },
      };
    };
    const pref = await stagedPairwiseJudge(BUNDLE).compare(pair(), {});
    expect(JSON.parse(context)).toEqual({ notes: 'notes', q: 'q?' });
    expect(pref.preference).toBe('tie');
    expect(pref.strength).toBe(0);
    expect(tasks).toHaveLength(3);
  });

  it('fails the comparison on a forbidden key, a bad verdict or an empty answer', async () => {
    scripted({ gather: '{"preferred": "A"}', quality: '', overall: '' });
    await expect(
      stagedPairwiseJudge(BUNDLE).compare(pair(), {})
    ).rejects.toThrow(/gather answered a forbidden key/);
    scripted({
      gather: 'ok',
      quality: '{"preferred": "tie", "gap_score": 2}',
      overall: '',
    });
    await expect(
      stagedPairwiseJudge(BUNDLE).compare(pair(), {})
    ).rejects.toThrow(/quality verdict: tie verdict must use gap_score 0/);
    scripted({ gather: '  ', quality: '', overall: '' });
    await expect(
      stagedPairwiseJudge(BUNDLE).compare(pair(), {})
    ).rejects.toThrow(/gather answered nothing/);
  });

  it('runs independent stages in parallel and prepare programs first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-staged-test-'));
    try {
      const script = join(dir, 'prep.mjs');
      await writeFile(
        script,
        "import { writeFileSync, readFileSync } from 'node:fs';\n" +
          "writeFileSync('prepared.json', JSON.stringify({ a: readFileSync('a/response.md', 'utf8') }));\n"
      );
      let inFlight = 0;
      let peak = 0;
      const seen: string[] = [];
      runtimes['claude-agent'] = () => ({
        id: 'fake',
        async run(task) {
          inFlight++;
          peak = Math.max(peak, inFlight);
          seen.push(task.prompt);
          await new Promise((r) => setTimeout(r, 20));
          inFlight--;
          return {
            text: '{"preferred": "tie", "gap_score": 0}',
            usage: {},
            steps: [],
            runtime: 'fake',
          };
        },
      });
      const judge = stagedPairwiseJudge({
        schemaVersion: 1,
        name: 'parallel',
        prepare: [{ argv: [process.execPath, script] }],
        stages: [
          {
            id: 'x',
            prompt: [{ text: 'x {{file.json:prepared.json}}' }],
            output: 'verdict',
          },
          { id: 'y', prompt: [{ text: 'y' }], output: 'verdict' },
          {
            id: 'z',
            after: ['x', 'y'],
            prompt: [{ text: 'z' }],
            output: 'verdict',
          },
        ],
        result: { overall: 'z', dimensions: { x: 'x', y: 'y' } },
      });
      await judge.compare(pair(), {});
      expect(peak).toBe(2);
      expect(seen.at(-1)).toBe('z');
      expect(seen.find((p) => p.startsWith('x'))).toMatch(
        /^x \{"a":"(baseline|candidate) answer"\}$/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts agents in the workdir prepare laid out', async () => {
    const tasks = scripted({ o: '{"preferred": "tie", "gap_score": 0}' });
    const bundle: StagedJudgeBundle = {
      schemaVersion: 1,
      name: 'w',
      workdir: 'input',
      prepare: [
        {
          argv: [
            process.execPath,
            '-e',
            "require('fs').mkdirSync('input'); require('fs').writeFileSync('input/x', '')",
          ],
        },
      ],
      stages: [{ id: 'o', prompt: [{ text: 'o' }], output: 'verdict' }],
      result: { overall: 'o' },
    };
    await stagedPairwiseJudge(bundle).compare(pair(), {});
    expect(tasks[0]!.task.workspace).toMatch(/[/\\]input$/);
    expect(tasks[0]!.files).toEqual(['x']);
    await expect(
      stagedPairwiseJudge({ ...bundle, prepare: [] }).compare(pair(), {})
    ).rejects.toThrow(/workdir input was not prepared/);
  });

  it('reports a failed prepare program with its output', async () => {
    scripted({});
    const judge = stagedPairwiseJudge({
      schemaVersion: 1,
      name: 'p',
      prepare: [
        {
          argv: [
            process.execPath,
            '-e',
            'console.error("no audit log"); process.exit(3)',
          ],
        },
      ],
      stages: [{ id: 'o', prompt: [{ text: 'o' }], output: 'verdict' }],
      result: { overall: 'o' },
    });
    await expect(judge.compare(pair(), {})).rejects.toThrow(
      /prepare .* failed[\s\S]*no audit log/
    );
  });

  it('puts the baseline in slot A, and lets MST swap, when the order is baseline-first', async () => {
    const tasks = scripted({ o: '{"preferred": "A", "gap_score": 5}' });
    const judge = stagedPairwiseJudge({
      schemaVersion: 1,
      name: 'fixed',
      order: { mode: 'baseline-first' },
      stages: [
        { id: 'o', prompt: [{ text: 'o\n{{case.id}}' }], output: 'verdict' },
      ],
      result: { overall: 'o' },
    });
    expect(judge.swapPositions).toBe(true);
    const pref = await judge.compare(pair(), {});
    expect(pref).toMatchObject({ preference: 'baseline', strength: 1 });
    expect(tasks[0]!.task.prompt).toBe('o\nc1');
  });

  it('rejects a bundle with a bad graph or reference when it is defined', () => {
    const base = { schemaVersion: 1 as const, name: 'bad' };
    const verdict = { output: 'verdict' as const };
    expect(() =>
      stagedPairwiseJudge({
        ...base,
        stages: [
          { id: 'a', after: ['b'], prompt: [{ text: 'a' }], ...verdict },
          { id: 'b', after: ['a'], prompt: [{ text: 'b' }], ...verdict },
        ],
        result: { overall: 'a' },
      })
    ).toThrow(/cycle/);
    expect(() =>
      stagedPairwiseJudge({
        ...base,
        stages: [
          { id: 'a', prompt: [{ text: '{{stages.b.text}}' }], ...verdict },
          { id: 'b', prompt: [{ text: 'b' }], ...verdict },
        ],
        result: { overall: 'a' },
      })
    ).toThrow(/quotes stage b, which is not before it/);
    expect(() =>
      stagedPairwiseJudge({
        ...base,
        stages: [{ id: 'a', prompt: [{ file: 'missing.md' }], ...verdict }],
        result: { overall: 'a' },
      })
    ).toThrow(/not a text file in the bundle/);
    expect(() =>
      stagedPairwiseJudge({
        ...base,
        stages: [{ id: 'a', prompt: [{ text: 'a' }] }],
        result: { overall: 'a' },
      })
    ).toThrow(/not a verdict stage/);
    expect(() =>
      stagedPairwiseJudge({
        ...base,
        files: [{ path: '../x', content: '' }],
        stages: [{ id: 'a', prompt: [{ text: 'a' }], ...verdict }],
        result: { overall: 'a' },
      })
    ).toThrow(/escapes/);
  });
});

describe('verdict parsing', () => {
  it('maps a slot verdict to the candidate, as a 0-5 gap', () => {
    expect(
      parseSlotVerdict({ preferred: 'b', gap_score: 4 }, false)
    ).toMatchObject({ preferred: 'B', advantage: 4 });
    expect(
      parseSlotVerdict({ preferred: 'B', gap_score: 4 }, true)
    ).toMatchObject({ advantage: -4 });
    expect(
      parseSlotVerdict(
        { preferred: 'A', absolute_score_a: 9, absolute_score_b: 3 },
        true
      )
    ).toMatchObject({ gap: 3, advantage: 3 });
    expect(() =>
      parseSlotVerdict({ preferred: 'C', gap_score: 1 }, true)
    ).toThrow(/preferred/);
    expect(() =>
      parseSlotVerdict({ preferred: 'A', gap_score: 6 }, true)
    ).toThrow(/0 to 5/);
    expect(() =>
      parseSlotVerdict({ preferred: 'A', absolute_score_a: 3 }, true)
    ).toThrow(/together/);
  });

  it('reads the first JSON object around prose and fences', () => {
    expect(firstJsonObject('x {"a": {"b": "}"}} y {"c": 1}')).toEqual({
      a: { b: '}' },
    });
    expect(() => firstJsonObject('none')).toThrow(/no JSON/);
    expect(() => firstJsonObject('{"a": ')).toThrow(/no complete JSON/);
  });

  it('prints JSON as Python json.dumps(sort_keys=True) does', () => {
    expect(pythonJson({ b: [1, 'é'], a: null, c: { y: true, x: 'q"' } })).toBe(
      '{"a": null, "b": [1, "\\u00e9"], "c": {"x": "q\\"", "y": true}}'
    );
  });

  it('picks slot A from the hash of the seed, as production does', async () => {
    const { createHash } = await import('node:crypto');
    for (const seed of [['c1'], ['base', 'test', 'c2']])
      expect(aIsCandidate(seed)).toBe(
        createHash('sha256').update(seed.join('\x1f')).digest()[0]! >= 128
      );
  });
});
