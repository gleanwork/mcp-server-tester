import { describe, expect, it } from 'vitest';
import {
  loadExternalHostConfig,
  loadExternalHostRunner,
  registerExternalHostCapability,
} from './capabilityRuntime.js';

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

  it('tears down configured capabilities after a successful run', async () => {
    const calls: string[] = [];

    registerExternalHostCapability({
      id: 'test.capability.lifecycle',
      capabilities: ['control', 'input', 'completion', 'trace', 'normalize'],
      async setup() {
        calls.push('setup');
      },
      async run({ run, state }) {
        calls.push('run');
        return {
          success: true,
          response: 'completed',
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
      async teardown() {
        calls.push('teardown');
      },
    });

    const runner = await loadExternalHostRunner({
      driver: TEST_DRIVER,
      capabilities: {
        control: {
          uses: 'test.capability.lifecycle',
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

    expect(result.success).toBe(true);
    expect(calls).toEqual(['setup', 'run', 'teardown']);
  });

  it('tears down configured capabilities after an early setup failure', async () => {
    const calls: string[] = [];

    registerExternalHostCapability({
      id: 'test.capability.setupFailureLifecycle',
      capabilities: ['control', 'input', 'completion', 'trace', 'normalize'],
      async setup({ run, state }) {
        calls.push('setup');
        return {
          success: false,
          error: 'setup failed',
          toolCalls: [],
          externalHost: {
            driver: state.driver,
            driverSlug: state.driverSlug,
            displayName: state.displayName,
            hostName: state.displayName,
            hostType: 'custom',
            capabilitiesUsed: state.capabilitiesUsed,
            traceSource: 'none',
            traceConfidence: 'unknown',
            artifacts: [],
            session: { runMarker: run.marker },
            correlation: run.correlation,
            failureKind: 'submission_failed',
          },
        };
      },
      async teardown() {
        calls.push('teardown');
      },
    });

    const runner = await loadExternalHostRunner({
      driver: TEST_DRIVER,
      capabilities: {
        control: {
          uses: 'test.capability.setupFailureLifecycle',
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

    expect(result).toMatchObject({ success: false, error: 'setup failed' });
    expect(calls).toEqual(['setup', 'teardown']);
  });

  it('returns structured metadata for thrown capability errors and tears down only entered capabilities', async () => {
    const calls: string[] = [];

    registerExternalHostCapability({
      id: 'test.capability.throwingSetup',
      capabilities: ['control'],
      async setup() {
        calls.push('first:setup');
        throw new Error('setup exploded');
      },
      async teardown() {
        calls.push('first:teardown');
      },
    });
    registerExternalHostCapability({
      id: 'test.capability.notEntered',
      capabilities: ['input', 'completion', 'trace', 'normalize'],
      async setup() {
        calls.push('second:setup');
      },
      async teardown() {
        calls.push('second:teardown');
      },
    });

    const runner = await loadExternalHostRunner({
      driver: TEST_DRIVER,
      capabilities: {
        control: { uses: 'test.capability.throwingSetup' },
        input: {
          uses: 'test.capability.notEntered',
          provides: ['completion', 'trace', 'normalize'],
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

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('setup exploded'),
      externalHost: { failureKind: 'host_run_failed' },
    });
    expect(calls).toEqual(['first:setup', 'first:teardown']);
  });

  it('returns a structured cleanup failure when teardown throws', async () => {
    registerExternalHostCapability({
      id: 'test.capability.cleanupFailure',
      capabilities: ['control', 'input', 'completion', 'trace', 'normalize'],
      async run({ run, state }) {
        return {
          success: true,
          response: 'completed',
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
      async teardown() {
        throw new Error('cleanup exploded');
      },
    });

    const runner = await loadExternalHostRunner({
      driver: TEST_DRIVER,
      capabilities: {
        control: {
          uses: 'test.capability.cleanupFailure',
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

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('cleanup exploded'),
      externalHost: {
        failureKind: 'cleanup_failed',
        traceLimitations: [expect.stringContaining('cleanup exploded')],
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
