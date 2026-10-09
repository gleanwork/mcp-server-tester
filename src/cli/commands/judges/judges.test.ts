import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listJudgeCommand, showJudge } from './index.js';
import { resetPluginsForTests } from '../../../plugins/extensions.js';
import { assertPlugin } from '../../../plugins/plugin.js';

let dir: string;
let pluginPath: string;

// A plugin module with a judge and a pairwise judge, loaded as --plugins loads one.
const PLUGIN = `
import { z } from 'zod';
export default {
  meta: { name: 'acme-plugin', namespace: 'acme' },
  judges: {
    completeness: {
      description: 'Did the answer cover every point of the expected answer?',
      requires: ['case.expected.answer'],
      schema: z.object({ strict: z.boolean().default(false) }).strict(),
      async evaluate() { return { score: 1 }; },
    },
  },
  pairwiseJudges: {
    preference: {
      description: 'Which answer would the asker rather get?',
      schema: z.object({ model: z.string().optional() }),
      async compare() { return { preferred: 'tie' }; },
    },
    ordered: {
      swapPositions: false,
      schema: z.object({}),
      async compare() { return { preferred: 'tie' }; },
    },
  },
};
`;

function capture(): { text: () => string; print: (text: string) => void } {
  let out = '';
  return { text: () => out, print: (text) => (out += text) };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-judges-'));
  pluginPath = path.join(dir, 'plugin.mjs');
  await fs.writeFile(pluginPath, PLUGIN);
  // The plugin imports zod: resolve it from this package.
  await fs.symlink(
    path.resolve('node_modules'),
    path.join(dir, 'node_modules'),
    'dir'
  );
});
afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

const plugins = () => ({ plugins: [pluginPath], rootDir: dir });

describe('mst judges', () => {
  it('lists built-in judges without plugins', async () => {
    const out = capture();
    await listJudgeCommand({ json: true }, out.print);
    expect(JSON.parse(out.text())).toEqual([
      {
        ref: 'rubric',
        kind: 'judge',
        description: expect.stringContaining('rubric'),
        requires: [],
      },
    ]);
  });

  it("lists plugins' judges and pairwise judges", async () => {
    const out = capture();
    await listJudgeCommand(plugins(), out.print);
    const lines = out.text().trimEnd().split('\n');
    expect(lines.map((line) => line.split(/\s{2,}/).slice(0, 2))).toEqual([
      ['acme/judge/completeness', 'judge'],
      ['rubric', 'judge'],
      ['acme/pairwise-judge/ordered', 'pairwise'],
      ['acme/pairwise-judge/preference', 'pairwise'],
    ]);
    expect(lines[0]).toContain('requires case.expected.answer');
    expect(lines[0]).toContain(
      'Did the answer cover every point of the expected answer?'
    );
  });

  it("shows a judge's requirements and options as JSON Schema", async () => {
    const out = capture();
    await showJudge(
      'acme/judge/completeness',
      { ...plugins(), json: true },
      out.print
    );
    expect(JSON.parse(out.text())).toMatchObject({
      ref: 'acme/judge/completeness',
      kind: 'judge',
      requires: ['case.expected.answer'],
      options: {
        type: 'object',
        properties: { strict: { type: 'boolean', default: false } },
        additionalProperties: false,
      },
    });
  });

  it('shows the built-in rubric judge and its rubrics', async () => {
    const out = capture();
    await showJudge('rubric', {}, out.print);
    expect(out.text()).toMatch(/^rubric {2}\(judge: scores each trial\)/);
    expect(out.text()).toContain('"correctness"');
    expect(out.text()).toContain('"rubric"');
  });

  it('shows whether a pairwise judge swaps positions', async () => {
    const shown = capture();
    await showJudge('acme/pairwise-judge/preference', plugins(), shown.print);
    expect(shown.text()).toContain(
      'acme/pairwise-judge/preference  (pairwise judge: compares each variant with the baseline)'
    );
    expect(shown.text()).toContain('swaps     yes: each order, reconciled');
    resetPluginsForTests();
    const ordered = capture();
    await showJudge(
      'acme/pairwise-judge/ordered',
      { ...plugins(), json: true },
      ordered.print
    );
    expect(JSON.parse(ordered.text())).toMatchObject({ swapPositions: false });
  });

  it('names the judges there are when one is missing', async () => {
    await expect(showJudge('acme/judge/nope', plugins())).rejects.toThrow(
      /No judge "acme\/judge\/nope"\. Judges: acme\/judge\/completeness, rubric, acme\/pairwise-judge\/ordered, acme\/pairwise-judge\/preference\./
    );
    await expect(showJudge('acme/judge/completeness', {})).rejects.toThrow(
      /Plugin judges need --plugins or --config/
    );
  });
});

describe('judge descriptions', () => {
  it('must be strings', () => {
    const judge = { schema: { safeParse: () => ({}) }, evaluate: () => {} };
    expect(() =>
      assertPlugin(
        {
          meta: { name: 'p', namespace: 'p' },
          judges: { j: { ...judge, description: 1 } },
        },
        'inline'
      )
    ).toThrow(/judges\.j: description must be a string/);
  });
});
