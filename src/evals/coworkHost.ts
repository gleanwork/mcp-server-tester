import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  HostDefinition,
  HostRunInput,
  HostRunContext,
  PreparedHostSession,
} from './evalFrameworkTypes.js';
import type { HostConfig } from './evalManifest.js';
import { ExternalHostConfigSchema } from './externalHost/schema.js';
import {
  normalizeHostDriver,
  driverToSlug,
  CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
} from './externalHost/driverIdentity.js';
import { loadExternalHostConfig } from './externalHost/capabilityRuntime.js';
import { runExternalHostScenario } from './externalHost/runtime.js';
import { simulationToHostTrace } from './hostTrace.js';
import {
  createCoworkMcpPlan,
  resolveCoworkMcpHeaders,
} from './coworkSetup/config.js';
import { resolveCoworkSetupConfig } from './coworkSetup/options.js';
import { prepareMacCoworkSession } from './coworkSetup/macSession.js';

const CoworkHostSchema = ExternalHostConfigSchema.extend({
  type: z.literal('cowork'),
  driver: ExternalHostConfigSchema.shape.driver.default(
    driverToSlug(CLAUDE_COWORK_DESKTOP_MACOS_DRIVER)
  ),
  profileDirectory: z.string().min(1).optional(),
}).strict();

async function prepareCoworkHost(
  input: Omit<HostRunInput, 'scenario'>,
  declaration: HostConfig,
  context: HostRunContext
): Promise<PreparedHostSession> {
  // TODO: supply Linux/other platform lifecycle adapters. Never silently use an
  // existing, unconfigured installation or substitute a programmatic LLM host.
  if (process.platform !== 'darwin') {
    throw new Error(`Cowork on ${process.platform} is not supported yet.`);
  }
  const parsed = CoworkHostSchema.safeParse(declaration);
  if (!parsed.success) throw new Error('Invalid Cowork host configuration.');
  const { type: _type, profileDirectory, ...config } = parsed.data;
  const driver = normalizeHostDriver(config.driver);
  if (
    driver.provider !== 'anthropic' ||
    driver.product !== 'claude' ||
    driver.surface !== 'cowork' ||
    driver.runtime !== 'desktop-app' ||
    (driver.platform !== undefined && driver.platform !== 'macos')
  ) {
    throw new Error('Cowork requires a Claude Cowork macOS desktop driver.');
  }
  const servers = structuredClone(input.servers);
  if (
    servers.length === 0 &&
    context.arm?.servers === undefined &&
    context.manifest.servers === undefined
  ) {
    throw new Error(
      'Cowork requires explicit MCP servers; use servers: [] for an empty set.'
    );
  }
  // Only effective runtime servers are authoritative. Do not reselect a raw arm
  // after suite overrides or re-read ambient env/credential stores here.
  const setup = resolveCoworkSetupConfig(
    (context.baseManifest ?? context.manifest).coworkSetup,
    context.arm?.coworkSetup
  );
  createCoworkMcpPlan(servers, '/run/mst-cowork-validation', setup);
  const env = { ...context.env, ...input.env };
  resolveCoworkMcpHeaders(servers, env);
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(key)) {
    throw new Error(
      'Cowork requires a valid ANTHROPIC_API_KEY runtime credential.'
    );
  }
  const options = {
    ...config.options,
    // This lifecycle configures the third-party app, not the consumer profile.
    dataDir:
      config.options?.dataDir ??
      join(
        homedir(),
        'Library/Application Support/Claude-3p/local-agent-mode-sessions'
      ),
  };
  // Validate capability bindings before any profile or application mutation.
  try {
    await loadExternalHostConfig({ ...config, options });
  } catch {
    throw new Error('The selected Cowork driver could not be loaded.');
  }
  const resource = await prepareMacCoworkSession({
    manifest: {
      name: context.manifest.name,
      datasets: [],
      servers,
      coworkSetup: setup,
    },
    env,
    profileDirectory,
  });
  let disposed = false;
  let disposing: Promise<void> | undefined;
  return {
    async run(runInput) {
      if (disposed)
        throw new Error('Cowork session has already been disposed.');
      const result = await runExternalHostScenario(runInput.scenario, {
        ...config,
        options,
      });
      const missingProvenance = result.toolCalls.some(
        (call) => !call.source || (call.source === 'mcp' && !call.server)
      );
      return {
        ...(missingProvenance
          ? {
              finalText: result.success ? (result.response ?? '') : '',
              events: [],
              error:
                'Cowork driver returned tool calls without source/server provenance; unattributed calls cannot be evaluated safely.',
            }
          : simulationToHostTrace(result, servers)),
        externalHost: {
          ...result.externalHost,
          traceLimitations: [
            ...(result.externalHost.traceLimitations ?? []),
            'Managed MCP configuration was prepared; complete native inventory and tool-policy adoption are not independently verified.',
          ],
        },
      };
    },
    dispose() {
      disposed = true;
      disposing ??= resource.dispose();
      return disposing;
    },
  };
}

/** Configuration lifecycle is mandatory whenever the Cowork host is selected. */
export const COWORK_HOST: HostDefinition = {
  name: 'cowork',
  schema: CoworkHostSchema,
  evidence: 'observed',
  maxConcurrency: 1,
  prepareSession: prepareCoworkHost,
};
