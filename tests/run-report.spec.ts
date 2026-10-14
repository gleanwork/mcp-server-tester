/**
 * The run report in a browser: an eval runs on a scripted plugin client,
 * then its report/index.html is opened and read like a person would.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from '../src/evals/runEval.js';
import { runReportPath } from '../src/evals/runReport.js';
import type { Plugin } from '../src/plugins/plugin.js';

const plugin: Plugin = {
  meta: { name: 'report-spec', namespace: 'rs' },
  clients: {
    // The baseline calls no tool; the other variant calls search.
    scripted: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      run: async (input, _config, context) => {
        // The `flaky` variant's client times out on one case.
        if (
          context.variant?.name === 'flaky' &&
          input.prompt?.includes('owners')
        )
          return {
            finalText: '',
            events: [],
            error: 'connect ETIMEDOUT 10.0.0.1:443',
          };
        // The `long` variant's call and answer have lines nothing can break.
        if (context.variant?.name === 'long')
          return {
            finalText: `See https://example.com/${'x'.repeat(240)}`,
            events: [
              {
                kind: 'tool_call' as const,
                source: 'mcp' as const,
                name: 'grep',
                server: 'acme',
                arguments: { pattern: '(^##\\d+\\.|^\\*\\*Source|'.repeat(12) },
                isError: false,
              },
            ],
          };
        const calls =
          context.variant?.name === 'searching' ||
          context.variant?.name === 'flaky';
        return {
          finalText: `answer to ${input.prompt}`,
          events: calls
            ? [
                {
                  kind: 'tool_call' as const,
                  source: 'mcp' as const,
                  name: 'search',
                  server: 'acme',
                  arguments: { query: input.prompt },
                  isError: false,
                },
              ]
            : [],
        };
      },
    },
  },
};

async function writeEval(
  dir: string,
  variants: Array<Record<string, unknown>>
): Promise<string> {
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: ['refunds', 'invoices', 'owners'].map((topic) => ({
        id: `find-${topic}`,
        input: `Who handles ${topic}?`,
        assertions: {
          toolsTriggered: { calls: [{ name: 'search', required: true }] },
        },
      })),
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'report-spec',
      datasets: ['./cases.json'],
      client: 'rs/client/scripted',
      servers: {},
      trials: 2,
      redactStoredResponses: false,
      variants,
    })
  );
  return configPath;
}

async function reportFor(
  variants: Array<Record<string, unknown>>
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-report-spec-'));
  const configPath = await writeEval(dir, variants);
  const result = await runEval({ configPath, rootDir: dir, plugins: [plugin] });
  return runReportPath(result.outputDir);
}

test.describe('run report', () => {
  test('compares variants with the baseline, case by case', async ({
    page,
  }) => {
    const report = await reportFor([
      { name: 'quiet' },
      { name: 'searching', model: 'search-model' },
    ]);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`file://${report}`);

    await expect(
      page.getByRole('heading', { name: 'report-spec' })
    ).toBeVisible();
    for (const section of [
      'Result',
      'Variants compared',
      'What differs',
      'Case by case',
      'Why trials failed',
    ])
      await expect(
        page.getByRole('heading', { name: section, exact: true })
      ).toBeVisible();
    const result = page.getByRole('heading', { name: 'Result' }).locator('..');
    await expect(result).toContainText('searching');
    await expect(result).toContainText('100%');
    // The change in the sentence is the difference of the rates it shows.
    await expect(result).toContainText('pass rate 0% → 100% (+100 pts');
    // Only toolsTriggered graded the trials: the report says no grader read the answers.
    await expect(result).toContainText('Graded on: toolsTriggered');
    await expect(result).toContainText('No grader read the answers');
    await expect(
      page.getByRole('cell', { name: 'search-model' })
    ).toBeVisible();

    await page
      .getByRole('button', {
        name: /^searching, find-refunds: 2 of 2 trials passed/,
      })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('find-refunds');
    await expect(dialog).toContainText('Trial 2');
    await expect(dialog).toContainText('toolsTriggered');
    // A trial's calls show their arguments; one that called nothing says so.
    await expect(dialog).toContainText('search(query: "Who handles refunds?")');
    await expect(dialog).toContainText('called no tools');
    await expect(dialog).not.toContainText('No trace recorded');
    // The answer shows without opening anything.
    await expect(
      dialog.getByText('answer to Who handles refunds?').first()
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('leaves trials that ended in an infrastructure failure out of the rates, and says so', async ({
    page,
  }) => {
    const report = await reportFor([{ name: 'flaky' }]);
    await page.goto(`file://${report}`);
    const result = page.getByRole('heading', { name: 'Result' }).locator('..');
    // 2 of 3 cases pass both trials; the third timed out both times. Rates
    // leave infrastructure failures out, and the page says so.
    await expect(result).toContainText('100%');
    await expect(result).not.toContainText('trials failed');
    await expect(result).toContainText(
      '2 trials ended in a client or infrastructure failure'
    );
    await expect(result).toContainText('Pass rates leave them out');
    await expect(result).toContainText('ETIMEDOUT');
  });

  test("keeps each variant's trials in its own column, however long their lines", async ({
    page,
  }) => {
    const report = await reportFor([{ name: 'quiet' }, { name: 'long' }]);
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`file://${report}`);
    await page.getByRole('button', { name: /^long, find-refunds: / }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('acme.grep(pattern:');
    // Side by side, neither column is wider than its share of the dialog.
    const overflow = await dialog.locator('h3').evaluateAll((headings) =>
      headings.map((heading) => {
        const column = (
          heading as unknown as {
            parentElement: { scrollWidth: number; clientWidth: number };
          }
        ).parentElement;
        return column.scrollWidth - column.clientWidth;
      })
    );
    expect(overflow).toEqual([0, 0]);
  });

  test('a single variant has the same sections, and opens on the cases that need attention', async ({
    page,
  }) => {
    // quiet calls no tools, so every case fails.
    const report = await reportFor([{ name: 'quiet' }]);
    await page.goto(`file://${report}`);
    const result = page.getByRole('heading', { name: 'Result' }).locator('..');
    await expect(result).toContainText('Pass rate, and where it likely lies');
    await expect(result).toContainText('likely 0–');
    await expect(result).toContainText('Too few trials to tell.');
    await expect(page.getByRole('heading', { name: 'Variant' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Not fully passing/, pressed: true })
    ).toBeVisible();
  });

  test('a run with too few trials never headlines a green 100%', async ({
    page,
  }) => {
    // searching passes every trial of its 3 cases.
    const report = await reportFor([{ name: 'searching' }]);
    await page.goto(`file://${report}`);
    const result = page.getByRole('heading', { name: 'Result' }).locator('..');
    const rate = result.getByText('100%', { exact: true });
    await expect(rate).toBeVisible();
    await expect(rate).not.toHaveClass(/green/);
    await expect(result).toContainText(
      // The low end, said as the weakest rate the run can't rule out.
      "All 6 trials passed, but 2 trials per case can't tell a server that always passes from one that passes 17.9% of the time."
    );
    // Three cases: no number of trials pins the rate down.
    await expect(result).toContainText(
      "More trials per case won't narrow it enough with 3 cases: add cases."
    );
    await expect(result).toContainText('36 passing trials in a row');
    // Nothing needs attention, so the grid shows every case.
    await expect(
      page.getByRole('button', { name: /^All/, pressed: true })
    ).toBeVisible();
  });
});
