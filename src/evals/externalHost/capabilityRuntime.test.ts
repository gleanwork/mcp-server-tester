import { describe, expect, it } from 'vitest';
import {
  loadExternalHostConfig,
  loadExternalHostRunner,
  registerExternalHostCapability,
} from './capabilityRuntime.js';
import { runExternalHostScenario } from './runtime.js';
import type {
  ExternalHostCapabilitiesConfig,
  ExternalHostCapabilityImplementation,
  ExternalHostRunResult,
  ExternalHostRunState,
  HostRunContext,
} from './types.js';

const TEST_DRIVER = {
  provider: 'test',
  product: 'host',
  surface: 'chat',
  runtime: 'desktop-app',
  platform: 'macos',
} as const;

const TEST_CORRELATION = {
  strategy: 'prompt_marker',
  marker: 'MCP_SERVER_TESTER_CAPABILITY',
  includedInPrompt: true,
} as const;

describe('external host capability runtime', () => {
  it('composes a runner from config-declared capability bindings', async () => {
    const calls: string[] = [];

    registerExternalHostCapability({
      id: 'test.capability.success',
      capabilities: ['control', 'input', 'completion', 'trace', 'normalize'],
      async setup({ state }) {
        calls.push('setup');
        state.data.setupSeen = true;
      },
      async run({ run, state }) {
        calls.push('run');
        expect(state.driverSlug).toBe('test.host.chat.desktop-app.macos');
        expect(state.data.setupSeen).toBe(true);
        return {
          success: true,
          response: 'composed result',
          toolCalls: [],
          externalHost: {
            driver: state.driver,
            driverSlug: state.driverSlug,
            displayName: state.displayName,
            hostName: state.displayName,
            hostType: 'custom',
            capabilitiesUsed: state.capabilitiesUsed,
            traceSource: 'manual-import',
            traceConfidence: 'high',
            artifacts: [],
            session: { runMarker: run.marker },
            correlation: run.correlation,
          },
        };
      },
    });

    const runner = await loadExternalHostRunner({
      driver: TEST_DRIVER,
      capabilities: {
        control: {
          uses: 'test.capability.success',
          provides: ['input', 'completion', 'trace', 'normalize'],
        },
      },
    });

    const result = await runner.run({
      runId: 'run',
      caseId: 'case',
      scenario: 'scenario',
      submittedScenario: 'scenario',
      marker: 'MCP_SERVER_TESTER_CAPABILITY',
      correlation: TEST_CORRELATION,
      timeoutMs: 1000,
      startedAtMs: Date.now(),
    });

    expect(calls).toEqual(['setup', 'run']);
    expect(result).toMatchObject({
      success: true,
      response: 'composed result',
      externalHost: {
        driverSlug: 'test.host.chat.desktop-app.macos',
        capabilitiesUsed: [
          'control',
          'input',
          'completion',
          'trace',
          'normalize',
        ],
      },
    });
  });

  it('treats binding provides as additional capabilities', async () => {
    registerExternalHostCapability({
      id: 'test.capability.extraControl',
      capabilities: ['control'],
    });
    registerExternalHostCapability({
      id: 'test.capability.inputTrace',
      capabilities: ['input', 'trace'],
    });

    const loaded = await loadExternalHostConfig({
      driver: TEST_DRIVER,
      capabilities: {
        control: { uses: 'test.capability.extraControl' },
        input: {
          uses: 'test.capability.inputTrace',
          provides: ['completion', 'normalize'],
        },
      },
    });

    expect(loaded.capabilitiesUsed).toEqual([
      'control',
      'input',
      'trace',
      'completion',
      'normalize',
    ]);
  });

  it('fails config loading when required capabilities are missing', async () => {
    registerExternalHostCapability({
      id: 'test.capability.controlOnly',
      capabilities: ['control'],
    });

    await expect(
      loadExternalHostConfig({
        driver: TEST_DRIVER,
        capabilities: {
          control: { uses: 'test.capability.controlOnly' },
        },
      })
    ).rejects.toThrow('missing capabilities');
  });

  it('fails config loading for unavailable capability implementations', async () => {
    await expect(
      loadExternalHostConfig({
        driver: TEST_DRIVER,
        capabilities: {
          control: {
            uses: 'missing.capability',
            provides: ['input', 'completion', 'trace', 'normalize'],
          },
        },
      })
    ).rejects.toThrow('not available');
  });
});

const RUN_CONTEXT: HostRunContext = {
  runId: 'run',
  caseId: 'case',
  scenario: 'scenario',
  submittedScenario: 'scenario',
  marker: 'MCP_SERVER_TESTER_CAPABILITY',
  correlation: TEST_CORRELATION,
  timeoutMs: 1000,
  startedAtMs: 0,
};

function successFor(state: ExternalHostRunState): ExternalHostRunResult {
  return {
    success: true,
    response: 'done',
    toolCalls: [],
    externalHost: {
      driver: state.driver,
      driverSlug: state.driverSlug,
      displayName: state.displayName,
      hostName: state.displayName,
      hostType: 'custom',
      capabilitiesUsed: state.capabilitiesUsed,
      traceSource: 'manual-import',
      traceConfidence: 'high',
      artifacts: [],
      session: { runMarker: RUN_CONTEXT.marker },
      correlation: RUN_CONTEXT.correlation,
    },
  };
}

/** The one place these tests supply capability implementations. */
async function runCapabilities(
  capabilities: ExternalHostCapabilitiesConfig,
  implementations: ExternalHostCapabilityImplementation[]
): Promise<ExternalHostRunResult> {
  for (const implementation of implementations)
    registerExternalHostCapability(implementation);
  const runner = await loadExternalHostRunner({
    driver: TEST_DRIVER,
    capabilities,
  });
  return runner.run(RUN_CONTEXT);
}

type Step = 'setup' | 'run' | 'teardown';

/** A capability that records each lifecycle step it is asked to perform. */
function recording(
  id: string,
  provides: ExternalHostCapabilityImplementation['capabilities'],
  calls: string[],
  behaviour: Partial<
    Record<Step, (state: ExternalHostRunState) => ExternalHostRunResult | void>
  > = {}
): ExternalHostCapabilityImplementation {
  const step =
    (name: Step) =>
    async ({ state }: { state: ExternalHostRunState }) => {
      calls.push(`${id}.${name}`);
      return behaviour[name]?.(state) ?? undefined;
    };
  return {
    id,
    capabilities: provides,
    setup: step('setup'),
    run: step('run'),
    teardown: async ({ state }) => {
      calls.push(`${id}.teardown`);
      behaviour.teardown?.(state);
    },
  };
}

describe('external host capability lifecycle', () => {
  it('runs every setup in capability order, then every run, then tears down in reverse', async () => {
    const calls: string[] = [];
    const result = await runCapabilities(
      {
        trace: { uses: 'life.c' },
        control: { uses: 'life.a' },
        input: { uses: 'life.b' },
      },
      [
        recording('life.a', ['control'], calls),
        recording('life.b', ['input', 'completion'], calls),
        recording('life.c', ['trace', 'normalize'], calls, {
          run: successFor,
        }),
      ]
    );

    expect(result).toMatchObject({ success: true, response: 'done' });
    expect(calls).toEqual([
      'life.a.setup',
      'life.b.setup',
      'life.c.setup',
      'life.a.run',
      'life.b.run',
      'life.c.run',
      'life.c.teardown',
      'life.b.teardown',
      'life.a.teardown',
    ]);
  });

  it('stops at the first result and tears down only what it entered', async () => {
    const calls: string[] = [];
    const result = await runCapabilities(
      { control: { uses: 'stop.a' }, input: { uses: 'stop.b' } },
      [
        recording('stop.a', ['control'], calls, {
          setup: (state) => {
            state.result = successFor(state);
          },
        }),
        recording(
          'stop.b',
          ['input', 'completion', 'trace', 'normalize'],
          calls
        ),
      ]
    );

    expect(result).toMatchObject({ success: true });
    expect(calls).toEqual(['stop.a.setup', 'stop.a.teardown']);
  });

  it('fails the run when a capability throws, after tearing everything down', async () => {
    const calls: string[] = [];
    const result = await runCapabilities(
      { control: { uses: 'throw.a' }, input: { uses: 'throw.b' } },
      [
        recording('throw.a', ['control'], calls),
        recording(
          'throw.b',
          ['input', 'completion', 'trace', 'normalize'],
          calls,
          {
            run: () => {
              throw new Error('boom');
            },
          }
        ),
      ]
    );

    expect(result).toMatchObject({
      success: false,
      error: 'External host capability failed: boom',
      externalHost: { failureKind: 'host_run_failed' },
    });
    expect(calls).toEqual([
      'throw.a.setup',
      'throw.b.setup',
      'throw.a.run',
      'throw.b.run',
      'throw.b.teardown',
      'throw.a.teardown',
    ]);
  });

  it('reports a failed teardown as cleanup_failed and keeps the run output', async () => {
    const calls: string[] = [];
    const result = await runCapabilities({ control: { uses: 'clean.a' } }, [
      recording(
        'clean.a',
        ['control', 'input', 'completion', 'trace', 'normalize'],
        calls,
        {
          run: successFor,
          teardown: () => {
            throw new Error('stuck');
          },
        }
      ),
    ]);

    expect(result).toMatchObject({
      success: false,
      response: 'done',
      error: 'External host cleanup failed: stuck',
      externalHost: {
        failureKind: 'cleanup_failed',
        traceLimitations: ['External host cleanup failed: stuck'],
      },
    });
  });

  it('fails when no capability produces a result', async () => {
    const result = await runCapabilities({ control: { uses: 'none.a' } }, [
      recording(
        'none.a',
        ['control', 'input', 'completion', 'trace', 'normalize'],
        []
      ),
    ]);

    expect(result).toMatchObject({
      success: false,
      error:
        'External host test.host.chat.desktop-app.macos completed without producing a result.',
      externalHost: { failureKind: 'host_run_failed' },
    });
  });

  it('reports an unknown capability as an unsupported host run', async () => {
    const result = await runExternalHostScenario('scenario', {
      driver: TEST_DRIVER,
      capabilities: {
        control: {
          uses: 'missing.capability',
          provides: ['input', 'completion', 'trace', 'normalize'],
        },
      },
    });

    expect(result).toMatchObject({
      success: false,
      externalHost: { failureKind: 'unsupported_host' },
    });
    expect(!result.success && result.error).toContain('missing.capability');
  });
});
