import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  HostDefinition,
  HostEvent,
  HostRunResult,
} from '../../../src/evals/evalFrameworkTypes.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../../src/mcp/clientFactory.js';
import { createMCPFixture } from '../../../src/mcp/fixtures/mcpFixture.js';

const SYNTHETIC_HOST_NAME = 'synthetic-desktop-eval';
const SyntheticHostSchema = z
  .object({ type: z.literal(SYNTHETIC_HOST_NAME) })
  .strict();

interface SyntheticAnswerRecord {
  reference: string;
  verificationCode: string;
}

/**
 * Deterministic host fake for proving the shared dataset and scorer. It receives
 * only the scenario and server configurations, then executes the real fixture
 * tools. Evaluator answers and expectations never enter this host.
 */
export function createSyntheticDesktopHost(): HostDefinition {
  return {
    name: SYNTHETIC_HOST_NAME,
    schema: SyntheticHostSchema,
    evidence: 'structured',
    async run(input, config): Promise<HostRunResult> {
      SyntheticHostSchema.parse(config);
      const server = input.servers.find(
        (candidate) => candidate.label === 'desktop_records'
      );
      if (!server) {
        return failed('The primary desktop fixture server is unavailable.');
      }

      const client = await createMCPClientForConfig(server);
      const mcp = createMCPFixture(client);
      const events: HostEvent[] = [];
      try {
        if (input.scenario.includes('First look up "missing-release"')) {
          const missing = await call(
            mcp.callTool.bind(mcp),
            events,
            server.label!,
            'lookup_record',
            { namespace: 'releases', reference: 'missing-release' }
          );
          if (missing.isError !== true) {
            return failed('The missing-record fixture did not fail.', events);
          }
          const search = await call(
            mcp.callTool.bind(mcp),
            events,
            server.label!,
            'search_records',
            { namespace: 'releases', query: 'recovery release' }
          );
          const reference = firstSearchReference(search);
          const lookup = await call(
            mcp.callTool.bind(mcp),
            events,
            server.label!,
            'lookup_record',
            { namespace: 'releases', reference }
          );
          return completed(events, lookup, 'recovered', {
            requestedReference: 'missing-release',
          });
        }

        if (input.scenario.includes('Search with search_records')) {
          const search = await call(
            mcp.callTool.bind(mcp),
            events,
            server.label!,
            'search_records',
            { namespace: 'releases', query: 'dependent release' }
          );
          const reference = firstSearchReference(search);
          const lookup = await call(
            mcp.callTool.bind(mcp),
            events,
            server.label!,
            'lookup_record',
            { namespace: 'releases', reference }
          );
          return completed(events, lookup, 'found');
        }

        const reference = capture(
          input.scenario,
          /Look up reference "([^"]+)"/,
          'direct reference'
        );
        const lookup = await call(
          mcp.callTool.bind(mcp),
          events,
          server.label!,
          'lookup_record',
          { namespace: 'releases', reference }
        );
        return completed(events, lookup, 'found');
      } catch {
        return failed('Synthetic desktop host execution failed.', events);
      } finally {
        await closeMCPClient(client);
      }
    },
  };
}

async function call(
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  events: HostEvent[],
  server: string,
  name: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const result = CallToolResultSchema.parse(await callTool(name, args));
  events.push({
    kind: 'tool_call',
    source: 'mcp',
    server,
    name,
    id: `synthetic-${randomUUID()}`,
    arguments: structuredClone(args),
    output: JSON.stringify(result),
  });
  return result;
}

function completed(
  events: HostEvent[],
  result: CallToolResult,
  status: 'found' | 'recovered',
  extra: Record<string, unknown> = {}
): HostRunResult {
  if (result.isError === true) {
    return failed('The final fixture lookup failed.', events);
  }
  const body = record(result.structuredContent, 'lookup result');
  const found = record(body.record, 'lookup record');
  const answer = parseAnswerRecord(found);
  return {
    finalText: JSON.stringify({
      status,
      ...extra,
      reference: answer.reference,
      verificationCode: answer.verificationCode,
      serverLabel: string(body.serverLabel, 'server label'),
    }),
    events,
  };
}

function firstSearchReference(result: CallToolResult): string {
  if (result.isError === true) {
    throw new Error('Fixture search failed.');
  }
  const body = record(result.structuredContent, 'search result');
  if (!Array.isArray(body.matches) || body.matches.length !== 1) {
    throw new Error('Fixture search did not return one match.');
  }
  return string(record(body.matches[0], 'search match').reference, 'reference');
}

function parseAnswerRecord(
  value: Record<string, unknown>
): SyntheticAnswerRecord {
  return {
    reference: string(value.reference, 'record reference'),
    verificationCode: string(value.verificationCode, 'verification code'),
  };
}

function failed(error: string, events: HostEvent[] = []): HostRunResult {
  return { finalText: '', events, error };
}

function capture(value: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(value);
  if (!match?.[1]) {
    throw new Error(`Scenario lacks ${label}.`);
  }
  return match[1];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}
