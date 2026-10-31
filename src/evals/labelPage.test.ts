import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import { defaultSplit, readLabels } from './labels.js';
import { labelKey } from './judgedItems.js';
import {
  isLabelPageHost,
  startLabelPage,
  type LabelPageServer,
} from './labelPage.js';
import { labelPageHtml } from './labelPageHtml.js';
import { labelPage } from '../cli/commands/label/index.js';

const dirs: string[] = [];
const servers: LabelPageServer[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** A client whose trials call a search tool, a keyword judge, and a pairwise judge. */
const plugin: Plugin = {
  meta: { name: 'label-page-test-plugin', namespace: 'lp' },
  clients: {
    scripted: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      async run(input, _config, context) {
        const better = context.variant?.name === 'better';
        const long = context.variant?.name === 'long';
        return {
          finalText: long
            ? `${input.prompt}: ${'the certificate expired. '.repeat(250)}`
            : better
              ? `${input.prompt}: the certificate expired`
              : `${input.prompt}: a deploy failed`,
          events: [
            {
              kind: 'tool_call',
              source: 'mcp',
              name: 'search',
              server: 'docs',
              arguments: { query: input.prompt },
              isError: false,
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
        };
      },
    },
  },
  judges: {
    keyword: {
      schema: z.object({ keyword: z.string() }).strict(),
      async evaluate({ trial }, judgeOptions) {
        return {
          score: trial.text?.includes(String(judgeOptions.keyword)) ? 1 : 0,
          reasoning: 'SECRET-REASONING',
        };
      },
    },
  },
  pairwiseJudges: {
    longer: {
      schema: z.object({}).strict(),
      async compare({ baseline, candidate }) {
        return {
          preference:
            (candidate.text?.length ?? 0) > (baseline.text?.length ?? 0)
              ? ('candidate' as const)
              : ('tie' as const),
          reasoning: 'SECRET-REASONING',
        };
      },
    },
  },
};

/**
 * A stored run: two variants and two cases, two trials each, graded by the
 * keyword judge and the pairwise judge.
 */
async function storedRun(
  options: {
    redact?: boolean;
    /** List the keyword judge twice, so each trial has two of its verdicts. */
    twice?: boolean;
    /** The candidate variant's answers are longer than the report shows. */
    long?: boolean;
  } = {}
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-label-page-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'dataset.json'),
    JSON.stringify({
      name: 'outages',
      cases: [
        {
          id: 'cause',
          input: 'Why did checkout fail',
          expected: { answer: 'An expired certificate' },
        },
        { id: 'duration', input: 'How long was checkout down' },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'label-page-test',
      datasets: ['./dataset.json'],
      client: 'lp/client/scripted',
      trials: 2,
      redactStoredResponses: options.redact ?? false,
      servers: { docs: { transport: 'stdio', command: 'docs-server' } },
      judges: [
        { type: 'lp/judge/keyword', keyword: 'certificate' },
        ...(options.twice
          ? [{ type: 'lp/judge/keyword', keyword: 'expired' }]
          : []),
      ],
      pairwiseJudges: ['lp/pairwise-judge/longer'],
      variants: [
        { name: 'baseline', servers: ['docs'] },
        { name: options.long ? 'long' : 'better', servers: ['docs'] },
      ],
    })
  );
  const result = await runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
    report: false,
  });
  return { dir, directory: result.outputDir };
}

async function start(
  directory: string,
  judge = 'lp/judge/keyword',
  extra: { split?: 'dev' | 'test'; labeler?: string } = {}
) {
  const server = await startLabelPage({
    directory,
    judge,
    labeler: 'ada',
    ...extra,
  });
  servers.push(server);
  return server;
}

/** A raw request, so a test can set the Host header. */
function request(
  url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function post(server: LabelPageServer, body: unknown) {
  return fetch(new URL('api/label', server.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('the label page', () => {
  it("shows each trial's input, reference, calls and answer, without the verdict or the variant", async () => {
    const t = await storedRun();
    const server = await start(t.directory);
    const response = await fetch(new URL('api/items', server.url));
    const text = await response.text();
    const data = JSON.parse(text) as typeof server.data;
    expect(data.kind).toBe('pointwise');
    expect(data.items).toHaveLength(8);
    const cause = data.items.find((item) => item.caseId === 'cause')!;
    expect(cause).toMatchObject({
      input: 'Why did checkout fail',
      reference: 'An expired certificate',
      trace: {
        traced: true,
        events: [{ kind: 'tool_call', name: 'search', server: 'docs' }],
      },
    });
    expect(cause.trace!.answer).toMatch(/^Why did checkout fail: /);
    // Nothing that gives the verdict or the variant away.
    expect(text).not.toContain('SECRET-REASONING');
    expect(text).not.toMatch(/"(pass|score|scores|verdict|variant)"/);
    expect(text).not.toContain('better');
    // Variants are mixed, in an order that doesn't change between starts.
    const again = await start(t.directory);
    expect(again.data.items.map((item) => [item.caseId, item.trial])).toEqual(
      data.items.map((item) => [item.caseId, item.trial])
    );
  });

  it('stores a label as an import would, and a label given again replaces it', async () => {
    const t = await storedRun();
    const server = await start(t.directory);
    const first = server.data.items[0]!;
    const saved = await post(server, {
      id: first.id,
      label: 'fail',
      note: 'vague',
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ label: 'fail', split: first.split });
    let labels = await readLabels(t.directory);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      judge: 'lp/judge/keyword',
      caseId: first.caseId,
      trial: first.trial,
      label: 'fail',
      split: first.split,
      labeler: 'ada',
      note: 'vague',
    });
    expect(['baseline', 'better']).toContain(labels[0]!.variant);

    await post(server, { id: first.id, label: 'pass' });
    labels = await readLabels(t.directory);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ label: 'pass' });
    expect(labels[0]!.note).toBeUndefined();
    expect(server.written()).toBe(2);

    // The page shows stored labels when it starts again.
    const again = await start(t.directory);
    const shown = again.data.items.find(
      (item) => item.caseId === first.caseId && item.trial === first.trial
    );
    expect(again.data.items[0]).toMatchObject({ label: 'pass' });
    expect(shown).toBeDefined();
  });

  it("puts a case's labels in one split: its labels' split, then --split, then the default", async () => {
    const t = await storedRun();
    // Both cases' own split is dev.
    expect([defaultSplit('cause'), defaultSplit('duration')]).toEqual([
      'dev',
      'dev',
    ]);
    const test = await start(t.directory, 'lp/judge/keyword', {
      split: 'test',
    });
    expect(test.data.items.every((item) => item.split === 'test')).toBe(true);
    const first = test.data.items[0]!;
    await post(test, { id: 0, label: 'pass' });
    expect((await readLabels(t.directory)).map((label) => label.split)).toEqual(
      ['test']
    );

    // A later session puts the case's other trials and variants in test
    // too, whatever its --split; other cases take --split, or the default.
    for (const split of ['dev', undefined] as const) {
      const later = await start(
        t.directory,
        'lp/judge/keyword',
        split ? { split } : {}
      );
      for (const item of later.data.items)
        expect(item.split).toBe(item.caseId === first.caseId ? 'test' : 'dev');
    }
    const dev = await start(t.directory, 'lp/judge/keyword', { split: 'dev' });
    for (const item of dev.data.items)
      await post(dev, { id: item.id, label: 'fail' });
    const labels = await readLabels(t.directory);
    expect(labels).toHaveLength(8);
    for (const label of labels)
      expect(label.split).toBe(label.caseId === first.caseId ? 'test' : 'dev');
  });

  it("rejects a label the judge can't give, an unknown item, and a body that isn't JSON", async () => {
    const t = await storedRun();
    const server = await start(t.directory);
    const wrong = await post(server, { id: 0, label: 'candidate' });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('candidate'),
    });
    expect((await post(server, { id: 99, label: 'pass' })).status).toBe(404);
    const text = await fetch(new URL('api/label', server.url), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"id":0,"label":"pass"}',
    });
    expect(text.status).toBe(415);
    expect(await readLabels(t.directory)).toEqual([]);
  });

  it('answers only on its own path and host', async () => {
    const t = await storedRun();
    const server = await start(t.directory);
    const url = new URL(server.url);
    expect(
      (await request(`http://127.0.0.1:${url.port}/api/items`, {})).status
    ).toBe(404);
    const rebound = await request(new URL('api/items', server.url).href, {
      headers: { host: `attacker.example:${url.port}` },
    });
    expect(rebound.status).toBe(403);
    const page = await fetch(server.url);
    expect(page.headers.get('content-security-policy')).toContain(
      "default-src 'none'"
    );
    expect(await page.text()).toContain('<script>');
  });

  it('shows a trial once when its judge gave it two verdicts, which share one label', async () => {
    const t = await storedRun({ twice: true });
    const server = await start(t.directory);
    expect(server.data.items).toHaveLength(8);
    const keys = server.data.items.map((item) => [item.caseId, item.trial]);
    // Two variants, so each case and trial comes twice: once per variant.
    expect(new Set(keys.map((key) => key.join('/'))).size).toBe(4);
  });

  it('shows both sides of a pairwise case with their whole answers', async () => {
    const t = await storedRun({ long: true });
    const server = await start(t.directory, 'lp/pairwise-judge/longer');
    const answers = server.data.items[0]!.sides!.map(
      (side) => side.trial.answer ?? ''
    );
    expect(Math.max(...answers.map((answer) => answer.length))).toBeGreaterThan(
      6000
    );
    expect(answers.join('')).not.toContain('more characters');
  });

  it('labels a pairwise judge: both sides, as A and B, with baseline, candidate or tie', async () => {
    const t = await storedRun();
    const server = await start(t.directory, 'lp/pairwise-judge/longer');
    expect(server.data.kind).toBe('pairwise');
    expect(server.data.items).toHaveLength(2);
    const item = server.data.items[0]!;
    expect(item.trial).toBeUndefined();
    expect(item.sides!.map((side) => side.label).sort()).toEqual([
      'baseline',
      'candidate',
    ]);
    // Each side shows the trial the judge compared: the last one.
    for (const side of item.sides!)
      expect(side).toMatchObject({ trialIndex: 1, trialCount: 2 });
    expect(item.sides![0].trial.answer).toMatch(/^(Why|How)/);
    await post(server, { id: item.id, label: item.sides![0].label });
    const [label] = await readLabels(t.directory);
    expect(label).toMatchObject({
      baseline: 'baseline',
      variant: 'better',
      caseId: item.caseId,
      label: item.sides![0].label,
    });
    expect((await post(server, { id: item.id, label: 'pass' })).status).toBe(
      400
    );
    await post(server, { id: item.id, label: 'tie' });
    expect(await readLabels(t.directory)).toMatchObject([{ label: 'tie' }]);
  });

  it('takes requests only for its own address, with or without a default port', () => {
    expect(isLabelPageHost('127.0.0.1:4100', 4100)).toBe(true);
    expect(isLabelPageHost('localhost:4100', 4100)).toBe(true);
    expect(isLabelPageHost('127.0.0.1', 4100)).toBe(false);
    expect(isLabelPageHost('evil.test:4100', 4100)).toBe(false);
    expect(isLabelPageHost(undefined, 4100)).toBe(false);
    // A browser leaves port 80 out of Host.
    expect(isLabelPageHost('127.0.0.1', 80)).toBe(true);
    expect(isLabelPageHost('localhost:80', 80)).toBe(true);
    expect(isLabelPageHost('evil.test', 80)).toBe(false);
  });

  it('mixes the variants, rather than showing one and then the other', async () => {
    const t = await storedRun();
    const server = await start(t.directory);
    const variants: string[] = [];
    for (const item of server.data.items) {
      const before = new Set(
        (await readLabels(t.directory)).map((label) => labelKey(label))
      );
      await post(server, { id: item.id, label: 'pass' });
      const added = (await readLabels(t.directory)).find(
        (label) => !before.has(labelKey(label))
      );
      variants.push(added!.variant);
    }
    expect(variants.filter((v) => v === 'baseline')).toHaveLength(4);
    // Grouped, the variant would change once.
    const changes = variants.filter((v, i) => i > 0 && v !== variants[i - 1]);
    expect(changes.length).toBeGreaterThan(1);
  });

  it("refuses a run that redacts stored responses, and a judge the run doesn't have", async () => {
    const redacted = await storedRun({ redact: true });
    await expect(start(redacted.directory)).rejects.toThrow(
      /redacts stored responses.*"redactStoredResponses": false/
    );
    const t = await storedRun();
    await expect(start(t.directory, 'correctness')).rejects.toThrow(
      /no verdicts from correctness; its judges are lp\/judge\/keyword, lp\/pairwise-judge\/longer/
    );
  });

  it('the command prints the address, opens it unless --no-open, and checks its options', async () => {
    const t = await storedRun();
    const out: string[] = [];
    const opened: string[] = [];
    const server = await labelPage(
      t.directory,
      { judge: 'lp/judge/keyword' },
      (text) => void out.push(text),
      async (url) => void opened.push(url)
    );
    servers.push(server);
    expect(opened).toEqual([server.url]);
    expect(out.join('')).toContain('8 verdicts, 0 labeled');
    expect(out.join('')).toContain(server.url);
    const quiet = await labelPage(
      t.directory,
      { judge: 'lp/judge/keyword', open: false },
      () => {},
      async (url) => void opened.push(url)
    );
    servers.push(quiet);
    expect(opened).toHaveLength(1);
    await expect(labelPage(t.directory, {})).rejects.toThrow(/--judge/);
    await expect(
      labelPage(t.directory, { judge: 'lp/judge/keyword', split: 'train' })
    ).rejects.toThrow(/--split train/);
    await expect(
      labelPage(t.directory, { judge: 'lp/judge/keyword', port: 'x' })
    ).rejects.toThrow(/--port x/);
  });

  it('mst label serves until Ctrl+C, then says how many labels it stored', async () => {
    const t = await storedRun();
    const bin = fileURLToPath(
      new URL('../../dist/cli/index.js', import.meta.url)
    );
    const child = spawn(
      process.execPath,
      [bin, 'label', t.directory, '--judge', 'lp/judge/keyword', '--no-open'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code))
    );
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setInterval(() => {
          const match = /http:\/\/127\.0\.0\.1:\d+\/[\w-]+\//.exec(stdout);
          if (match) {
            clearInterval(timer);
            resolve(match[0]);
          } else if (child.exitCode !== null) {
            clearInterval(timer);
            reject(new Error(`mst label exited: ${stderr}`));
          }
        }, 20);
      });
      const saved = await fetch(new URL('api/label', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 0, label: 'pass' }),
      });
      expect(saved.status).toBe(200);
      child.kill('SIGINT');
      expect(await exited).toBe(0);
      expect(stdout).toContain('8 verdicts, 0 labeled');
      expect(stdout).toContain('Stored 1 label.');
      expect(await readLabels(t.directory)).toHaveLength(1);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('serves a page whose script parses and writes values as text, not HTML', () => {
    const html = labelPageHtml();
    const script = html.slice(
      html.indexOf('<script>') + '<script>'.length,
      html.indexOf('</script>')
    );
    // Compiles it without running it.
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).not.toContain('innerHTML');
  });
});
