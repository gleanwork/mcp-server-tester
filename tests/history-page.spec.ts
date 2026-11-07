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
});

test('hides a variant from every chart', async ({ page: tab }) => {
  await tab.goto(page());
  await tab.getByRole('button', { name: /glean-plus/ }).click();
  await expect(tab.locator('figure').first().locator('a')).toHaveCount(10);
});
