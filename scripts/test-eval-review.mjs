// Offline integration smoke for the built CLI. Run after building: node scripts/test-eval-review.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-review-'));
try {
  const serverPath = path.join(dir, 'server.mjs');
  await fs.writeFile(
    serverPath,
    `import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
import { z } from ${JSON.stringify(import.meta.resolve('zod'))};
const server = new McpServer({name:'local-review-fixture',version:'1'});
server.registerTool('echo', {description:'Local echo', inputSchema: z.object({text: z.string()})}, async ({text}) => ({content:[{type:'text',text}]}));
await server.connect(new StdioServerTransport());`
  );
  const pluginPath = path.join(dir, 'plugin.mjs');
  await fs.writeFile(
    pluginPath,
    `import {z} from ${JSON.stringify(import.meta.resolve('zod'))};
import {Client} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/client'))};
import {StdioClientTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/client/stdio'))};
// A deterministic client: it connects to the real server, calls echo with the
// case's input, and answers with the tool's text.
const echo = {schema:z.object({}).passthrough(),evidence:'structured',async run(input){
  const server = input.servers[0];
  const client = new Client({name:'local-echo',version:'1'});
  await client.connect(new StdioClientTransport({command:server.command,args:server.args??[]}));
  try {
    const args = {text: input.prompt};
    const result = await client.callTool({name:'echo',arguments:args});
    return {finalText: result.content.map((block) => block.text ?? '').join(''), events:[{kind:'tool_call',source:'mcp',name:'echo',arguments:args}]};
  } finally { await client.close(); }
}};
export default {meta:{name:'local-plugin',version:'1.0.0',namespace:'local'},clients:{echo},metrics:{'plugin-metric':{schema:z.object({}).passthrough(),kind:'binary',compute(result){return result.pass;}}}};`
  );
  const datasetPath = path.join(dir, 'dataset.json');
  await fs.writeFile(
    datasetPath,
    JSON.stringify({
      name: 'local-five',
      cases: Array.from({ length: 5 }, (_, i) => ({
        id: 'case-' + i,
        input: 'local success ' + i,
        assertions: {
          containsText: 'local success',
          toolsTriggered: { calls: [{ name: 'echo', required: true }] },
        },
      })),
    })
  );
  const configDir = path.join(dir, 'eval configs');
  await fs.mkdir(configDir);
  const paths = [];
  for (let i = 0; i < 4; i++) {
    const file = path.join(configDir, `run-${i}.json`);
    paths.push(file);
    await fs.writeFile(
      file,
      JSON.stringify({
        name: `local-${i}`,
        datasets: [datasetPath],
        servers: [
          { transport: 'stdio', command: process.execPath, args: [serverPath] },
        ],
        client: 'local/client/echo',
        concurrency: 8,
        plugins: [pluginPath],
        metrics: ['local/metric/plugin-metric'],
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
    '--config-dir',
    configDir,
    '--workers',
    '4',
    '--output-root',
    path.join(dir, 'batch'),
  ];
  assert.match(cli(batchArgs), /4 passed, 0 failed, 0 skipped/);
  console.log(
    'PASS: 4 concurrent eval configs × 5 cases, concurrency=8, real local stdio MCP server.'
  );
  assert.match(cli([...batchArgs, '--skip-existing']), /4 skipped/);
  console.log('PASS: resume skipped four matching completed results.');
  const evalConfig = JSON.parse(await fs.readFile(paths[0], 'utf8'));
  evalConfig.model = 'changed-identity';
  await fs.writeFile(paths[0], JSON.stringify(evalConfig));
  assert.match(
    cli([...batchArgs, '--skip-existing']),
    /1 passed, 0 failed, 3 skipped/
  );
  console.log(
    'PASS: a changed eval config reran; three matching runs remained skipped.'
  );
  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  dataset.cases[0].assertions.containsText = 'deliberately impossible';
  await fs.writeFile(datasetPath, JSON.stringify(dataset));
  const failedRun = cli(
    ['run', '--config', paths[0], '--output-dir', path.join(dir, 'failure')],
    1
  );
  const summaryPath = /^Output: (.+)$/m.exec(failedRun)?.[1];
  assert.ok(summaryPath, 'CLI must print the unique execution result path');
  const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'));
  assert.equal(summary.metrics.failed, 1);
  assert.equal(summary.metrics.passed, 4);
  assert.equal(summary.metrics['local/metric/plugin-metric_rate'], 0.8);
  console.log('PASS: wrong assertion failed, plugin metric=0.8, CLI exit=1.');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
