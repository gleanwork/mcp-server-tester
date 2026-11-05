import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetPluginsForTests } from '../plugins/extensions.js';
import { resumeRun, runEval } from './runEval.js';
import { readRunTrials } from './runFormat.js';
import { resumeCollects } from './trialEnding.js';

const dirs: string[] = [];
const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe('retained settings-group results through evaluation and resume', () => {
  it.each([
    { setting: 'model', failure: 'open-unavailable' },
    { setting: 'model', failure: 'open-error' },
    { setting: 'model', failure: 'run-error' },
    { setting: 'clientOptions', failure: 'open-unavailable' },
    { setting: 'clientOptions', failure: 'open-error' },
    { setting: 'clientOptions', failure: 'run-error' },
  ])(
    'keeps finalized results when a later $setting group has $failure',
    async ({ setting, failure }) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rootDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'mst-retained-groups-')
      );
      dirs.push(rootDir);
      const actionsFile = path.join(rootDir, 'actions.txt');
      const configPath = path.join(rootDir, 'eval.json');
      // Completed requests are noncontiguous in the original batch, with two
      // trials each. A third group must not open after the second one fails.
      const cases = [
        { id: 'a', group: 'a' },
        { id: 'b', group: 'b' },
        { id: 'c', group: 'a' },
        { id: 'd', group: 'b' },
        { id: 'e', group: 'c' },
      ];
      await fs.writeFile(
        path.join(rootDir, 'cases.json'),
        JSON.stringify({
          name: 'groups',
          cases: cases.map(({ id, group }) => ({
            id,
            input: `prompt:${id}`,
            trials: 2,
            assertions: { containsText: `COMPLETED:${id}:` },
            ...(setting === 'model'
              ? { model: group }
              : { clientOptions: { setting: group } }),
          })),
        })
      );
      await fs.writeFile(
        configPath,
        JSON.stringify({
          name: 'retained-groups',
          plugins: [
            mock('settingsGroupClientPlugin.ts'),
            mock('forkEnvPlugin.ts'),
          ],
          client: 'settings-group/client/session',
          model: 'a',
          clientOptions: {
            failure,
            actionsFile,
            failureMarker: path.join(rootDir, 'failed.txt'),
          },
          datasets: ['./cases.json'],
          servers: {},
          redactStoredResponses: false,
        })
      );
      const options = {
        configPath,
        rootDir,
        outputDir: path.join(rootDir, 'out'),
        settingsFile: false as const,
        report: false,
      };
      const result = await runEval(options);
      expect(
        (await fs.readFile(actionsFile, 'utf8')).trim().split('\n')
      ).toEqual([
        'open:a',
        'run:a:0',
        'run:a:1',
        'run:c:0',
        'run:c:1',
        'close:a',
        'open:b',
        ...(failure === 'run-error' ? ['run:b:0', 'close:b'] : []),
      ]);
      const trials = await readRunTrials(result.outputDir);
      expect(trials).toHaveLength(10);
      const completed = trials.filter((trial) =>
        ['a', 'c'].includes(trial.caseId)
      );
      expect(completed).toHaveLength(4);
      for (const trial of completed) {
        expect(trial).toMatchObject({
          ending: { kind: 'trial' },
          infrastructureError: false,
          trace: {
            finalText: `COMPLETED:${trial.caseId}:${trial.trial}`,
            events: [
              {
                kind: 'tool_call',
                name: 'example',
                arguments: { caseId: trial.caseId, trial: trial.trial },
                output: `answer:${trial.caseId}:${trial.trial}`,
              },
            ],
            usage: { inputTokens: 5, outputTokens: 1, durationMs: 2 },
          },
          clientTelemetry: { batchLifecycle: { closed: true, group: 'a' } },
        });
        expect(resumeCollects(trial)).toBe(false);
      }
      const unfinished = trials.filter(resumeCollects);
      expect(
        unfinished.map(({ caseId, trial }) => `${caseId}:${trial}`).sort()
      ).toEqual(['b:0', 'b:1', 'd:0', 'd:1', 'e:0', 'e:1']);
      for (const trial of unfinished) {
        expect(trial).toMatchObject({
          infrastructureError: true,
          trace: { finalText: '', events: [] },
          clientDiagnostics: {
            failureKind:
              failure === 'run-error' &&
              trial.caseId === 'b' &&
              trial.trial === 0
                ? 'process'
                : 'not-submitted',
          },
        });
        expect(trial.error).toContain('second settings group unavailable');
      }
      expect(result.summary.metrics).toMatchObject({
        passed: 2,
        failed: 0,
        incomplete: 3,
      });

      // Resume uses a real worker, not a mocked helper or a resume predicate.
      const beforeResume = await fs.readFile(actionsFile, 'utf8');
      const resumed = await resumeRun({
        ...options,
        run: result.outputDir,
        env: 'fork/env/children',
        envOptions: { shards: '1' },
      });
      expect(resumed.outputDir).toBe(result.outputDir);
      const resumedActions = (await fs.readFile(actionsFile, 'utf8'))
        .slice(beforeResume.length)
        .trim()
        .split('\n');
      expect(resumedActions).toEqual([
        'open:b',
        'run:b:0',
        'run:b:1',
        'run:d:0',
        'run:d:1',
        'close:b',
        'open:c',
        'run:e:0',
        'run:e:1',
        'close:c',
      ]);
      const resumedTrials = await readRunTrials(resumed.outputDir);
      expect(resumedTrials.filter(resumeCollects)).toEqual([]);
      for (const trial of completed) {
        const retained = resumedTrials.find(
          (candidate) =>
            candidate.caseId === trial.caseId && candidate.trial === trial.trial
        );
        expect(retained?.trace).toEqual(trial.trace);
        expect(retained?.clientTelemetry).toEqual(trial.clientTelemetry);
      }
      expect(resumed.summary.metrics).toMatchObject({ passed: 5, failed: 0 });
      expect(resumed.summary.metrics.incomplete ?? 0).toBe(0);
    },
    60_000
  );
});
