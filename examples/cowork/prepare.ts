import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FIXTURE_LABEL } from './config.js';
import {
  createPrivateDirectory,
  writePrivateFile,
  writePrivateJson,
} from './files.js';

export async function createFixtureArchive(
  nonce: string,
  fixtureDir = resolve('tests/fixtures/cowork-mcpb')
): Promise<Buffer> {
  if (!/^MCP_E2E_NONCE_[a-f0-9]{64}$/.test(nonce))
    throw new Error('Invalid fixture nonce');
  const directory = await mkdtemp(join(tmpdir(), 'cowork-fixture-'));
  try {
    await chmod(directory, 0o700);
    await createPrivateDirectory(join(directory, 'server'));
    const sources = ['manifest.json', 'package.json', 'server/index.js'];
    for (const name of sources) {
      await writePrivateFile(
        join(directory, name),
        await readFile(join(fixtureDir, name))
      );
    }
    await writePrivateJson(join(directory, 'server/nonce.json'), { nonce });
    // Ignore ambient ZIPOPT settings; include only the explicit fixture files.
    await promisify(execFile)(
      '/usr/bin/zip',
      ['-X', '-q', 'fixture.mcpb', ...sources, 'server/nonce.json'],
      { cwd: directory, env: {}, timeout: 10_000 }
    );
    const archive = join(directory, 'fixture.mcpb');
    await chmod(archive, 0o600);
    return await readFile(archive);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareFixture(outputDir: string): Promise<void> {
  if (!isAbsolute(outputDir))
    throw new Error('prepare requires an absolute, unused directory path');
  const expectedText = `MCP_E2E_NONCE_${randomBytes(32).toString('hex')}`;
  const bundle = await createFixtureArchive(expectedText);
  await createPrivateDirectory(outputDir);
  await writePrivateFile(join(outputDir, 'fixture.mcpb'), bundle);
  await writePrivateJson(join(outputDir, 'evaluator.json'), {
    version: 1,
    expectedText,
    bundleSha256: createHash('sha256').update(bundle).digest('hex'),
  });
  await writePrivateJson(join(outputDir, 'run.json'), {
    runtimePath: '/REPLACE_ME/cua-driver',
    dataDir: '/REPLACE_ME/Claude/local-agent-mode-sessions',
    outputDir: join(outputDir, 'results'),
    evaluatorFile: join(outputDir, 'evaluator.json'),
    servers: [
      {
        transport: 'stdio',
        label: FIXTURE_LABEL,
        command: 'node',
        args: ['/REPLACE_ME/installed-extension/server/index.js'],
      },
    ],
    mcpServerPrefixes: { mcp__REPLACE_ME__: FIXTURE_LABEL },
  });
}
