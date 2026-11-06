import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listJudgeCommand, showJudge } from './index.js';
import { resetPluginsForTests } from '../../../plugins/extensions.js';
import { assertPlugin } from '../../../plugins/plugin.js';

let dir: string;
let pluginPath: string;
let barePluginPath: string;

// A plugin module with a judge and a pairwise judge, loaded as --plugins loads one.
const PLUGIN = `
import { z } from 'zod';
export default {
  meta: { name: 'acme-plugin', namespace: 'acme', version: '1.4.0' },
  judges: {
    completeness: {
      description: 'Did the answer cover every point of the expected answer?',
      version: 'completeness-2',
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

// A plugin with no version whose judge declares none: MST can't version it.
const BARE_PLUGIN = `
export default {
  meta: { name: 'bare-plugin', namespace: 'bare' },
  judges: {
    loose: {
      schema: { safeParse: (value) => ({ success: true, data: value }) },
      async evaluate() { return { score: 1 }; },
    },
  },
};
`;

const HASH = /^[0-9a-f]{64}$/;

function capture(): { text: () => string; print: (text: string) => void } {
  let out = '';
  return { text: () => out, print: (text) => (out += text) };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-judges-'));
  pluginPath = path.join(dir, 'plugin.mjs');
  await fs.writeFile(pluginPath, PLUGIN);
  barePluginPath = path.join(dir, 'bare.mjs');
  await fs.writeFile(barePluginPath, BARE_PLUGIN);
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
        ref: 'criteria',
        kind: 'judge',
        description: expect.stringContaining("the case's own criteria"),
        requires: [],
        version: expect.stringMatching(HASH),
      },
      {
        ref: 'grounded-in-tools',
        kind: 'judge',
        description: expect.stringContaining('supported by a tool result'),
        requires: [],
        version: expect.stringMatching(HASH),
      },
      {
        ref: 'rubric',
        kind: 'judge',
        description: expect.stringContaining('rubric'),
        requires: [],
        version: expect.stringMatching(HASH),
      },
      {
        ref: 'task-completion',
        kind: 'judge',
        description: expect.stringContaining('did what the user asked'),
        requires: [],
        version: expect.stringMatching(HASH),
      },
      {
        ref: 'tool-use',
        kind: 'judge',
        description: expect.stringContaining('chose the right tools'),
        requires: [],
        version: expect.stringMatching(HASH),
      },
      {
        ref: 'preference',
        kind: 'pairwise',
        description: expect.stringContaining('better did what the user asked'),
        requires: [],
        version: expect.stringMatching(HASH),
      },
    ]);
  });

  it("lists plugins' judges and pairwise judges", async () => {
    const out = capture();
    await listJudgeCommand(plugins(), out.print);
    const lines = out.text().trimEnd().split('\n');
    expect(lines.map((line) => line.split(/\s{2,}/).slice(0, 2))).toEqual([
      ['acme/judge/completeness', 'judge'],
      ['criteria', 'judge'],
      ['grounded-in-tools', 'judge'],
      ['rubric', 'judge'],
      ['task-completion', 'judge'],
      ['tool-use', 'judge'],
      ['acme/pairwise-judge/ordered', 'pairwise'],
      ['acme/pairwise-judge/preference', 'pairwise'],
      ['preference', 'pairwise'],
    ]);
    expect(lines[0]).toContain('requires case.expected.answer');
    expect(lines[0]).toContain(
      'Did the answer cover every point of the expected answer?'
    );
  });

  it("lists each judge's version, or marks it unversioned", async () => {
    const out = capture();
    await listJudgeCommand(
      { plugins: [pluginPath, barePluginPath], rootDir: dir, json: true },
      out.print
    );
    const listed = JSON.parse(out.text()) as Array<{
      ref: string;
      version?: string;
      unversioned?: true;
    }>;
    const byRef = Object.fromEntries(listed.map((entry) => [entry.ref, entry]));
    // A built-in's version covers its prompts and defaults.
    expect(byRef.rubric).toMatchObject({
      version: expect.stringMatching(HASH),
    });
    expect(byRef.preference).toMatchObject({
      version: expect.stringMatching(HASH),
    });
    expect(byRef.rubric).not.toHaveProperty('unversioned');
    // A plugin judge's own version, else its plugin's.
    expect(byRef['acme/judge/completeness']).toMatchObject({
      version: 'completeness-2',
    });
    expect(byRef['acme/pairwise-judge/preference']).toMatchObject({
      version: '1.4.0',
    });
    expect(byRef['acme/pairwise-judge/preference']).not.toHaveProperty(
      'unversioned'
    );
    // Neither: unversioned, with no version.
    expect(byRef['bare/judge/loose']).toMatchObject({ unversioned: true });
    expect(byRef['bare/judge/loose']).not.toHaveProperty('version');

    resetPluginsForTests();
    const table = capture();
    await listJudgeCommand(
      { plugins: [pluginPath, barePluginPath], rootDir: dir },
      table.print
    );
    expect(table.text()).toMatch(
      /^acme\/judge\/completeness +judge +completeness-2 +requires/m
    );
    expect(table.text()).toMatch(
      /^acme\/pairwise-judge\/preference +pairwise +1\.4\.0 +Which answer/m
    );
    expect(table.text()).toMatch(/^bare\/judge\/loose +judge +unversioned$/m);
    expect(table.text()).toMatch(
      /^rubric +judge +[0-9a-f]{12} +An LLM grades/m
    );

    resetPluginsForTests();
    const shown = capture();
    await showJudge(
      'bare/judge/loose',
      { plugins: [barePluginPath], rootDir: dir, json: true },
      shown.print
    );
    expect(JSON.parse(shown.text())).toMatchObject({
      ref: 'bare/judge/loose',
      unversioned: true,
    });
    resetPluginsForTests();
    const shownText = capture();
    await showJudge('acme/judge/completeness', plugins(), shownText.print);
    expect(shownText.text()).toContain('  version   completeness-2');
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
      version: 'completeness-2',
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
      /No judge "acme\/judge\/nope"\. Judges: acme\/judge\/completeness, criteria, grounded-in-tools, rubric, task-completion, tool-use, acme\/pairwise-judge\/ordered, acme\/pairwise-judge\/preference, preference\./
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
