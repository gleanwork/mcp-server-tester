// Offline integration smoke for the built CLI. Run after building: node scripts/test-eval-review.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-review-'));
try {
  const serverPath = path.join(dir, 'server.mjs');
  await fs.writeFile(
    serverPath,
    `import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server = new Server({name:'local-review-fixture',version:'1'}, {capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'echo',description:'Local echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}));
server.setRequestHandler(CallToolRequestSchema, async (request) => ({content:[{type:'text',text:request.params.arguments.text}]}));
await server.connect(new StdioServerTransport());`
  );
  const pluginPath = path.join(dir, 'plugin.mjs');
  await fs.writeFile(
    pluginPath,
    `import {registerMetric} from ${JSON.stringify(pathToFileURL(path.resolve('dist/index.js')).href)};
import {z} from ${JSON.stringify(import.meta.resolve('zod'))};
export function register() {registerMetric({name:'local-plugin-metric',schema:z.object({}).passthrough(),kind:'binary',compute(result){return result.pass;}});}`
  );
  const datasetPath = path.join(dir, 'dataset.json');
  await fs.writeFile(
    datasetPath,
    JSON.stringify({
      name: 'local-five',
      cases: Array.from({ length: 5 }, (_, i) => ({
        id: 'case-' + i,
        toolName: 'echo',
        args: { text: 'local success ' + i },
        expect: { containsText: 'local success' },
      })),
    })
  );
  const manifestDir = path.join(dir, 'manifests');
  await fs.mkdir(manifestDir);
  const paths = [];
  for (let i = 0; i < 4; i++) {
    const file = path.join(manifestDir, `run-${i}.json`);
    paths.push(file);
    await fs.writeFile(
      file,
      JSON.stringify({
        name: `local-${i}`,
        datasets: [datasetPath],
        servers: [
          { transport: 'stdio', command: process.execPath, args: [serverPath] },
        ],
        host: { type: 'vercel-sdk' },
        concurrency: 8,
        plugins: [pluginPath],
        metrics: ['local-plugin-metric'],
        results: { store: { type: 'file', dir: path.join(dir, `store-${i}`) } },
      })
    );
  }
  function cli(args, expected = 0) {
    const result = spawnSync(process.execPath, ['dist/cli/index.js', ...args], {
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
    return result.stdout;
  }
  const batchArgs = [
    'batch',
    '--manifest-dir',
    manifestDir,
    '--workers',
    '4',
    '--output-root',
    path.join(dir, 'batch'),
  ];
  assert.match(cli(batchArgs), /4 passed, 0 failed, 0 skipped/);
  console.log(
    'PASS: 4 concurrent manifests × 5 cases, concurrency=8, real local stdio MCP server.'
  );
  assert.match(cli([...batchArgs, '--skip-existing']), /4 skipped/);
  console.log('PASS: resume skipped four matching completed results.');
  const manifest = JSON.parse(await fs.readFile(paths[0], 'utf8'));
  manifest.model = 'changed-identity';
  await fs.writeFile(paths[0], JSON.stringify(manifest));
  assert.match(
    cli([...batchArgs, '--skip-existing']),
    /1 passed, 0 failed, 3 skipped/
  );
  console.log(
    'PASS: a changed manifest reran; three matching runs remained skipped.'
  );
  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  const legacyPath = path.join(dir, 'legacy.json');
  await fs.writeFile(
    legacyPath,
    JSON.stringify({
      ...dataset,
      cases: dataset.cases.map(({ toolName, ...item }) => ({
        ...item,
        tool: toolName,
      })),
    })
  );
  const legacyManifest = path.join(dir, 'legacy-manifest.json');
  await fs.writeFile(
    legacyManifest,
    JSON.stringify({
      ...manifest,
      name: 'legacy-adapter',
      plugins: [
        ...manifest.plugins,
        path.resolve('examples/plugins/legacy-glean-datasets.ts'),
      ],
      datasets: [
        {
          type: 'glean-legacy',
          format: 'tool-call',
          transport: { type: 'file', path: legacyPath },
        },
      ],
    })
  );
  assert.match(
    cli([
      'run',
      '--manifest',
      legacyManifest,
      '--output-dir',
      path.join(dir, 'legacy-output'),
    ]),
    /5\/5 passed/
  );
  console.log(
    'PASS: opt-in legacy source plugin converted five cases through the built CLI.'
  );
  dataset.cases[0].expect.containsText = 'deliberately impossible';
  await fs.writeFile(datasetPath, JSON.stringify(dataset));
  cli(
    ['run', '--manifest', paths[0], '--output-dir', path.join(dir, 'failure')],
    1
  );
  const summary = JSON.parse(
    await fs.readFile(path.join(dir, 'failure', 'results.json'), 'utf8')
  );
  assert.equal(summary.metrics.failed, 1);
  assert.equal(summary.metrics.passed, 4);
  assert.equal(summary.metrics['local-plugin-metric_rate'], 0.8);
  console.log('PASS: wrong assertion failed, plugin metric=0.8, CLI exit=1.');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
