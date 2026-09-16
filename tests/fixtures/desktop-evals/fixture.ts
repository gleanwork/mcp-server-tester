import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StdioMCPConfig } from '../../../src/config/mcpConfig.js';
import {
  DesktopLedgerEntrySchema,
  type DesktopLedgerEntry,
  type DesktopRecord,
  type DesktopSeed,
} from './contract.js';

export interface DesktopEvalOracle {
  runId: string;
  primary: { serverLabel: string; serverName: string };
  decoy: { serverLabel: string; serverName: string };
  direct: DesktopRecord;
  dependent: DesktopRecord;
  recovery: DesktopRecord;
}

export interface DesktopEvalFixtureOptions {
  /** Explicit absent root for retained/manual external-host fixtures. */
  rootDir?: string;
}

export interface DesktopEvalFixture {
  workspaceDir: string;
  privateDir: string;
  ledgerPath: string;
  servers: [StdioMCPConfig, StdioMCPConfig];
  oracle: DesktopEvalOracle;
  readLedger(): Promise<DesktopLedgerEntry[]>;
  waitForLedger(
    predicate: (entries: DesktopLedgerEntry[]) => boolean,
    timeoutMs?: number
  ): Promise<DesktopLedgerEntry[]>;
  /** Close all MCP clients/hosts before disposing their files. */
  dispose(): Promise<void>;
}

async function configureServer(
  privateDir: string,
  ledgerPath: string,
  seed: DesktopSeed
): Promise<StdioMCPConfig> {
  const runtimePath = join(privateDir, `${seed.serverLabel}.runtime.json`);
  await writeFile(
    runtimePath,
    JSON.stringify({ version: 1, seed, ledgerPath }),
    {
      mode: 0o600,
      flag: 'wx',
    }
  );
  return {
    transport: 'stdio',
    label: seed.serverLabel,
    command: process.execPath,
    args: [
      fileURLToPath(new URL('./server.mjs', import.meta.url)),
      runtimePath,
    ],
    cwd: privateDir,
  };
}

/** Evaluator-only factory. Pass only scenario + servers to HostDefinition.run. */
export async function createDesktopEvalFixture(
  options: DesktopEvalFixtureOptions = {}
): Promise<DesktopEvalFixture> {
  if (options.rootDir !== undefined && !isAbsolute(options.rootDir)) {
    throw new TypeError('Desktop eval fixture root must be absolute.');
  }
  const root =
    options.rootDir ?? (await mkdtemp(join(tmpdir(), 'desktop-evals-')));
  if (options.rootDir !== undefined) {
    await mkdir(root, { mode: 0o700 });
  }
  const workspaceDir = join(root, 'workspace');
  const privateDir = join(root, 'evaluator');
  try {
    await mkdir(workspaceDir, { mode: 0o700 });
    await mkdir(privateDir, { mode: 0o700 });
    const ledgerPath = join(privateDir, 'requests.jsonl');
    await writeFile(ledgerPath, '', { mode: 0o600, flag: 'wx' });
    const runId = randomUUID();
    const primary = {
      serverLabel: 'desktop_records',
      serverName: `desktop-eval-records-${runId}`,
    };
    const decoy = {
      serverLabel: 'desktop_decoy',
      serverName: `desktop-eval-decoy-${runId}`,
    };
    const direct = {
      reference: `direct-${randomUUID()}`,
      title: 'Direct release',
      verificationCode: `answer-${randomUUID()}`,
    };
    const dependent = {
      reference: `dependent-${randomUUID()}`,
      title: 'Dependent release',
      verificationCode: `answer-${randomUUID()}`,
    };
    const recovery = {
      reference: `recovery-${randomUUID()}`,
      title: 'Recovery release',
      verificationCode: `answer-${randomUUID()}`,
    };
    const records = [direct, dependent, recovery];
    const servers: DesktopEvalFixture['servers'] = [
      await configureServer(privateDir, ledgerPath, {
        runId,
        ...primary,
        records,
      }),
      await configureServer(privateDir, ledgerPath, {
        runId,
        ...decoy,
        records: records.map((record) => ({
          ...record,
          verificationCode: `decoy-${randomUUID()}`,
        })),
      }),
    ];
    return {
      workspaceDir,
      privateDir,
      ledgerPath,
      oracle: { runId, primary, decoy, direct, dependent, recovery },
      servers,
      async readLedger() {
        return readDesktopLedger(ledgerPath);
      },
      async waitForLedger(predicate, timeoutMs = 1000) {
        const deadline = Date.now() + timeoutMs;
        do {
          const entries = await readDesktopLedger(ledgerPath);
          if (predicate(entries)) return entries;
          await delay(Math.min(10, Math.max(1, deadline - Date.now())));
        } while (Date.now() < deadline);
        throw new Error('Timed out waiting for the desktop fixture ledger.');
      },
      async dispose() {
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function readDesktopLedger(path: string): Promise<DesktopLedgerEntry[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => DesktopLedgerEntrySchema.parse(JSON.parse(line)));
}
