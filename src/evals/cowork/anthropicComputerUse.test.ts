import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  ComputerUseHitlBudgetError,
  runAnthropicComputerUseHitl,
  runAnthropicComputerUseSubmission,
} from './anthropicComputerUse.js';

it('passes an explicit planner model over the legacy environment default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cu-model-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
  await writeFile(
    join(directory, 'scripts/cowork_computer_use.py'),
    `console.log(JSON.stringify({status:'submitted',model:process.env.MST_COWORK_CUA_MODEL}));`
  );
  const result = await runAnthropicComputerUseSubmission('query', {
    deadlineAt: Date.now() + 10000,
    model: 'configured-planner',
    env: {
      MST_COWORK_DRIVER_ROOT: directory,
      MST_COWORK_PYTHON: process.execPath,
      MST_COWORK_CUA_MODEL: 'legacy-planner',
    },
  });
  expect(result.model).toBe('configured-planner');
});

it.each(['budget', 'action-error', 'submit'] as const)(
  'classifies only an explicit HITL budget result: %s',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'cu-result-'));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'scripts'));
    await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
    const error =
      kind === 'action-error'
        ? 'HITL key action failed'
        : 'Computer Use HITL check exceeded 12 actions after attempting a visible prompt';
    await writeFile(
      join(directory, 'scripts/cowork_computer_use.py'),
      `console.log(${JSON.stringify(JSON.stringify({ status: 'failed', error }))}); process.exit(1);`
    );
    const options = {
      deadlineAt: Date.now() + 10000,
      env: {
        MST_COWORK_DRIVER_ROOT: directory,
        MST_COWORK_PYTHON: process.execPath,
      },
    };
    const result =
      kind === 'submit'
        ? runAnthropicComputerUseSubmission('query', options)
        : runAnthropicComputerUseHitl(options);
    if (kind === 'budget')
      await expect(result).rejects.toBeInstanceOf(ComputerUseHitlBudgetError);
    else
      await expect(result).rejects.not.toBeInstanceOf(
        ComputerUseHitlBudgetError
      );
  }
);
