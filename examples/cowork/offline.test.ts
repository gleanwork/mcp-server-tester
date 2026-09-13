import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkConfig, FIXTURE_LABEL, parseConfig, SCENARIO } from './config.js';
import { createPrivateDirectory, writePrivateJson } from './files.js';
import { finishRuntime } from './lifecycle.js';
import { prepareFixture } from './prepare.js';

async function scratch(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), 'cowork-offline-'));
  try {
    await chmod(path, 0o700);
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

function validConfig(path: string) {
  return {
    runtimePath: '/test/cua-driver',
    dataDir: '/test/local-agent-mode-sessions',
    outputDir: join(path, 'results'),
    evaluatorFile: join(path, 'evaluator.json'),
    servers: [
      {
        transport: 'stdio',
        label: FIXTURE_LABEL,
        command: 'node',
        args: ['/test/installed/server/index.js'],
      },
    ],
    mcpServerPrefixes: { mcp__Verified_Fixture__: FIXTURE_LABEL },
  };
}

function cli(args: string[]) {
  return spawnSync(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'cli.js'), ...args],
    { encoding: 'utf8', timeout: 10_000 }
  );
}

void test('builder creates fresh private bundles; read-only server responds deterministically', async () => {
  await scratch(async (path) => {
    const first = join(path, 'first');
    const second = join(path, 'second');
    await prepareFixture(first);
    await prepareFixture(second);
    const evaluator = JSON.parse(
      await readFile(join(first, 'evaluator.json'), 'utf8')
    ) as { expectedText: string; bundleSha256: string };
    const other = JSON.parse(
      await readFile(join(second, 'evaluator.json'), 'utf8')
    ) as { expectedText: string };
    assert.notEqual(evaluator.expectedText, other.expectedText);
    assert.equal(SCENARIO.includes(evaluator.expectedText), false);
    assert.equal(
      (await readFile(join(first, 'run.json'), 'utf8')).includes(
        evaluator.expectedText
      ),
      false
    );
    const bundle = await readFile(join(first, 'fixture.mcpb'));
    assert.equal(
      createHash('sha256').update(bundle).digest('hex'),
      evaluator.bundleSha256
    );
    assert.equal((await stat(first)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(first, 'evaluator.json'))).mode & 0o777,
      0o600
    );
    assert.equal((await stat(join(first, 'fixture.mcpb'))).mode & 0o777, 0o600);
    await assert.rejects(prepareFixture(first), /EEXIST/);

    const entries = [
      'manifest.json',
      'package.json',
      'server/index.js',
      'server/nonce.json',
    ];
    const listing = spawnSync(
      '/usr/bin/unzip',
      ['-Z1', join(first, 'fixture.mcpb')],
      {
        encoding: 'utf8',
        timeout: 10_000,
      }
    );
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split('\n'), entries);
    const extracted = join(path, 'extracted');
    await createPrivateDirectory(extracted);
    const unzip = spawnSync(
      '/usr/bin/unzip',
      ['-q', join(first, 'fixture.mcpb'), '-d', extracted],
      { encoding: 'utf8', timeout: 10_000 }
    );
    assert.equal(unzip.status, 0, unzip.stderr);
    for (const name of entries) {
      assert.equal((await stat(join(extracted, name))).mode & 0o777, 0o600);
      if (name === 'server/nonce.json') continue;
      const data = await readFile(join(extracted, name));
      assert.deepEqual(
        data,
        await readFile(join('tests/fixtures/cowork-mcpb', name))
      );
      assert.equal(data.includes(evaluator.expectedText), false);
    }
    assert.deepEqual(
      JSON.parse(await readFile(join(extracted, 'server/nonce.json'), 'utf8')),
      { nonce: evaluator.expectedText }
    );
    const requests = [
      {
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      },
      { id: 2, method: 'tools/list' },
      {
        id: 3,
        method: 'tools/call',
        params: { name: 'get_eval_nonce', arguments: {} },
      },
      { id: 4, method: 'tools/call', params: { name: 'get_eval_nonce' } },
      {
        id: 5,
        method: 'tools/call',
        params: { name: 'get_eval_nonce', arguments: { unexpected: true } },
      },
      { id: 6, method: 'tools/call', params: { name: 'unknown_tool' } },
      { id: 7, method: 'ping' },
    ];
    const server = spawnSync(
      process.execPath,
      [join(extracted, 'server/index.js')],
      {
        input:
          [
            'not json',
            'null',
            ...requests.map((request) =>
              JSON.stringify({ jsonrpc: '2.0', ...request })
            ),
          ].join('\n') + '\n',
        encoding: 'utf8',
        timeout: 10_000,
        env: {},
      }
    );
    assert.equal(server.status, 0, server.stderr);
    const replies = server.stdout
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            id: number;
            result?: unknown;
            error?: { code: number };
          }
      );
    assert.deepEqual(
      replies.map((reply) => reply.id),
      [1, 2, 3, 4, 5, 6, 7]
    );
    assert.equal(
      JSON.stringify(replies[1]).includes(evaluator.expectedText),
      false
    );
    assert.deepEqual(replies[2]?.result, {
      content: [{ type: 'text', text: evaluator.expectedText }],
      structuredContent: { nonce: evaluator.expectedText },
    });
    assert.deepEqual(replies[3]?.result, replies[2]?.result);
    assert.equal(replies[4]?.error?.code, -32602);
    assert.equal(replies[5]?.error?.code, -32602);
    assert.deepEqual(replies[6]?.result, {});
  });
});

void test('strict config rejects placeholders, overrides, extra servers, and bad prefixes', () => {
  const config = validConfig('/test');
  assert.doesNotThrow(() => parseConfig(config));
  assert.throws(() => parseConfig({ ...config, runtimePath: 'relative' }));
  assert.throws(() =>
    parseConfig({ ...config, runtimePath: '/REPLACE_ME/cua' })
  );
  assert.throws(() => parseConfig({ ...config, expectedText: 'leaked' }));
  assert.throws(() =>
    parseConfig({ ...config, servers: [...config.servers, ...config.servers] })
  );
  assert.throws(() =>
    parseConfig({
      ...config,
      servers: [{ ...config.servers[0], env: { TOKEN: 'not-allowed' } }],
    })
  );
  assert.throws(() =>
    parseConfig({ ...config, mcpServerPrefixes: { bad: FIXTURE_LABEL } })
  );
});

void test('CLI prepare/check are offline; reused output and armed fixture cannot run', async () => {
  await scratch(async (path) => {
    const setup = join(path, 'setup');
    assert.equal(cli(['--help']).status, 0);
    assert.equal(cli(['unknown']).status, 1);
    const prepared = cli(['prepare', setup]);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(cli(['prepare', setup]).status, 1);
    assert.equal(cli(['check', join(setup, 'run.json')]).status, 1);
    const config = validConfig(setup);
    await writeFile(join(setup, 'run.json'), JSON.stringify(config));
    const checked = cli(['check', join(setup, 'run.json')]);
    assert.equal(checked.status, 0, checked.stderr);
    await createPrivateDirectory(config.outputDir);
    await assert.rejects(checkConfig(join(setup, 'run.json')), /existing path/);
    await writePrivateJson(join(setup, 'armed.json'), { status: 'armed' });
    await assert.rejects(
      writePrivateJson(join(setup, 'armed.json'), { overwritten: true }),
      /EEXIST/
    );
    const next = { ...config, outputDir: join(setup, 'different-results') };
    await writeFile(join(setup, 'run.json'), JSON.stringify(next));
    await assert.rejects(checkConfig(join(setup, 'run.json')), /armed.json/);
  });
});

void test('checksum mismatch refuses the evaluator/bundle pair', async () => {
  await scratch(async (path) => {
    const setup = join(path, 'setup');
    await prepareFixture(setup);
    await writeFile(
      join(setup, 'run.json'),
      JSON.stringify(validConfig(setup))
    );
    await writeFile(join(setup, 'fixture.mcpb'), 'changed');
    await assert.rejects(
      checkConfig(join(setup, 'run.json')),
      /does not match/
    );
  });
});

void test('quarantine skips close; close refusal returns a diagnostic outcome', async () => {
  let calls = 0;
  const cua = {
    async close() {
      calls++;
    },
  };
  assert.deepEqual(await finishRuntime(cua, true), {
    runtimeRetained: true,
    reason: 'host-quarantined',
  });
  assert.equal(calls, 0);
  assert.deepEqual(await finishRuntime(cua, false), {
    runtimeRetained: false,
    reason: 'closed',
  });
  assert.equal(calls, 1);
  const refusal = await finishRuntime(
    {
      async close() {
        throw new Error('pending RPC');
      },
    },
    false
  );
  assert.deepEqual(refusal, {
    runtimeRetained: true,
    reason: 'close-refused-or-failed',
    closeError: 'pending RPC',
  });
});
