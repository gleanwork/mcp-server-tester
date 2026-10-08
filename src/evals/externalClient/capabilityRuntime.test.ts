import { describe, expect, it } from 'vitest';
import {
  createExternalClientRunner,
  loadExternalClientConfig,
  type CapabilityLookup,
} from './capabilityRuntime.js';
import { runExternalClientCase } from './runtime.js';
import type {
  ExternalClientCapabilitiesConfig,
  ExternalClientCapabilityImplementation,
  ExternalClientRunResult,
  ExternalClientRunState,
  ClientRunContext,
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

const RUN_CONTEXT: ClientRunContext = {
  runId: 'run',
  caseId: 'case',
  input: 'input',
  submittedInput: 'input',
  marker: 'MCP_SERVER_TESTER_CAPABILITY',
  correlation: TEST_CORRELATION,
  timeoutMs: 1000,
  startedAtMs: 0,
};

function successFor(state: ExternalClientRunState): ExternalClientRunResult {
  return {
    success: true,
    response: 'done',
    toolCalls: [],
    clientMetadata: {
      driver: state.driver,
      driverSlug: state.driverSlug,
      displayName: state.displayName,
      clientName: state.displayName,
      clientType: 'custom',
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
  capabilities: ExternalClientCapabilitiesConfig,
  implementations: ExternalClientCapabilityImplementation[]
): Promise<ExternalClientRunResult> {
  const loaded = loadExternalClientConfig(
    { driver: TEST_DRIVER, capabilities },
    lookupOf(implementations)
  );
  return createExternalClientRunner(loaded).run(RUN_CONTEXT);
}

/** A lookup over the given implementations, in place of the built-ins. */
function lookupOf(
  implementations: ExternalClientCapabilityImplementation[]
): CapabilityLookup {
  const byId = new Map(implementations.map((i) => [i.id, i]));
  return (uses) => byId.get(uses);
}

describe('external client capability runtime', () => {
  it('composes a runner from config-declared capability bindings', async () => {
    const calls: string[] = [];
    const implementation: ExternalClientCapabilityImplementation = {
      id: 'test.capability.success',
      capabilities: ['control', 'input', 'completion', 'trace', 'normalize'],
      async setup({ state }) {
        calls.push('setup');
        state.data.setupSeen = true;
      },
      async run({ state }) {
        calls.push('run');
        expect(state.driverSlug).toBe('test.host.chat.desktop-app.macos');
        expect(state.data.setupSeen).toBe(true);
        return { ...successFor(state), response: 'composed result' };
      },
    };

    const loaded = loadExternalClientConfig(
      {
        driver: TEST_DRIVER,
        capabilities: {
          control: {
            uses: 'test.capability.success',
            provides: ['input', 'completion', 'trace', 'normalize'],
          },
        },
      },
      lookupOf([implementation])
    );
    const result = await createExternalClientRunner(loaded).run(RUN_CONTEXT);

    expect(calls).toEqual(['setup', 'run']);
    expect(result).toMatchObject({
      success: true,
      response: 'composed result',
      clientMetadata: {
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

  it('treats binding provides as additional capabilities', () => {
    const loaded = loadExternalClientConfig(
      {
        driver: TEST_DRIVER,
        capabilities: {
          control: { uses: 'test.capability.extraControl' },
          input: {
            uses: 'test.capability.inputTrace',
            provides: ['completion', 'normalize'],
          },
        },
      },
      lookupOf([
        { id: 'test.capability.extraControl', capabilities: ['control'] },
        { id: 'test.capability.inputTrace', capabilities: ['input', 'trace'] },
      ])
    );

    expect(loaded.capabilitiesUsed).toEqual([
      'control',
      'input',
      'trace',
      'completion',
      'normalize',
    ]);
  });

  it('fails config loading when required capabilities are missing', () => {
    expect(() =>
      loadExternalClientConfig(
        {
          driver: TEST_DRIVER,
          capabilities: { control: { uses: 'test.capability.controlOnly' } },
        },
        lookupOf([
          { id: 'test.capability.controlOnly', capabilities: ['control'] },
        ])
      )
    ).toThrow('missing capabilities');
  });

  it('fails config loading for unavailable capability implementations', () => {
    expect(() =>
      loadExternalClientConfig({
        driver: TEST_DRIVER,
        capabilities: {
          control: {
            uses: 'missing.capability',
            provides: ['input', 'completion', 'trace', 'normalize'],
          },
        },
      })
    ).toThrow(
      /not available: missing\.capability\. .*custom client, provide it from a plugin's clients/
    );
  });

  it('rejects module: capabilities, which were removed', () => {
    expect(() =>
      loadExternalClientConfig({
        driver: TEST_DRIVER,
        capabilities: {
          control: {
            uses: 'module:./my-capability.mjs#capability',
            provides: ['input', 'completion', 'trace', 'normalize'],
          },
        },
      })
    ).toThrow(
      'External client capability "module:./my-capability.mjs#capability": module: capabilities were removed.'
    );
  });

  it('resolves the built-in capabilities by default', () => {
    const loaded = loadExternalClientConfig({
      driver: TEST_DRIVER,
      capabilities: {
        control: { uses: 'builtin:openai.chatgpt.appLifecycle' },
        input: {
          uses: 'builtin:openai.chatgpt.nativeSubmit',
          provides: ['completion', 'trace', 'normalize'],
        },
      },
    });

    expect(loaded.loadedCapabilities.map((c) => c.implementation.id)).toEqual([
      'builtin:openai.chatgpt.appLifecycle',
      'builtin:openai.chatgpt.nativeSubmit',
    ]);
  });
});

type Step = 'setup' | 'run' | 'teardown';

/** A capability that records each lifecycle step it is asked to perform. */
function recording(
  id: string,
  provides: ExternalClientCapabilityImplementation['capabilities'],
  calls: string[],
  behaviour: Partial<
    Record<
      Step,
      (state: ExternalClientRunState) => ExternalClientRunResult | void
    >
  > = {}
): ExternalClientCapabilityImplementation {
  const step =
    (name: Step) =>
    async ({ state }: { state: ExternalClientRunState }) => {
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

describe('external client capability lifecycle', () => {
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

  it('stops at the first run that returns a result', async () => {
    const calls: string[] = [];
    const result = await runCapabilities(
      {
        control: { uses: 'mid.a' },
        input: { uses: 'mid.b' },
        trace: { uses: 'mid.c' },
      },
      [
        recording('mid.a', ['control'], calls),
        recording('mid.b', ['input', 'completion'], calls, { run: successFor }),
        recording('mid.c', ['trace', 'normalize'], calls),
      ]
    );

    expect(result).toMatchObject({ success: true });
    expect(calls).toEqual([
      'mid.a.setup',
      'mid.b.setup',
      'mid.c.setup',
      'mid.a.run',
      'mid.b.run',
      'mid.c.teardown',
      'mid.b.teardown',
      'mid.a.teardown',
    ]);
  });

  it('stops at a setup that returns a result', async () => {
    const calls: string[] = [];
    const result = await runCapabilities(
      { control: { uses: 'ret.a' }, input: { uses: 'ret.b' } },
      [
        recording('ret.a', ['control'], calls, { setup: successFor }),
        recording(
          'ret.b',
          ['input', 'completion', 'trace', 'normalize'],
          calls
        ),
      ]
    );

    expect(result).toMatchObject({ success: true });
    expect(calls).toEqual(['ret.a.setup', 'ret.a.teardown']);
  });

  it('tears down a capability whose setup threw', async () => {
    const calls: string[] = [];
    const result = await runCapabilities(
      { control: { uses: 'bad.a' }, input: { uses: 'bad.b' } },
      [
        recording('bad.a', ['control'], calls),
        recording(
          'bad.b',
          ['input', 'completion', 'trace', 'normalize'],
          calls,
          {
            setup: () => {
              throw new Error('no window');
            },
          }
        ),
      ]
    );

    expect(result).toMatchObject({
      success: false,
      error: 'External client capability failed: no window',
    });
    expect(calls).toEqual([
      'bad.a.setup',
      'bad.b.setup',
      'bad.b.teardown',
      'bad.a.teardown',
    ]);
  });

  it('reports a run error and a cleanup error together', async () => {
    const result = await runCapabilities({ control: { uses: 'both.a' } }, [
      recording(
        'both.a',
        ['control', 'input', 'completion', 'trace', 'normalize'],
        [],
        {
          run: () => {
            throw new Error('boom');
          },
          teardown: () => {
            throw new Error('stuck');
          },
        }
      ),
    ]);

    expect(result).toMatchObject({
      success: false,
      error:
        'External client capability failed: boom; External client cleanup failed: stuck',
      clientMetadata: { failureKind: 'cleanup_failed' },
    });
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
      error: 'External client capability failed: boom',
      clientMetadata: { failureKind: 'client_run_failed' },
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
      error: 'External client cleanup failed: stuck',
      clientMetadata: {
        failureKind: 'cleanup_failed',
        traceLimitations: ['External client cleanup failed: stuck'],
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
        'External client test.host.chat.desktop-app.macos completed without producing a result.',
      clientMetadata: { failureKind: 'client_run_failed' },
    });
  });

  it('reports an unknown capability as an unsupported client run', async () => {
    const result = await runExternalClientCase('input', {
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
      clientMetadata: { failureKind: 'unsupported_client' },
    });
    expect(!result.success && result.error).toContain('missing.capability');
  });

  it('reports a module: capability as an unsupported client run', async () => {
    const result = await runExternalClientCase('input', {
      driver: TEST_DRIVER,
      capabilities: {
        control: {
          uses: 'module:./my-capability.mjs#capability',
          provides: ['input', 'completion', 'trace', 'normalize'],
        },
      },
    });

    expect(result).toMatchObject({
      success: false,
      clientMetadata: { failureKind: 'unsupported_client' },
    });
    expect(!result.success && result.error).toContain(
      'module: capabilities were removed'
    );
  });
});
