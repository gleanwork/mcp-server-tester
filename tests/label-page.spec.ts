/**
 * The `mst label` page in a browser: an eval runs on a scripted plugin
 * client, then a person labels its judges' verdicts on the page.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from '../src/evals/runEval.js';
import { startLabelPage } from '../src/evals/labelPage.js';
import { readLabels } from '../src/evals/labels.js';
import type { Plugin } from '../src/plugins/plugin.js';

const plugin: Plugin = {
  meta: { name: 'label-page-spec', namespace: 'lps' },
  clients: {
    scripted: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      run: async (input, _config, context) => ({
        finalText: `${context.variant?.name === 'better' ? 'the certificate expired' : 'a deploy failed'} (${input.prompt})`,
        events: [
          {
            kind: 'tool_call' as const,
            source: 'mcp' as const,
            name: 'search',
            server: 'docs',
            arguments: { query: input.prompt },
            isError: false,
          },
        ],
      }),
    },
  },
  judges: {
    keyword: {
      schema: z.object({}).strict(),
      evaluate: async ({ trial }) => ({
        score: trial.text?.includes('certificate') ? 1 : 0,
        reasoning: 'SECRET-REASONING',
      }),
    },
  },
  pairwiseJudges: {
    longer: {
      schema: z.object({}).strict(),
      compare: async () => ({ preference: 'candidate' as const }),
    },
  },
};

const dirs: string[] = [];

test.afterAll(async () => {
  await Promise.all(
    dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function storedRun(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-label-spec-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [
        {
          id: 'cause',
          input: 'Why did checkout fail?',
          expected: { answer: 'An expired certificate' },
        },
        { id: 'duration', input: 'How long was checkout down?' },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'label-page-spec',
      datasets: ['./cases.json'],
      client: 'lps/client/scripted',
      redactStoredResponses: false,
      servers: { docs: { transport: 'stdio', command: 'docs-server' } },
      judges: ['lps/judge/keyword'],
      pairwiseJudges: ['lps/pairwise-judge/longer'],
      variants: [
        { name: 'baseline', servers: ['docs'] },
        { name: 'better', servers: ['docs'] },
      ],
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

async function saved(page: Page, count: number): Promise<void> {
  await expect(page.locator('#progress')).toContainText(`${count} of `);
}

test.describe('the label page', () => {
  test('labels trials with the keyboard, without showing the verdict or the variant', async ({
    page,
  }) => {
    const directory = await storedRun();
    const server = await startLabelPage({
      directory,
      judge: 'lps/judge/keyword',
      labeler: 'spec',
    });
    try {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(server.url);
      await expect(page.locator('#progress')).toHaveText(/^0 of 4 labeled/);
      const body = page.locator('body');
      await expect(body).toContainText(
        /Why did checkout fail\?|How long was checkout down\?/
      );
      await expect(body).not.toContainText('SECRET-REASONING');
      // MST can't know a plugin judge's question, and says so.
      await expect(page.locator('#no-question')).toBeVisible();
      await expect(page.locator('#question')).toBeHidden();
      await expect(body).not.toContainText('better');
      await expect(page.locator('.event summary').first()).toHaveText(
        'tool_call search (docs)'
      );

      // A held key labels one trial, not every trial after it.
      await page.keyboard.down('p');
      await saved(page, 1);
      await expect(page.locator('#status')).toHaveText('Saved Pass.');
      // Still held: the key repeats on the next trial.
      await page.keyboard.down('p');
      await page.keyboard.up('p');
      await page.waitForLoadState('networkidle');
      // It moved on once, to the next trial, without skipping one.
      await expect(page.locator('#item p').first()).toContainText('2 of 4 ·');
      expect(await readLabels(directory)).toHaveLength(1);

      await page.fill('#note', 'names no cause');
      await page.locator('#choices button', { hasText: 'Fail' }).click();
      await saved(page, 2);
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('#item p').first()).toContainText(
        'labeled Fail'
      );
      await expect(page.locator('#note')).toHaveValue('names no cause');

      // Opened again, the page starts at the first trial without a label.
      await page.reload();
      await expect(page.locator('#progress')).toHaveText(/^2 of 4 labeled/);
      await expect(page.locator('#item p').first()).toContainText('3 of 4 ·');

      const labels = await readLabels(directory);
      expect(labels.map((label) => label.label).sort()).toEqual([
        'fail',
        'pass',
      ]);
      expect(labels.find((label) => label.label === 'fail')?.note).toBe(
        'names no cause'
      );
      expect(errors).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test('labels a pairwise preference as A or B, without naming the baseline', async ({
    page,
  }) => {
    const directory = await storedRun();
    const server = await startLabelPage({
      directory,
      judge: 'lps/pairwise-judge/longer',
      labeler: 'spec',
      question: 'Which answer names the cause?',
    });
    try {
      await page.goto(server.url);
      await expect(page.locator('#no-question')).toBeHidden();
      await page.locator('#question summary').click();
      await expect(page.locator('#question-text')).toHaveText(
        'Which answer names the cause?'
      );
      await expect(page.locator('.sides h2').first()).toHaveText('A');
      await page.keyboard.press('a');
      await saved(page, 1);
      await expect(page.locator('#status')).toHaveText('Saved A is better.');
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('#item p').first()).toContainText(
        'labeled A is better'
      );
      const body = page.locator('body');
      await expect(body).not.toContainText('baseline');
      await expect(body).not.toContainText('candidate');
      // T labels the next case a tie.
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('t');
      await saved(page, 2);
      // That was the last case.
      await expect(page.locator('#status')).toContainText(
        'Every item has a label.'
      );
      const labels = await readLabels(directory);
      for (const label of labels)
        expect(label).toMatchObject({
          baseline: 'baseline',
          variant: 'better',
        });
      // One preference and one tie, in either order: labels are read in
      // file order, not the order the page showed the cases.
      const answers = labels.map((label) => label.label);
      expect(answers).toHaveLength(2);
      expect(answers).toContain('tie');
      expect(['baseline', 'candidate']).toContain(
        answers.find((answer) => answer !== 'tie')
      );
    } finally {
      await server.close();
    }
  });
});
