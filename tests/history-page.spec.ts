/**
 * The history page in a browser: six weekly runs of a scripted eval
 * (tests/mocks/weeklyHistory.ts), then the eval's history/index.html opened
 * from file:// and read like a person would.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { weeklyRuns } from './mocks/weeklyHistory.js';
import {
  caseChanges,
  isPoint,
} from '../src/reporters/ui-src/components/History/historyData.js';
import type { HistoryIndex } from '../src/types/history.js';
import { open } from '../src/cli/commands/open/index.js';

let evalDirectory: string;
let root: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-history-spec-'));
  evalDirectory = await weeklyRuns(root);
});

test.afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const page = () =>
  `file://${path.join(evalDirectory, 'history', 'index.html')}`;

test('shows each metric over the runs, a line per variant, and where the era starts', async ({
  page: tab,
}) => {
  const errors: string[] = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.goto(page());
  await expect(tab.getByRole('heading', { name: 'weekly-mcp' })).toBeVisible();
  // Five full runs on the lines; the partial run is in the table only.
  await expect(tab.getByText(/History: 5 runs/)).toBeVisible();
  await expect(tab.getByText(/2 eras/)).toBeVisible();
  for (const title of [
    'Pass rate',
    'Cases passed',
    'Judge: quality',
    'Win rate: prefer vs official',
    'Cost per trial',
    'Tokens per trial',
    'Trial time',
    'Infrastructure failures',
  ])
    await expect(
      tab.locator('figcaption').getByText(title, { exact: true })
    ).toBeVisible();
  const passRate = tab.locator('figure').first();
  // 3 variants × 5 runs, each point a link to its run's report.
  await expect(passRate.locator('a')).toHaveCount(15);
  await expect(passRate.getByText('new era', { exact: true })).toBeVisible();
  await expect(
    tab
      .locator('section[aria-labelledby="history-eras-h"]')
      .getByText(/judge changed: preview\/judge\/quality/)
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('a point says its run and value, and opens its report', async ({
  page: tab,
}) => {
  await tab.goto(page());
  const point = tab.locator('figure').first().locator('a').first();
  await point.hover();
  const tooltip = tab.getByRole('tooltip');
  await expect(tooltip).toContainText('official');
  await expect(tooltip).toContainText(/likely \d/);
  await point.click();
  await expect(tab).toHaveURL(
    /\/runs\/20261005T090000Z-[0-9a-f]{6}\/report\/index\.html$/
  );
  // The report links back to the history.
  await tab.getByRole('link', { name: 'History' }).click();
  await expect(tab).toHaveURL(/\/history\/index\.html$/);
});

test('lists the runs newest first, with the partial run marked', async ({
  page: tab,
}) => {
  await tab.goto(page());
  const rows = tab.locator(
    'section[aria-labelledby="history-runs-h"] tbody tr'
  );
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(1)).toContainText('partial');
  await expect(rows.nth(2)).toContainText('judge changed');
  await expect(rows.nth(3)).toContainText('client app Claude 2.31104.0');
});

test('lists the cases whose verdict changed between two runs', async ({
  page: tab,
}) => {
  await tab.goto(page());
  const panel = tab.locator('section[aria-labelledby="history-cases-h"]');
  // Latest against the run it was compared with: both in the second era.
  await expect(panel.getByText(/now failing/).first()).toBeVisible();
  await expect(panel.getByText(/different eras/)).toHaveCount(0);
  // Across the era's start, it says so.
  const from = panel.getByLabel('From');
  const options = await from.locator('option').allTextContents();
  await from.selectOption({ index: options.length - 1 });
  await expect(panel.getByText(/different eras/)).toBeVisible();
  // The first run against the latest, each variant's changed cases listed.
  const index = JSON.parse(
    await fs.readFile(path.join(evalDirectory, 'history.json'), 'utf8')
  ) as HistoryIndex;
  const runs = index.runs.filter(isPoint);
  const [latest, first] = [runs[0]!, runs[runs.length - 1]!];
  await expect(from).toHaveValue(first.runId);
  await expect(panel.getByLabel('To')).toHaveValue(latest.runId);
  const changes = caseChanges(first, latest);
  expect(
    changes.flatMap((c) => [...c.nowFailing, ...c.nowPassing]).length
  ).toBeGreaterThan(0);
  for (const change of changes) {
    const card = panel.locator('div.border', {
      has: tab.locator('span.font-semibold', {
        hasText: new RegExp(`^${change.variant}$`),
      }),
    });
    await expect(card).toContainText(
      `${change.nowFailing.length} now failing · ${change.nowPassing.length} now passing`
    );
    await expect(card.locator('li')).toHaveCount(
      change.nowFailing.length + change.nowPassing.length
    );
    for (const row of [...change.nowFailing, ...change.nowPassing])
      await expect(card.locator('li', { hasText: row.id })).toContainText(
        `${row.before[0]}/${row.before[1]} → ${row.after[0]}/${row.after[1]} trials`
      );
  }
});

test('mst open gives a report from before the history page its link', async () => {
  const runs = (await fs.readdir(path.join(evalDirectory, 'runs'))).sort();
  const data = path.join(evalDirectory, 'runs', runs[1]!, 'report', 'data.js');
  const read = async () =>
    JSON.parse(
      (await fs.readFile(data, 'utf8'))
        .replace(/^window\.MST_RUN_REPORT = /, '')
        .replace(/;\s*$/, '')
    ) as { run: { historyPath?: string; datasets: Array<{ name: string }> } };
  const report = await read();
  expect(report.run.historyPath).toBe('../../../history/index.html');
  // A report written before MST wrote history pages, of a dataset whose
  // name happens to be the field's.
  delete report.run.historyPath;
  report.run.datasets[0]!.name = 'historyPath';
  await fs.writeFile(
    data,
    `window.MST_RUN_REPORT = ${JSON.stringify(report)};\n`,
    'utf8'
  );
  await open(path.join(evalDirectory, 'runs', runs[1]!), { print: true });
  expect((await read()).run.historyPath).toBe('../../../history/index.html');
  // Once it has the link, opening it doesn't write it again.
  const { mtimeMs } = await fs.stat(data);
  await open(path.join(evalDirectory, 'runs', runs[1]!), { print: true });
  expect((await fs.stat(data)).mtimeMs).toBe(mtimeMs);
});

test('hides a variant from every chart', async ({ page: tab }) => {
  await tab.goto(page());
  const point = (name: string) => `a[aria-label^="${name}, run "]`;
  const points = (name: string) => tab.locator(`figure ${point(name)}`);
  await expect(tab.locator('figure').first().locator('a')).toHaveCount(15);
  // It's on several charts, so hiding it from the first only would fail.
  expect(
    await tab
      .locator('figure', { has: tab.locator(point('glean-plus')) })
      .count()
  ).toBeGreaterThan(1);
  const others = await points('official').count();
  await tab.getByRole('button', { name: /glean-plus/ }).click();
  await expect(points('glean-plus')).toHaveCount(0);
  await expect(points('official')).toHaveCount(others);
});
