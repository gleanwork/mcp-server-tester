import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostDefinition } from '../../../../src/evals/evalFrameworkTypes.js';
import { createSyntheticDesktopHost } from '../../../fixtures/desktop-evals/syntheticHost.js';
import {
  createDesktopEvalFixture,
  type DesktopEvalFixture,
} from '../../../fixtures/desktop-evals/fixture.js';
import { runSharedCodexEval } from '../../../manual/codex/run-shared.js';
import {
  caseAttemptId,
  parseSharedCodexConfig,
  writeSharedCodexConfig,
  type SharedCodexConfig,
} from '../../../manual/codex/shared-config.js';

const roots: string[] = [];
const retainedFixtures: DesktopEvalFixture[] = [];

afterEach(async () => {
  await Promise.all(
    retainedFixtures.splice(0).map((fixture) => fixture.dispose())
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('source-checkout shared Codex suite', () => {
  it('runs all cases sequentially with fresh attempts and durable ordered artifacts', async () => {
    const root = await scratchRoot();
    const config = await configFor(root, 'codex-suite-closed');
    const attempts: string[] = [];
    const ledgerWaitTimeouts: Array<number | undefined> = [];
    let fixture: DesktopEvalFixture | undefined;
    const result = await runSharedCodexEval(config, {
      async createFixture() {
        fixture = withDelayedLedgerVisibility(
          await createDesktopEvalFixture(),
          ledgerWaitTimeouts
        );
        return fixture;
      },
      createHost() {
        return checkpointingSyntheticHost(config.profilePath, attempts);
      },
    });

    expect(result).toMatchObject({
      planned: 3,
      completed: 3,
      passed: 3,
      failed: 0,
      stoppedAfterQuarantine: false,
      fixtureRetained: false,
    });
    expect(attempts).toEqual(
      result.cases.map((item, index) =>
        caseAttemptId(config.attemptId, index, item.caseId)
      )
    );
    expect(ledgerWaitTimeouts).toEqual([1000, 1000, 1000]);

    for (const { caseId, outputDir: output } of result.cases) {
      const ledger = await readFile(
        join(output, 'fixture-ledger.jsonl'),
        'utf8'
      );
      const runner = JSON.parse(
        await readFile(join(output, 'runner-result.json'), 'utf8')
      ) as Record<string, unknown>;
      const completion = JSON.parse(
        await readFile(join(output, 'completion-manifest.json'), 'utf8')
      ) as Record<string, unknown>;
      expect(ledger.trim()).not.toBe('');
      expect(runner).toMatchObject({
        caseId,
        qualification: 'structured',
        ledgerVerified: true,
        nativeResultsVerified: true,
      });
      expect(completion).toMatchObject({
        caseId,
        lifecycle: { state: 'closed', outcome: 'completed' },
        qualification: 'structured',
        passed: true,
        persistenceOrder: [
          'fixture-ledger.jsonl',
          'runner-result.json',
          'completion-manifest.json',
        ],
      });
      for (const name of [
        'fixture-ledger.jsonl',
        'runner-result.json',
        'completion-manifest.json',
      ]) {
        expect((await stat(join(output, name))).mode & 0o777).toBe(0o600);
      }
    }
    await expect(lstat(fixture!.privateDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stops later cases and retains the fixture after a quarantined lifecycle', async () => {
    const root = await scratchRoot();
    const config = await configFor(root, 'codex-suite-quarantine');
    const attempts: string[] = [];
    let fixture: DesktopEvalFixture | undefined;
    const result = await runSharedCodexEval(config, {
      async createFixture() {
        fixture = await createDesktopEvalFixture();
        retainedFixtures.push(fixture);
        return fixture;
      },
      createHost() {
        return checkpointingSyntheticHost(
          config.profilePath,
          attempts,
          'quarantined'
        );
      },
    });

    expect(result).toMatchObject({
      planned: 3,
      completed: 1,
      passed: 0,
      failed: 1,
      stoppedAfterQuarantine: true,
      fixtureRetained: true,
    });
    expect(attempts).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({
      caseId: 'direct-lookup',
      qualification: 'none',
      lifecycle: { state: 'quarantined' },
      runnerResult: { failed: 1 },
    });
    await expect(lstat(fixture!.privateDir)).resolves.toBeDefined();
    expect(await readdir(join(config.outputDir, 'cases'))).toHaveLength(1);
  });

  it('refuses a host that does not declare structured evidence', async () => {
    const root = await scratchRoot();
    const config = await configFor(root, 'codex-suite-observed');
    let fixture: DesktopEvalFixture | undefined;
    const observed: HostDefinition = {
      name: 'observed-host',
      schema: createSyntheticDesktopHost().schema,
      evidence: 'observed',
    };

    await expect(
      runSharedCodexEval(config, {
        async createFixture() {
          fixture = await createDesktopEvalFixture();
          return fixture;
        },
        createHost() {
          return observed;
        },
      })
    ).rejects.toThrow(/structured host trace/i);
    await expect(lstat(fixture!.privateDir)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('validates and writes a strict source-checkout config exclusively', async () => {
    const root = await scratchRoot();
    const config = await configFor(root, 'codex-suite-config');
    expect(parseSharedCodexConfig(config)).toEqual(config);
    expect(() => parseSharedCodexConfig({ ...config, extra: true })).toThrow();
    expect(() =>
      parseSharedCodexConfig({ ...config, outputDir: 'relative' })
    ).toThrow();

    const path = join(root, 'codex-run.json');
    await expect(writeSharedCodexConfig(path, config)).resolves.toEqual(config);
    await expect(writeSharedCodexConfig(path, config)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

function withDelayedLedgerVisibility(
  fixture: DesktopEvalFixture,
  waitTimeouts: Array<number | undefined>
): DesktopEvalFixture {
  fixture.waitForLedger = async (predicate, timeoutMs) => {
    waitTimeouts.push(timeoutMs);
    await delay(20);
    const complete = await fixture.readLedger();
    const finalEntry = complete.at(-1);
    if (finalEntry?.direction !== 'response') {
      throw new Error('Expected the delayed ledger response to be last.');
    }
    expect(predicate(complete.slice(0, -1))).toBe(false);
    expect(predicate(complete)).toBe(false);
    await delay(75);
    expect(predicate(complete)).toBe(true);
    return complete;
  };
  return fixture;
}

function checkpointingSyntheticHost(
  profilePath: string,
  attempts: string[],
  firstState: 'closed' | 'quarantined' = 'closed'
): HostDefinition {
  const synthetic = createSyntheticDesktopHost();
  return {
    name: 'codex-desktop-first',
    schema: synthetic.schema,
    evidence: 'structured',
    async run(input, rawConfig, context) {
      const config = rawConfig as Record<string, unknown>;
      const attemptId = string(config.attemptId);
      const outputDir = string(config.outputDir);
      attempts.push(attemptId);
      const trace = await synthetic.run!(
        input,
        { type: synthetic.name },
        context
      );
      const state = attempts.length === 1 ? firstState : 'closed';
      const checkpointDir = join(profilePath, '.host-attempts', attemptId);
      await mkdir(checkpointDir, { recursive: true, mode: 0o700 });
      await writeFile(
        join(checkpointDir, 'checkpoint.json'),
        JSON.stringify({
          version: 1,
          attemptId,
          outputDir,
          state,
          outcome: 'completed',
        }),
        { flag: 'wx', mode: 0o600 }
      );
      return trace;
    },
  };
}

async function scratchRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'codex-shared-test-'))
  );
  roots.push(root);
  return root;
}

async function configFor(
  root: string,
  attemptId: string
): Promise<SharedCodexConfig> {
  const profilePath = join(root, 'profile');
  await mkdir(profilePath, { mode: 0o700 });
  return parseSharedCodexConfig({
    attemptId,
    executablePath: join(root, 'Codex'),
    profilePath,
    outputDir: join(root, 'output'),
  });
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string config.');
  return value;
}
