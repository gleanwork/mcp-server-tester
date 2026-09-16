import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createCodexProfileOwner,
  leaseCodexProfile,
  prepareCodexProfile,
  saveCodexProfileOwner,
  type CodexProfile,
} from '../../../../src/evals/codex/profile.js';
import {
  installCodexFixtureConfig,
  renderCodexFixtureBlocks,
} from '../../../../src/evals/codex/fixtureConfig.js';
import type { MCPConfig } from '../../../../src/config/mcpConfig.js';

const roots: string[] = [];
const servers: MCPConfig[] = [
  {
    transport: 'stdio',
    label: 'desktop_records',
    command: '/runtime/node',
    args: ['/fixture/server.ts', '/fixture/seed.json', '/fixture/ledger.jsonl'],
    cwd: '/fixture',
  },
  {
    transport: 'stdio',
    label: 'desktop_decoy',
    command: '/runtime/node',
    args: ['/fixture/decoy.ts'],
    cwd: '/fixture',
  },
];
const fixtureConfig =
  '# Temporary owned desktop-eval MCP configuration\n' +
  '[mcp_servers.desktop_records]\n' +
  'command = "/runtime/node"\n' +
  'args = ["/fixture/server.ts","/fixture/seed.json","/fixture/ledger.jsonl"]\n' +
  'cwd = "/fixture"\n\n' +
  '[mcp_servers.desktop_decoy]\n' +
  'command = "/runtime/node"\n' +
  'args = ["/fixture/decoy.ts"]\n' +
  'cwd = "/fixture"\n';

interface ProfileFixture {
  root: string;
  profile: CodexProfile;
  configPath: string;
  lockPath: string;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it('swaps an arbitrary existing config opaquely and restores its inode, bytes, and mode', async () => {
  const fixture = await profileFixture('opaque');
  const sentinel = 'EXISTING_MCP_SECRET_SENTINEL';
  const original = Buffer.concat([
    Buffer.from(
      `[mcp_servers.private]\ncommand = "keep"\napi_key = "${sentinel}"\n`
    ),
    Buffer.from([0xff, 0x00, 0xfe, 0x0a]),
  ]);
  await writeFile(fixture.configPath, original, { mode: 0o600 });
  const before = await stat(fixture.configPath);

  const installation = await installCodexFixtureConfig(
    fixture.profile,
    servers
  );

  expect(await readFile(fixture.configPath)).toEqual(
    Buffer.from(fixtureConfig)
  );
  const stagedPath = join(fixture.lockPath, 'original.toml');
  const staged = await stat(stagedPath);
  expect(staged.ino).toBe(before.ino);
  expect(staged.mode & 0o777).toBe(0o600);
  expect(await readFile(stagedPath)).toEqual(original);
  const record = await readFile(join(fixture.lockPath, 'state.json'), 'utf8');
  expect(record).not.toContain(sentinel);
  expect(record).toMatch(/"phase":"installed"/);
  expect(record.match(/[a-f0-9]{64}/g)).toHaveLength(2);

  await installation.restore();

  const restored = await stat(fixture.configPath);
  expect(restored.ino).toBe(before.ino);
  expect(restored.mode & 0o777).toBe(0o600);
  expect(await readFile(fixture.configPath)).toEqual(original);
  await expect(lstat(fixture.lockPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('installs and removes the fixture config when no original exists', async () => {
  const fixture = await profileFixture('absent');

  const installation = await installCodexFixtureConfig(
    fixture.profile,
    servers
  );

  expect(await readFile(fixture.configPath, 'utf8')).toBe(fixtureConfig);
  const record = JSON.parse(
    await readFile(join(fixture.lockPath, 'state.json'), 'utf8')
  ) as Record<string, unknown>;
  expect(record).toMatchObject({
    phase: 'installed',
    originalPresent: false,
  });

  await installation.restore();

  await expect(lstat(fixture.configPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(lstat(fixture.lockPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it.each(['symlink', 'hardlink', 'permissive-mode', 'oversized'] as const)(
  'rejects an unsafe %s config without changing it',
  async (kind) => {
    const fixture = await profileFixture(kind);
    const sentinel = `UNSAFE_${kind}_SENTINEL`;
    let expected: Buffer;

    if (kind === 'symlink') {
      const target = join(fixture.root, 'symlink-target');
      expected = Buffer.from(sentinel);
      await writeFile(target, expected, { mode: 0o600 });
      await symlink(target, fixture.configPath);
    } else if (kind === 'hardlink') {
      const target = join(fixture.root, 'hardlink-target');
      expected = Buffer.from(sentinel);
      await writeFile(target, expected, { mode: 0o600 });
      await link(target, fixture.configPath);
    } else if (kind === 'permissive-mode') {
      expected = Buffer.from(sentinel);
      await writeFile(fixture.configPath, expected, { mode: 0o600 });
      await chmod(fixture.configPath, 0o640);
    } else {
      expected = Buffer.alloc(128 * 1024 + 1, 0x78);
      expected.set(Buffer.from(sentinel));
      await writeFile(fixture.configPath, expected, { mode: 0o600 });
    }

    const error = await rejection(
      installCodexFixtureConfig(fixture.profile, servers)
    );

    expect(error.message).not.toContain(sentinel);
    expect(await readFile(fixture.configPath)).toEqual(expected);
    await expect(lstat(fixture.lockPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
);

it('archives an app rewrite after clean exit and restores the exact original', async () => {
  const fixture = await profileFixture('changed');
  const originalSentinel = 'ORIGINAL_SECRET_SENTINEL';
  const rewrittenSentinel = 'APP_REWRITTEN_SECRET_SENTINEL';
  const original = Buffer.concat([
    Buffer.from(`[mcp_servers.private]\npassword = "${originalSentinel}"\n`),
    Buffer.from([0xff, 0x00, 0xfe, 0x0a]),
  ]);
  await writeFile(fixture.configPath, original, { mode: 0o600 });
  const before = await stat(fixture.configPath);
  const installation = await installCodexFixtureConfig(
    fixture.profile,
    servers
  );
  const transactionId = await fixtureTransactionId(fixture);
  const rewritten = Buffer.from(
    `# normalized by app\nvalue = "${rewrittenSentinel}"\n`
  );
  await writeFile(fixture.configPath, rewritten);

  await installation.restore();

  const restored = await stat(fixture.configPath);
  expect(restored.ino).toBe(before.ino);
  expect(restored.mode & 0o777).toBe(0o600);
  expect(await readFile(fixture.configPath)).toEqual(original);
  const archive = join(
    fixture.profile.root,
    '.fixture-config-history',
    transactionId
  );
  expect(await readFile(join(archive, 'temporary.toml'))).toEqual(rewritten);
  const metadata = await readFile(join(archive, 'metadata.json'), 'utf8');
  expect(metadata).not.toContain(originalSentinel);
  expect(metadata).not.toContain(rewrittenSentinel);
  expect(metadata.match(/[a-f0-9]{64}/g)).toHaveLength(2);
  await expect(lstat(fixture.lockPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('archives an app rewrite and removes config when no original existed', async () => {
  const fixture = await profileFixture('changed-absent');
  const rewrittenSentinel = 'ABSENT_REWRITTEN_SECRET_SENTINEL';
  const installation = await installCodexFixtureConfig(
    fixture.profile,
    servers
  );
  const transactionId = await fixtureTransactionId(fixture);
  const rewritten = Buffer.from(`normalized = "${rewrittenSentinel}"\n`);
  await writeFile(fixture.configPath, rewritten);

  await installation.restore();

  await expect(lstat(fixture.configPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  const archive = join(
    fixture.profile.root,
    '.fixture-config-history',
    transactionId
  );
  expect(await readFile(join(archive, 'temporary.toml'))).toEqual(rewritten);
  expect(await readFile(join(archive, 'metadata.json'), 'utf8')).not.toContain(
    rewrittenSentinel
  );
  await expect(lstat(fixture.lockPath)).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('refuses an archive collision without overwriting history or transaction files', async () => {
  const fixture = await profileFixture('archive-collision');
  const originalSentinel = 'COLLISION_ORIGINAL_SECRET_SENTINEL';
  const rewrittenSentinel = 'COLLISION_REWRITTEN_SECRET_SENTINEL';
  const original = Buffer.from(`password = "${originalSentinel}"\n`);
  const rewritten = Buffer.from(`password = "${rewrittenSentinel}"\n`);
  await writeFile(fixture.configPath, original, { mode: 0o600 });
  const installation = await installCodexFixtureConfig(
    fixture.profile,
    servers
  );
  const transactionId = await fixtureTransactionId(fixture);
  await writeFile(fixture.configPath, rewritten);
  const history = join(fixture.profile.root, '.fixture-config-history');
  const archive = join(history, transactionId);
  await mkdir(history, { mode: 0o700 });
  await mkdir(archive, { mode: 0o700 });
  const collision = Buffer.from('EXISTING_ARCHIVE_SENTINEL');
  await writeFile(join(archive, 'keep'), collision, { mode: 0o600 });

  const error = await rejection(installation.restore());

  expect(error.message).not.toContain(originalSentinel);
  expect(error.message).not.toContain(rewrittenSentinel);
  expect(await readFile(join(archive, 'keep'))).toEqual(collision);
  expect(await readFile(fixture.configPath)).toEqual(rewritten);
  expect(await readFile(join(fixture.lockPath, 'original.toml'))).toEqual(
    original
  );
  const state = await readFile(join(fixture.lockPath, 'state.json'), 'utf8');
  expect(state).not.toContain(originalSentinel);
  expect(state).not.toContain(rewrittenSentinel);
  expect((await lstat(fixture.lockPath)).isDirectory()).toBe(true);
});

it('retains the active transaction when an uncertain lifecycle never calls restore', async () => {
  const fixture = await profileFixture('uncertain-lifecycle');
  const original = Buffer.from('UNCERTAIN_ORIGINAL_SECRET_SENTINEL\n');
  const rewritten = Buffer.from('UNCERTAIN_REWRITTEN_SECRET_SENTINEL\n');
  await writeFile(fixture.configPath, original, { mode: 0o600 });
  await installCodexFixtureConfig(fixture.profile, servers);
  await writeFile(fixture.configPath, rewritten);

  expect(await readFile(fixture.configPath)).toEqual(rewritten);
  expect(await readFile(join(fixture.lockPath, 'original.toml'))).toEqual(
    original
  );
  expect((await lstat(fixture.lockPath)).isDirectory()).toBe(true);
  await expect(
    installCodexFixtureConfig(fixture.profile, servers)
  ).rejects.toThrow(/held|quarantined/i);
});

it('never reclaims a durable crash lock or changes the current config', async () => {
  const fixture = await profileFixture('crash-lock');
  const current = Buffer.from('CURRENT_CONFIG_SENTINEL\n');
  await writeFile(fixture.configPath, current, { mode: 0o600 });
  await mkdir(fixture.lockPath, { mode: 0o700 });
  await writeFile(
    join(fixture.lockPath, 'state.json'),
    JSON.stringify({ phase: 'original-staged' }),
    { mode: 0o600 }
  );

  const error = await rejection(
    installCodexFixtureConfig(fixture.profile, servers)
  );

  expect(error.message).not.toContain('CURRENT_CONFIG_SENTINEL');
  expect(await readFile(fixture.configPath)).toEqual(current);
  expect((await lstat(fixture.lockPath)).isDirectory()).toBe(true);
});

it('atomically permits only one fixture install or app lease', async () => {
  const fixture = await profileFixture('fixture-lease-race');
  let restore: (() => Promise<void>) | undefined;
  let release: (() => Promise<void>) | undefined;

  const attempts = await Promise.allSettled([
    installCodexFixtureConfig(fixture.profile, servers).then((installation) => {
      restore = () => installation.restore();
    }),
    leaseCodexProfile(fixture.profile, '/test/Codex').then((lease) => {
      release = () => lease.release('not-launched');
    }),
  ]);

  expect(
    attempts.filter((attempt) => attempt.status === 'fulfilled')
  ).toHaveLength(1);
  expect(await stateExists(join(fixture.profile.root, '.lease'))).not.toBe(
    await stateExists(fixture.lockPath)
  );
  if (restore) await restore();
  if (release) await release();
});

it('requires matching host ownership to install and restore fixture config', async () => {
  const fixture = await profileFixture('host-owner');
  const active = join(fixture.profile.root, '.host-active');
  const owner = createCodexProfileOwner(fixture.profile);
  await mkdir(active, { mode: 0o700 });
  await saveCodexProfileOwner(active, fixture.profile, owner);

  await expect(
    installCodexFixtureConfig(fixture.profile, servers)
  ).rejects.toThrow(/conflicting|quarantined/i);
  await expect(
    installCodexFixtureConfig(
      fixture.profile,
      servers,
      createCodexProfileOwner(fixture.profile)
    )
  ).rejects.toThrow(/conflicting|quarantined/i);

  const installation = await installCodexFixtureConfig(
    fixture.profile,
    servers,
    owner
  );
  await installation.restore();
  await rm(active, { recursive: true });
});

it('preflights an idle, private, canonical profile before changing config', async () => {
  const leased = await profileFixture('leased');
  await writeFile(leased.configPath, 'LEASED_SENTINEL', { mode: 0o600 });
  await mkdir(join(leased.profile.root, '.lease'), { mode: 0o700 });
  await expect(
    installCodexFixtureConfig(leased.profile, servers)
  ).rejects.toThrow(/leased|quarantined/i);
  expect(await readFile(leased.configPath, 'utf8')).toBe('LEASED_SENTINEL');

  const publicProfile = await profileFixture('public');
  await writeFile(publicProfile.configPath, 'PUBLIC_SENTINEL', { mode: 0o600 });
  await chmod(publicProfile.profile.paths.codex, 0o755);
  await expect(
    installCodexFixtureConfig(publicProfile.profile, servers)
  ).rejects.toThrow(/private|owned|canonical/i);
  expect(await readFile(publicProfile.configPath, 'utf8')).toBe(
    'PUBLIC_SENTINEL'
  );
});

it('renders exactly two explicit nonsecret stdio servers and no inherited settings', () => {
  expect(renderCodexFixtureBlocks(servers)).toBe(fixtureConfig);
  expect(fixtureConfig).not.toMatch(
    /approval_policy|sandbox_mode|model\s*=|env\s*=|authorization/i
  );
  expect(() => renderCodexFixtureBlocks(servers.slice(0, 1))).toThrow(/two/i);
  expect(() => renderCodexFixtureBlocks([...servers, servers[0]!])).toThrow(
    /two/i
  );
});

it.each([
  {
    transport: 'http',
    label: 'records',
    serverUrl: 'https://example.test/mcp',
    auth: { accessTokenEnv: 'TOKEN' },
  },
  {
    transport: 'stdio',
    label: 'records',
    command: '/runtime/node',
    env: { TOKEN: 'nonsecret-test-value' },
  },
  {
    transport: 'stdio',
    label: 'records',
    command: '/runtime/node',
    args: ['${TOKEN}'],
  },
  {
    transport: 'stdio',
    label: 'records',
    command: '/runtime/node',
    args: ['--api-key', 'nonsecret-test-value'],
  },
  {
    transport: 'stdio',
    label: 'records',
    command: '/runtime/node',
    unknown: true,
  },
])(
  'refuses auth, env references, credential arguments, and unknown config',
  (server) => {
    expect(() =>
      renderCodexFixtureBlocks([servers[0]!, server as MCPConfig])
    ).toThrow();
  }
);

async function profileFixture(name: string): Promise<ProfileFixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `codex-config-${name}-`))
  );
  roots.push(root);
  const profile = await prepareCodexProfile(join(root, 'profile'));
  return {
    root,
    profile,
    configPath: join(profile.paths.codex, 'config.toml'),
    lockPath: join(profile.root, '.fixture-config'),
  };
}

async function stateExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}

async function fixtureTransactionId(fixture: ProfileFixture): Promise<string> {
  const record = JSON.parse(
    await readFile(join(fixture.lockPath, 'state.json'), 'utf8')
  ) as Record<string, unknown>;
  expect(record.transactionId).toMatch(/^[a-f0-9-]{36}$/);
  return record.transactionId as string;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected promise to reject.');
}
