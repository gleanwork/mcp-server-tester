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
