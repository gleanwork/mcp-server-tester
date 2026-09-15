import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { StdioMCPConfig } from '../../../src/config/mcpConfig.js';
import { DesktopRuntimeSchema } from './contract.js';
import type { DesktopEvalFixture } from './fixture.js';

export interface DesktopMcpbBundle {
  serverLabel: string;
  serverName: string;
  displayName: string;
  path: string;
}

/** Package the exact shared fixture runtimes for manual external-host install. */
export async function createDesktopMcpbBundles(
  fixture: DesktopEvalFixture,
  outputDir: string
): Promise<DesktopMcpbBundle[]> {
  await mkdir(outputDir, { mode: 0o700 });
  const bundles: DesktopMcpbBundle[] = [];
  try {
    for (const server of fixture.servers) {
      bundles.push(await createBundle(server, fixture.ledgerPath, outputDir));
    }
    return bundles;
  } catch (error) {
    await Promise.all(
      bundles.map((bundle) => rm(bundle.path, { force: true }).catch(() => {}))
    );
    throw error;
  }
}

async function createBundle(
  server: StdioMCPConfig,
  expectedLedgerPath: string,
  outputDir: string
): Promise<DesktopMcpbBundle> {
  const label = server.label;
  const runtimePath = server.args?.[1];
  if (
    !label ||
    server.command !== process.execPath ||
    server.args?.length !== 2 ||
    !runtimePath
  ) {
    throw new Error('Desktop MCPB packaging requires a shared fixture server.');
  }
  const runtime = DesktopRuntimeSchema.parse(
    JSON.parse(await readFile(runtimePath, 'utf8'))
  );
  if (
    runtime.seed.serverLabel !== label ||
    runtime.ledgerPath !== expectedLedgerPath
  ) {
    throw new Error('Desktop MCPB runtime provenance is invalid.');
  }

  const working = await mkdtemp(join(tmpdir(), 'desktop-eval-mcpb-'));
  await chmod(working, 0o700);
  try {
    const serverDir = join(working, 'server');
    await mkdir(serverDir, { mode: 0o700 });
    await copyFile(
      fileURLToPath(new URL('./server.mjs', import.meta.url)),
      join(serverDir, 'index.mjs')
    );
    await writePrivate(
      join(serverDir, 'runtime.json'),
      JSON.stringify(runtime)
    );
    const packageName = `mcp-server-tester-${label.replaceAll('_', '-')}-${runtime.seed.runId}`;
    const displayName = `MCP Server Tester ${label} ${runtime.seed.runId.slice(0, 8)}`;
    await writePrivate(
      join(working, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        private: true,
        type: 'module',
      })
    );
    await writePrivate(
      join(working, 'manifest.json'),
      JSON.stringify({
        manifest_version: '0.3',
        name: packageName,
        display_name: displayName,
        version: '1.0.0',
        description:
          'Temporary read-only MCP fixture for external-host evaluation.',
        author: { name: 'MCP Server Tester' },
        server: {
          type: 'node',
          entry_point: 'server/index.mjs',
          mcp_config: {
            command: 'node',
            args: [
              '${__dirname}/server/index.mjs',
              '${__dirname}/server/runtime.json',
            ],
          },
        },
        tools: [
          {
            name: 'lookup_record',
            description: 'Read a synthetic release record by exact reference.',
          },
          {
            name: 'search_records',
            description: 'Find synthetic releases by title.',
          },
        ],
        tools_generated: true,
      })
    );

    const temporaryArchive = join(working, `.${label}-${randomUUID()}.mcpb`);
    await promisify(execFile)(
      '/usr/bin/zip',
      [
        '-X',
        '-q',
        temporaryArchive,
        'manifest.json',
        'package.json',
        'server/index.mjs',
        'server/runtime.json',
      ],
      { cwd: working, env: {}, timeout: 10_000 }
    );
    await chmod(temporaryArchive, 0o600);
    const outputPath = join(outputDir, `${label}.mcpb`);
    await rename(temporaryArchive, outputPath);
    return {
      serverLabel: label,
      serverName: runtime.seed.serverName,
      displayName,
      path: outputPath,
    };
  } finally {
    await rm(working, { recursive: true, force: true });
  }
}

async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
}
