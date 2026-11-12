import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONFIG,
  OVERRIDES,
  PYTHON,
  VENV,
  harnessDirectory,
  parseClientOptions,
  planVerifiersRun,
  runVerifiersPlan,
} from './run.js';

const mstCommand = ['/usr/bin/node', '/mst/dist/cli/index.js'];

function tasksetDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mst-taskset-'));
  writeFileSync(
    path.join(dir, 'pyproject.toml'),
    '[project]\nname = "acme-tasks"\n'
  );
  return dir;
}

describe('planVerifiersRun', () => {
  it('runs the taskset on the bundled mst-harness, locally, with this MST', () => {
    const dir = tasksetDir();
    const harnessDir = '/mst/python/mst-harness';
    const plan = planVerifiersRun(
      dir,
      { model: 'claude-sonnet-4-6' },
      { harnessDir, mstCommand }
    );
    expect(plan.config).toEqual({
      model: 'claude-sonnet-4-6',
      push: false,
      harness: {
        id: 'mst-harness',
        client: 'api',
        api: 'anthropic',
        mst_command: mstCommand,
        runtime: { type: 'subprocess' },
      },
      client: {
        type: 'eval',
        base_url: 'https://api.anthropic.com',
        api_key_var: 'ANTHROPIC_API_KEY',
      },
      interception: { type: 'server' },
    });
    expect(plan.steps).toEqual([
      { command: 'uv', args: ['venv', '--quiet', '--python', '3.12', VENV] },
      {
        command: 'uv',
        args: [
          'pip',
          'install',
          '--quiet',
          '--python',
          PYTHON,
          '--overrides',
          OVERRIDES,
          harnessDir,
          dir,
        ],
      },
      {
        command: PYTHON,
        args: ['-m', 'mst_harness.eval', dir, '@', CONFIG],
      },
    ]);
    // The bundled harness wins over any mst-harness source the taskset names.
    expect(plan.overrides).toEqual([
      `mst-harness @ ${pathToFileURL(harnessDir).href}`,
    ]);
    expect(plan.apiKeyVar).toBe('ANTHROPIC_API_KEY');
  });

  it('gives codex-cli the OpenAI API, and takes the endpoint and options it is given', () => {
    const plan = planVerifiersRun(
      tasksetDir(),
      {
        model: 'gpt-5',
        client: 'codex-cli',
        baseUrl: 'https://gateway.example/v1',
        apiKeyVar: 'GATEWAY_KEY',
        clientOption: ['timeout=300000', 'sandbox=workspace-write'],
        workdir: ['answer'],
        numTasks: '2',
        rollouts: '3',
        concurrency: '4',
        verifiersArgs: ['--sampling.reasoning_effort', 'low'],
      },
      { harnessDir: '/h', mstCommand }
    );
    expect(plan.config).toMatchObject({
      harness: {
        client: 'codex-cli',
        api: 'openai',
        client_options: { timeout: 300000, sandbox: 'workspace-write' },
        workdir: ['answer'],
      },
      client: {
        base_url: 'https://gateway.example/v1',
        api_key_var: 'GATEWAY_KEY',
      },
      num_tasks: 2,
      num_rollouts: 3,
      max_concurrent: 4,
    });
    expect(plan.steps.at(-1)?.args.slice(-2)).toEqual([
      '--sampling.reasoning_effort',
      'low',
    ]);
  });

  it('passes a name that is not a directory through as a taskset id', () => {
    const plan = planVerifiersRun(
      'acme-tasks',
      { model: 'm' },
      { cwd: tmpdir(), harnessDir: '/h', mstCommand }
    );
    expect(plan.taskset).toBe('acme-tasks');
    expect(plan.steps[1]?.args.at(-1)).toBe('acme-tasks');
  });

  it('rejects a directory that is not a Python package', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mst-not-taskset-'));
    expect(() =>
      planVerifiersRun(dir, { model: 'm' }, { harnessDir: '/h', mstCommand })
    ).toThrow(/no pyproject.toml/);
  });

  it('rejects an unknown API family and a bad count', () => {
    const dir = tasksetDir();
    expect(() =>
      planVerifiersRun(
        dir,
        { model: 'm', api: 'gemini' },
        { harnessDir: '/h', mstCommand }
      )
    ).toThrow(/anthropic or openai/);
    expect(() =>
      planVerifiersRun(
        dir,
        { model: 'm', rollouts: '0' },
        { harnessDir: '/h', mstCommand }
      )
    ).toThrow(/--rollouts takes a whole number/);
  });
});

describe('parseClientOptions', () => {
  it('parses JSON values and keeps other values as strings', () => {
    expect(parseClientOptions(['timeout=5', 'flag=true', 'name=a=b'])).toEqual({
      timeout: 5,
      flag: true,
      name: 'a=b',
    });
  });

  it('rejects a flag without a key or given twice', () => {
    expect(() => parseClientOptions(['=x'])).toThrow(/key=value/);
    expect(() => parseClientOptions(['a=1', 'a=2'])).toThrow(/given twice/);
  });
});

describe('harnessDirectory', () => {
  it('is the mst-harness package in this checkout', () => {
    expect(existsSync(path.join(harnessDirectory(), 'pyproject.toml'))).toBe(
      true
    );
  });
});

describe('runVerifiersPlan', () => {
  interface Seen {
    steps: string[][];
    overrides?: string;
    config?: string;
    body?: unknown;
  }

  /**
   * A uv that records each call: `venv` creates a Python that records its call and
   * the config it was given, then exits with `pythonExit`.
   */
  function fakeUv(pythonExit: number): { uv: string; seen: () => Seen } {
    const dir = mkdtempSync(path.join(tmpdir(), 'mst-fake-uv-'));
    const record = path.join(dir, 'record.json');
    writeFileSync(record, JSON.stringify({ steps: [] }));
    const python = `#!/usr/bin/env node
const fs = require('node:fs');
const seen = JSON.parse(fs.readFileSync(${JSON.stringify(record)}, 'utf8'));
const args = process.argv.slice(2);
seen.steps.push(['python', ...args]);
seen.config = args[args.indexOf('@') + 1];
seen.body = JSON.parse(fs.readFileSync(seen.config, 'utf8'));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(seen));
process.exit(${pythonExit});
`;
    const uv = path.join(dir, 'uv');
    writeFileSync(
      uv,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const seen = JSON.parse(fs.readFileSync(${JSON.stringify(record)}, 'utf8'));
const args = process.argv.slice(2);
seen.steps.push(['uv', ...args]);
if (args[0] === 'venv') {
  const bin = path.join(args.at(-1), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'python'), ${JSON.stringify(python)}, { mode: 0o755 });
}
if (args[0] === 'pip') seen.overrides = fs.readFileSync(args[args.indexOf('--overrides') + 1], 'utf8');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(seen));
`
    );
    chmodSync(uv, 0o755);
    return {
      uv,
      seen: () => JSON.parse(readFileSync(record, 'utf8')) as Seen,
    };
  }

  const plan = () =>
    planVerifiersRun(
      tasksetDir(),
      { model: 'm' },
      { harnessDir: '/h', mstCommand }
    );
  const env = { ...process.env, ANTHROPIC_API_KEY: 'k' };

  it.skipIf(process.platform === 'win32')(
    'creates the venv, installs with the overrides, runs the eval with the config, and cleans up',
    async () => {
      const { uv, seen } = fakeUv(3);
      const p = plan();
      expect(await runVerifiersPlan(p, { uv, env })).toBe(3);
      const record = seen();
      expect(record.steps.map((step) => step.slice(0, 2))).toEqual([
        ['uv', 'venv'],
        ['uv', 'pip'],
        ['python', '-m'],
      ]);
      expect(record.overrides).toBe(`${p.overrides.join('\n')}\n`);
      expect(record.body).toEqual(p.config);
      expect(
        record.steps
          .flat()
          .some((arg) => arg.startsWith('{') && arg.endsWith('}'))
      ).toBe(false);
      expect(existsSync(path.dirname(record.config!))).toBe(false);
    }
  );

  it('fails before starting uv when the key is not set', async () => {
    const withoutKey = { ...process.env };
    delete withoutKey.ANTHROPIC_API_KEY;
    await expect(
      runVerifiersPlan(plan(), { uv: '/nonexistent', env: withoutKey })
    ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it('says how to get uv when it is missing', async () => {
    await expect(
      runVerifiersPlan(plan(), { uv: '/nonexistent/uv', env })
    ).rejects.toThrow(/needs uv/);
  });
});
