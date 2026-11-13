import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** The ChatGPT image's package picker, run as the image build runs it. */
const SCRIPT = fileURLToPath(
  new URL(
    '../../../docker/chatgpt-linux/bin/chatgpt-package.mjs',
    import.meta.url
  )
);
const REPOSITORY = 'https://packages.example.com/chatgpt/deb';

/**
 * Loaded with --import before the script: answers fetch from a fixture file,
 * so the real script runs without a network or a TLS server.
 */
const FETCH_STUB = `
import { readFileSync } from 'node:fs';
const routes = JSON.parse(readFileSync(process.env.FETCH_FIXTURES, 'utf8'));
globalThis.fetch = async (url) => {
  const route = routes[String(url)];
  if (!route) return new Response('missing', { status: 404 });
  return new Response(Buffer.from(route.body, 'base64'), { status: 200 });
};
`;

interface Package {
  version: string;
  arch?: string;
  body: string;
  /** Overrides the index's SHA-256, to model a tampered download. */
  sha256?: string;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mst-chatgpt-package-'));
  await writeFile(path.join(dir, 'fetch-stub.mjs'), FETCH_STUB);
  // The image's dpkg names the architecture the index is read for.
  await writeFile(path.join(dir, 'dpkg'), '#!/bin/sh\necho amd64\n');
  await chmod(path.join(dir, 'dpkg'), 0o755);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function serve(packages: Package[]): Promise<void> {
  const routes: Record<string, { body: string }> = {};
  const stanzas = packages.map((pkg) => {
    const arch = pkg.arch ?? 'amd64';
    const filename = `pool/main/c/chatgpt/chatgpt_${pkg.version}_${arch}.deb`;
    routes[`${REPOSITORY}/${filename}`] = {
      body: Buffer.from(pkg.body).toString('base64'),
    };
    return [
      'Package: chatgpt',
      `Version: ${pkg.version}`,
      `Architecture: ${arch}`,
      `Filename: ${filename}`,
      `Size: ${Buffer.byteLength(pkg.body)}`,
      `SHA256: ${pkg.sha256 ?? createHash('sha256').update(pkg.body).digest('hex')}`,
    ].join('\n');
  });
  // Another package in the same index is never chosen.
  stanzas.push('Package: other\nVersion: 99.0\nArchitecture: amd64');
  routes[`${REPOSITORY}/dists/stable/main/binary-amd64/Packages`] = {
    body: Buffer.from(`${stanzas.join('\n\n')}\n`).toString('base64'),
  };
  await writeFile(path.join(dir, 'routes.json'), JSON.stringify(routes));
}

async function pick(
  version: string,
  repository = REPOSITORY
): Promise<{ code: number; stdout: string; stderr: string; deb?: string }> {
  const output = path.join(dir, 'chatgpt.deb');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [
        '--import',
        path.join(dir, 'fetch-stub.mjs'),
        SCRIPT,
        repository,
        version,
        output,
      ],
      {
        timeout: 20_000,
        env: {
          PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
          FETCH_FIXTURES: path.join(dir, 'routes.json'),
        },
      },
      async (error, stdout, stderr) => {
        const deb = await readFile(output, 'utf8').catch(() => undefined);
        resolve({
          code: error ? Number(error.code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          ...(deb === undefined ? {} : { deb }),
        });
      }
    );
  });
}

describe('chatgpt-package.mjs', () => {
  it('downloads the newest version for this architecture, comparing versions numerically', async () => {
    await serve([
      { version: '26.9.1', body: 'old' },
      { version: '26.10.0', body: 'newest' },
      { version: '27.0.0', arch: 'arm64', body: 'other arch' },
    ]);
    const result = await pick('');
    expect(result.code).toBe(0);
    expect(result.deb).toBe('newest');
    expect(result.stdout).toContain('chatgpt 26.10.0 (amd64), SHA-256 ');
  });

  it('downloads a pinned version', async () => {
    await serve([
      { version: '26.9.1', body: 'pinned' },
      { version: '26.10.0', body: 'newest' },
    ]);
    const result = await pick('26.9.1');
    expect(result.code).toBe(0);
    expect(result.deb).toBe('pinned');
  });

  it('fails when the download does not match the index', async () => {
    await serve([
      { version: '26.10.0', body: 'tampered', sha256: '0'.repeat(64) },
    ]);
    const result = await pick('');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "chatgpt 26.10.0 didn't match the repository index's checksum."
    );
  });

  it('fails when the index has no such version', async () => {
    await serve([{ version: '26.10.0', body: 'newest' }]);
    const result = await pick('25.1.0');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `No chatgpt 25.1.0 for amd64 in ${REPOSITORY}.`
    );
  });

  it('refuses a repository that is not HTTPS', async () => {
    await serve([]);
    const result = await pick('', 'http://packages.example.com/chatgpt/deb');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Refusing a non-HTTPS URL');
  });
});
