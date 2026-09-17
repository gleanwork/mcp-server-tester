import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  ComputerUseDriverError,
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
    `console.log(JSON.stringify({status:'submitted',action_count:2,submission_action:{action:'key',text:'enter'},model:process.env.MST_COWORK_CUA_MODEL}));`
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

function telemetry() {
  return {
    accounting: 'complete',
    response_models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
    planner_response_count: 2,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 40,
    },
    usage_observation_counts: {
      input_tokens: 2,
      output_tokens: 2,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
    },
    duration_ms: 12.5,
    action_count: 3,
    attempted_action_count: 2,
    executed_action_count: 2,
    refused_action_count: 1,
    cost: { status: 'unavailable' },
  };
}

async function driverOptions(record: unknown, exitCode = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'cu-telemetry-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'scripts'));
  await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
  await writeFile(
    join(directory, 'scripts/cowork_computer_use.py'),
    `console.log(${JSON.stringify(JSON.stringify(record))}); process.exit(${exitCode});`
  );
  return {
    deadlineAt: Date.now() + 10000,
    env: {
      MST_COWORK_DRIVER_ROOT: directory,
      MST_COWORK_PYTHON: process.execPath,
      ANTHROPIC_API_KEY: 'private-api-key',
    },
  };
}

it.each(['submit', 'hitl'] as const)(
  'returns allowlisted telemetry for %s',
  async (mode) => {
    const options = await driverOptions({
      status: mode === 'submit' ? 'submitted' : 'hitl_checked',
      action_count: 3,
      model: 'configured-planner',
      submission_action: {
        action: 'key',
        text: 'enter',
        prompt: 'private prompt',
      },
      telemetry: {
        ...telemetry(),
        prompt: 'private prompt',
        screenshot: 'private image',
        usage: { ...telemetry().usage, secret: 'private-api-key' },
        cost: { status: 'available', dollars: 12345 },
      },
      provider_response: { secret: 'private-api-key' },
    });
    const result =
      mode === 'submit'
        ? await runAnthropicComputerUseSubmission('private prompt', options)
        : await runAnthropicComputerUseHitl(options);
    expect(result.telemetry).toEqual(telemetry());
    expect(JSON.stringify(result)).not.toMatch(
      /private|provider_response|12345/
    );
  }
);

it.each([
  { accounting: ['complete'] },
  { duration_ms: -1 },
  { duration_ms: '10' },
  { duration_ms: Infinity },
  { planner_response_count: NaN },
  { action_count: true },
  { executed_action_count: -1 },
  { attempted_action_count: 1.5 },
  { refused_action_count: 5 },
  { usage: { input_tokens: '100' } },
  { usage: { ...telemetry().usage, cache_read_input_tokens: -1 } },
  {
    usage_observation_counts: {
      ...telemetry().usage_observation_counts,
      input_tokens: 3,
    },
  },
  { response_models: ['private-api-key'] },
  { response_models: ['claude-private-api-key'] },
  { response_models: ['claude-sonnet-4-6\nprivate prompt'] },
])('omits invalid telemetry without coercion: %j', async (invalid) => {
  const options = await driverOptions({
    status: 'hitl_checked',
    action_count: 3,
    model: 'configured-planner',
    telemetry: { ...telemetry(), ...invalid },
  });
  const result = await runAnthropicComputerUseHitl(options);
  expect(result.telemetry).toBeUndefined();
});

it.each(['budget', 'provider'] as const)(
  'attaches safe partial accounting on %s errors',
  async (kind) => {
    const options = await driverOptions(
      {
        status: 'failed',
        telemetry: telemetry(),
        error:
          kind === 'budget'
            ? 'Computer Use HITL check exceeded 12 actions after attempting a visible prompt'
            : 'private prompt private-api-key provider content',
      },
      1
    );
    try {
      await runAnthropicComputerUseHitl(options);
      throw new Error('Expected driver failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerUseDriverError);
      if (kind === 'budget')
        expect(error).toBeInstanceOf(ComputerUseHitlBudgetError);
      expect((error as ComputerUseDriverError).telemetry).toEqual({
        ...telemetry(),
        accounting: 'partial',
      });
      expect(String(error)).not.toMatch(/private|provider content/);
    }
  }
);

it.each([-1, '2', null, 1.5])(
  'rejects invalid result action count: %j',
  async (action_count) => {
    const options = await driverOptions({
      status: 'hitl_checked',
      action_count,
      model: 'configured-planner',
    });
    await expect(runAnthropicComputerUseHitl(options)).rejects.toThrow(
      'invalid result fields'
    );
  }
);

it('does not invent accounting when a failed process has no telemetry', async () => {
  const options = await driverOptions(
    { status: 'failed', error: 'private prompt' },
    1
  );
  await expect(runAnthropicComputerUseHitl(options)).rejects.toMatchObject({
    telemetry: undefined,
  });
});

it('keeps the deadline guard before starting the driver', async () => {
  await expect(
    runAnthropicComputerUseSubmission('private prompt', {
      deadlineAt: Date.now() - 1,
      env: { MST_COWORK_PYTHON: '/nonexistent/python' },
    })
  ).rejects.toThrow('submission deadline exceeded; not retrying');
});

it('keeps hard process timeout bounded and does not invent partial usage', async () => {
  const options = await driverOptions({});
  await writeFile(
    join(options.env.MST_COWORK_DRIVER_ROOT, 'scripts/cowork_computer_use.py'),
    'setInterval(() => {}, 1000);'
  );
  options.deadlineAt = Date.now() + 200;
  try {
    await runAnthropicComputerUseSubmission('private prompt', options);
    throw new Error('Expected timeout');
  } catch (error) {
    expect(error).toBeInstanceOf(ComputerUseDriverError);
    expect((error as ComputerUseDriverError).telemetry).toBeUndefined();
    expect(String(error)).toContain(
      'terminated before completion; not retrying'
    );
    expect(String(error)).not.toContain('private prompt');
  }
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
