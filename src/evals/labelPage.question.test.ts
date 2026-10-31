/**
 * The question the label page shows: a built-in rubric's text, a custom
 * rubric's, or --question. The rubric judges run on a mocked judge client.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type * as JudgeClientModule from '../judge/judgeClient.js';
import { createJudge } from '../judge/judgeClient.js';
import { BUILT_IN_RUBRICS } from '../judge/rubrics.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import { startLabelPage, type LabelPageServer } from './labelPage.js';
import { runEval } from './runEval.js';

vi.mock('../judge/judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudge: vi.fn(),
  preflightJudge: vi.fn(async () => {}),
}));

const dirs: string[] = [];
const servers: LabelPageServer[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

const plugin: Plugin = {
  meta: { name: 'label-question-test-plugin', namespace: 'lq' },
  clients: {
    scripted: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      async run(input) {
        return { finalText: `answer to ${input.prompt}`, events: [] };
      },
    },
  },
  judges: {
    always: {
      schema: z.object({}).strict(),
      async evaluate() {
        return { score: 1 };
      },
    },
  },
};

const CAUSE = 'Does the answer name the cause?';

async function storedRun(): Promise<string> {
  vi.mocked(createJudge).mockImplementation(() => ({
    async evaluate() {
      return { pass: true, score: 1, reasoning: 'ok' };
    },
  }));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-label-question-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'dataset.json'),
    JSON.stringify({
      name: 'outages',
      cases: [{ id: 'cause', input: 'Why did checkout fail' }],
    })
  );
  const judge = { provider: 'anthropic', model: 'claude-haiku-4-5' };
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'label-question-test',
      datasets: ['./dataset.json'],
      client: 'lq/client/scripted',
      redactStoredResponses: false,
      servers: { docs: { transport: 'stdio', command: 'docs-server' } },
      judges: [
        { type: 'rubric', rubric: 'correctness', ...judge },
        { type: 'rubric', rubric: { text: CAUSE }, ...judge },
        'lq/judge/always',
      ],
      variants: [{ name: 'only', servers: ['docs'] }],
    })
  );
  const result = await runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
    report: false,
  });
  return result.outputDir;
}

async function question(
  directory: string,
  judge: string,
  given?: string
): Promise<string | undefined> {
  const server = await startLabelPage({
    directory,
    judge,
    ...(given !== undefined ? { question: given } : {}),
  });
  servers.push(server);
  return server.data.question;
}

describe("the label page's question", () => {
  it("is a built-in rubric's text, a custom rubric's, --question, or none", async () => {
    const directory = await storedRun();
    expect(await question(directory, 'correctness')).toBe(
      BUILT_IN_RUBRICS.correctness
    );
    // A custom rubric ({ text }) is named rubric.
    expect(await question(directory, 'rubric')).toBe(CAUSE);
    // MST can't know a plugin judge's question unless it's given.
    expect(await question(directory, 'lq/judge/always')).toBeUndefined();
    expect(await question(directory, 'lq/judge/always', 'Is it right?')).toBe(
      'Is it right?'
    );
    // --question wins over what the run says.
    expect(await question(directory, 'correctness', 'Mine')).toBe('Mine');
  });
});
