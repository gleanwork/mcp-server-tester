import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { prepareCoworkApplication } from '@gleanwork/mcp-server-tester';
import { DesktopRuntimeSchema } from '../../fixtures/desktop-evals/contract.js';
import { writePrivateJson } from './files.js';
import { SharedCoworkConfigSchema } from './sharedConfig.js';

const TemplateSchema = z
  .object({
    executablePath: z.string().refine(isAbsolute),
    profilePath: z.string().refine(isAbsolute),
    fixtureRoot: z.string().refine(isAbsolute),
    outputDir: z.string().refine(isAbsolute),
  })
  .passthrough();
const ManifestSchema = z
  .object({
    name: z.string(),
    display_name: z.string(),
    server: z.object({
      mcp_config: z.object({
        command: z.literal('node'),
        args: z.tuple([
          z.literal('${__dirname}/server/index.mjs'),
          z.literal('${__dirname}/server/runtime.json'),
        ]),
      }),
    }),
  })
  .passthrough();
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** Discover only the two known fixture installs inside the dedicated profile. */
export async function configureSharedCowork(
  templatePath: string,
  runtimePath: string,
  attemptId: string
): Promise<string> {
  if (!isAbsolute(runtimePath))
    throw new TypeError('Cua runtime path must be absolute.');
  if (!/^cowork-shared-[a-z0-9-]+$/.test(attemptId))
    throw new TypeError('A unique Cowork shared attempt ID is required.');
  await access(runtimePath, constants.X_OK);
  const template = TemplateSchema.parse(
    JSON.parse(await readFile(templatePath, 'utf8'))
  );
  const application = await prepareCoworkApplication({
    executablePath: template.executablePath,
    profilePath: template.profilePath,
  });
  const extensionRoot = join(application.userDataPath, 'Claude Extensions');
  const settingsRoot = join(
    application.userDataPath,
    'Claude Extensions Settings'
  );
  const expectedRuntimes = new Map(
    await Promise.all(
      ['desktop_records', 'desktop_decoy'].map(async (label) => {
        const path = join(
          template.fixtureRoot,
          'evaluator',
          `${label}.runtime.json`
        );
        const bytes = await readFile(path);
        const runtime = DesktopRuntimeSchema.parse(
          JSON.parse(bytes.toString('utf8'))
        );
        return [label, { bytes, runtime }] as const;
      })
    )
  );
  const installations = await readdir(extensionRoot, { withFileTypes: true });
  const servers = [];
  const approvalServers = [];
  const prefixes: Record<string, 'desktop_records' | 'desktop_decoy'> = {};
  for (const label of ['desktop_records', 'desktop_decoy'] as const) {
    const expected = expectedRuntimes.get(label)!;
    const token = label.replaceAll('_', '-');
    const candidates = installations.filter(
      (entry) =>
        entry.isDirectory() &&
        matchesFixtureInstallation(
          entry.name,
          token,
          expected.runtime.seed.runId
        )
    );
    if (candidates.length !== 1) {
      throw new Error(`Expected one isolated ${label} extension installation.`);
    }
    const installed = join(extensionRoot, candidates[0]!.name);
    const manifest = ManifestSchema.parse(
      JSON.parse(await readFile(join(installed, 'manifest.json'), 'utf8'))
    );
    if (!manifest.name.endsWith(expected.runtime.seed.runId)) {
      throw new Error('Installed fixture manifest provenance is invalid.');
    }
    const installedRuntimePath = join(installed, 'server', 'runtime.json');
    const installedRuntimeBytes = await readFile(installedRuntimePath);
    DesktopRuntimeSchema.parse(
      JSON.parse(installedRuntimeBytes.toString('utf8'))
    );
    if (
      !matchesExactFixtureBytes(installedRuntimeBytes, expected.bytes) ||
      !matchesExactFixtureBytes(
        await readFile(join(installed, 'server', 'index.mjs')),
        await readFile(
          fileURLToPath(
            new URL('../../fixtures/desktop-evals/server.mjs', import.meta.url)
          )
        )
      )
    ) {
      throw new Error(
        'Installed fixture bytes do not match the evaluator fixture.'
      );
    }
    const settings = JSON.parse(
      await readFile(join(settingsRoot, `${candidates[0]!.name}.json`), 'utf8')
    ) as { isEnabled?: unknown };
    if (settings.isEnabled !== true) {
      throw new Error('Installed fixture is not enabled.');
    }
    servers.push({
      transport: 'stdio' as const,
      label,
      command: manifest.server.mcp_config.command,
      args: [join(installed, 'server', 'index.mjs'), installedRuntimePath] as [
        string,
        string,
      ],
    });
    approvalServers.push({
      label,
      displayName: manifest.display_name,
    });
    prefixes[`mcp__${sanitize(manifest.display_name)}__`] = label;
  }
  const dataDir = await accountSessionDirectory(
    application.userDataPath,
    application.profile.paths.root
  );
  const ready = SharedCoworkConfigSchema.parse({
    ...template,
    attemptId,
    runtimePath,
    dataDir,
    outputDir: join(template.fixtureRoot, `results-${attemptId}`),
    servers,
    approvalServers,
    mcpServerPrefixes: prefixes,
  });
  const readyPath = join(dirname(templatePath), `${attemptId}.json`);
  await writePrivateJson(readyPath, ready);
  return readyPath;
}

async function accountSessionDirectory(
  userDataPath: string,
  profileRoot: string
): Promise<string> {
  const root = join(userDataPath, 'local-agent-mode-sessions');
  const accounts = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && uuid.test(entry.name)
  );
  if (accounts.length !== 1) {
    throw new Error('Expected one isolated Cowork account directory.');
  }
  const account = join(root, accounts[0]!.name);
  const organizations = (
    await readdir(account, { withFileTypes: true })
  ).filter((entry) => entry.isDirectory() && uuid.test(entry.name));
  if (organizations.length !== 1) {
    throw new Error('Expected one isolated Cowork organization directory.');
  }
  const resolved = join(account, organizations[0]!.name);
  return assertSharedCoworkDataDir(resolved, userDataPath, profileRoot);
}

/** Bind configured session storage to the prepared application's exact profile. */
export async function assertSharedCoworkDataDir(
  dataDir: string,
  userDataPath: string,
  profileRoot: string
): Promise<string> {
  const canonicalProfile = await canonicalDirectory(profileRoot);
  const canonicalUserData = await canonicalDirectory(userDataPath);
  const canonicalDataDir = await canonicalDirectory(dataDir);
  if (!isDescendant(canonicalUserData, canonicalProfile)) {
    throw new Error('Cowork user data escaped the prepared profile root.');
  }
  if (!isDescendant(canonicalDataDir, canonicalUserData)) {
    throw new Error('Cowork session data escaped the prepared user-data root.');
  }
  const parts = relative(canonicalUserData, canonicalDataDir).split(sep);
  if (
    parts.length !== 3 ||
    parts[0] !== 'local-agent-mode-sessions' ||
    !uuid.test(parts[1] ?? '') ||
    !uuid.test(parts[2] ?? '')
  ) {
    throw new Error('Invalid isolated Cowork account storage.');
  }
  return canonicalDataDir;
}

export function matchesExactFixtureBytes(
  installed: Uint8Array,
  expected: Uint8Array
): boolean {
  return Buffer.from(installed).equals(Buffer.from(expected));
}

export function matchesFixtureInstallation(
  name: string,
  labelToken: string,
  runId: string
): boolean {
  return (
    name.includes(`mcp-server-tester-${labelToken}-`) && name.endsWith(runId)
  );
}

async function canonicalDirectory(path: string): Promise<string> {
  if (path !== resolve(path)) {
    throw new Error('Cowork storage path must use canonical absolute syntax.');
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Cowork storage path must be a real directory.');
  }
  const canonical = await realpath(path);
  if (canonical !== path) {
    throw new Error('Cowork storage path must not traverse symbolic links.');
  }
  return canonical;
}

function isDescendant(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return (
    remainder.length > 0 &&
    remainder !== '..' &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
