import { randomUUID } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/client';
import type { DiscoverResult } from '@modelcontextprotocol/client';
import { getToolProtocolError } from '../../mcp/callTool.js';
import { FIRST_MODERN_PROTOCOL_VERSION } from '../../mcp/protocol.js';
import type { WireExchange } from '../../mcp/wireTap.js';
import { errorMessage } from '../../utils/errorMessage.js';
import type {
  CheckOutcome,
  ConformanceCheckDefinition,
  ConformanceContext,
} from '../registry.js';
import {
  errorCodeOf,
  modernMeta,
  probeHttp,
  probeStdio,
  type ProbeResponse,
} from '../probe.js';

/**
 * Checks for the modern (2026-07-28+) protocol. Each one enforces a rule a
 * server-agnostic tester can observe; see the spec pages cited in `specRef`.
 */

const SPEC = 'https://modelcontextprotocol.io/specification/2026-07-28';

/** Methods whose complete results must carry `ttlMs` / `cacheScope`. */
const CACHEABLE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

/** Paginated list methods (a walk shares one `cacheScope`). */
const LIST_METHODS = new Set([
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
]);

/** Error codes the 2026-07-28 spec defines in its reserved range. */
const DEFINED_RESERVED_CODES = new Set([-32020, -32021, -32022]);
/** Codes earlier revisions defined that modern servers must not emit. */
const RETIRED_CODES = new Set([-32002, -32042]);

const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const DISCOVER_KEY = 'discover';

/** Compact JSON for check messages. */
function json(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** The protocol version probes claim: the negotiated one. */
function probeVersion(context: ConformanceContext): string {
  return context.negotiated ?? FIRST_MODERN_PROTOCOL_VERSION;
}

/** Tapped exchanges that returned a result (not an error). */
function observedResults(context: ConformanceContext): WireExchange[] {
  return (context.tap?.exchanges() ?? []).filter(
    (exchange) =>
      typeof exchange.response.result === 'object' &&
      exchange.response.result !== null
  );
}

function needsTap(context: ConformanceContext): CheckOutcome | undefined {
  return context.tap
    ? undefined
    : {
        skip: 'Needs the raw wire; only available for clients created by MST (createMCPClientForConfig or the mcp fixture).',
      };
}

/**
 * Returns a skip when raw probes cannot run, or when `httpOnly` and the
 * connection is not Streamable HTTP.
 */
function needsProbe(
  context: ConformanceContext,
  httpOnly = false
): CheckOutcome | undefined {
  if (!context.probe) {
    return { skip: 'Probe requests disabled (probe: false).' };
  }
  if (!context.target) {
    return {
      skip: 'Needs the connection target; only available for clients created by MST.',
    };
  }
  if (httpOnly && context.target.transport !== 'http') {
    return { skip: 'Streamable HTTP rule; not applicable to stdio.' };
  }
  return undefined;
}

/** Sends a raw modern request with optional header overrides. */
async function probeRequest(
  context: ConformanceContext,
  request: {
    method: string;
    params?: Record<string, unknown>;
    headers?: Record<string, string>;
  }
): Promise<ProbeResponse> {
  const target = context.target!;
  const message = {
    jsonrpc: '2.0',
    id: `mst-probe-${randomUUID()}`,
    method: request.method,
    params: request.params ?? {},
  };
  const response =
    target.transport === 'http'
      ? await probeHttp(target, {
          body: message,
          headers: {
            'MCP-Protocol-Version': probeVersion(context),
            'Mcp-Method': request.method,
            ...request.headers,
          },
        })
      : await probeStdio(target, message);
  const code = errorCodeOf(response.message);
  if (code !== null) context.observedErrorCodes.push(code);
  return response;
}

function formatProbe(response: ProbeResponse): string {
  const status =
    response.status !== undefined ? `HTTP ${response.status}, ` : '';
  return `${status}${response.message ? json(response.message.error ?? response.message.result ?? response.message) : 'no response'}`;
}

/**
 * Groups tapped list exchanges into walks: a request without a cursor starts
 * a walk, and requests with a cursor continue the walk for that method.
 */
function paginationWalks(context: ConformanceContext): WireExchange[][] {
  const walks: WireExchange[][] = [];
  const open = new Map<string, WireExchange[]>();
  for (const exchange of observedResults(context)) {
    if (!LIST_METHODS.has(exchange.method)) continue;
    const params = exchange.request.params as { cursor?: unknown } | undefined;
    if (params?.cursor === undefined) {
      const walk = [exchange];
      walks.push(walk);
      open.set(exchange.method, walk);
    } else {
      open.get(exchange.method)?.push(exchange);
    }
  }
  return walks.filter((walk) => walk.length > 1);
}

export const modernChecks: readonly ConformanceCheckDefinition[] = [
  {
    name: 'discover_succeeds',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/server/discover`,
    async run(context) {
      let discover: DiscoverResult;
      try {
        discover = await context.mcp.client.request({
          method: 'server/discover',
        });
      } catch (error) {
        return {
          pass: false,
          message: `server/discover failed: ${errorMessage(error)}`,
        };
      }
      context.shared.set(DISCOVER_KEY, discover);
      const versions = discover.supportedVersions;
      if (!Array.isArray(versions) || versions.length === 0) {
        return {
          pass: false,
          message: 'supportedVersions is missing or empty',
        };
      }
      if (context.negotiated && !versions.includes(context.negotiated)) {
        return {
          pass: false,
          message: `supportedVersions ${json(versions)} does not include the negotiated ${context.negotiated}`,
        };
      }
      if (typeof discover.capabilities !== 'object' || !discover.capabilities) {
        return { pass: false, message: 'capabilities is missing' };
      }
      return {
        pass: true,
        message: `server/discover advertises ${versions.join(', ')}`,
      };
    },
  },
  {
    name: 'discover_server_info',
    eras: ['modern'],
    severity: 'should',
    specRef: `${SPEC}/server/discover#discoverresult`,
    async run(context) {
      const discover = context.shared.get(DISCOVER_KEY) as
        | DiscoverResult
        | undefined;
      if (!discover) return { skip: 'server/discover did not succeed.' };
      const info = discover._meta?.[SERVER_INFO_KEY] as
        | { name?: unknown }
        | undefined;
      return typeof info?.name === 'string'
        ? { pass: true, message: `serverInfo: ${info.name}` }
        : {
            pass: false,
            message: `DiscoverResult has no _meta["${SERVER_INFO_KEY}"]`,
          };
    },
  },
  {
    name: 'tools_list_deterministic',
    eras: ['modern'],
    severity: 'should',
    requiresTools: true,
    specRef: `${SPEC}/server/tools#listing-tools`,
    async run(context) {
      const first = (await context.mcp.client.listTools()).tools.map(
        (tool) => tool.name
      );
      const second = (await context.mcp.client.listTools()).tools.map(
        (tool) => tool.name
      );
      const same = json(first) === json(second);
      return {
        pass: same,
        message: same
          ? `tools/list returned the same order twice (${first.length} tools)`
          : `tools/list order changed between calls: ${json(first)} vs ${json(second)}`,
      };
    },
  },
  {
    name: 'tools_list_stable_across_connections',
    eras: ['modern'],
    severity: 'must',
    requiresTools: true,
    specRef: `${SPEC}/server/tools#listing-tools`,
    async run(context) {
      if (!context.capabilities?.tools) return null;
      const skip = needsProbe(context);
      if (skip) return skip;
      // The probe is a separate connection (a new HTTP request or a new stdio
      // process) with the same credentials, so the set may not differ.
      const response = await probeRequest(context, {
        method: 'tools/list',
        params: { _meta: modernMeta(probeVersion(context)) },
      });
      const result = response.message?.result as
        | { tools?: Array<{ name?: unknown }>; nextCursor?: unknown }
        | undefined;
      if (!Array.isArray(result?.tools)) {
        return {
          pass: false,
          message: `tools/list on a second connection failed. Got ${formatProbe(response)}`,
        };
      }
      const known = new Set(context.tools.map((tool) => tool.name));
      const probed = result.tools.map((tool) => String(tool.name));
      const unexpected = probed.filter((name) => !known.has(name));
      // Only the first page is probed; compare the whole set when it is all.
      const missing =
        result.nextCursor === undefined
          ? [...known].filter((name) => !probed.includes(name))
          : [];
      return unexpected.length === 0 && missing.length === 0
        ? {
            pass: true,
            message: `A second connection saw the same tools (${probed.length})`,
          }
        : {
            pass: false,
            message: `tools/list varied per connection: only on the second connection ${json(unexpected)}, missing there ${json(missing)}`,
          };
    },
  },
  {
    name: 'cache_scope_consistent_across_pages',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/server/utilities/caching#interaction-with-pagination`,
    async run(context) {
      const skip = needsTap(context);
      if (skip) return skip;
      const walks = paginationWalks(context);
      if (walks.length === 0) {
        return { skip: 'No paginated list results observed.' };
      }
      const problems = walks.flatMap((walk) => {
        const scopes = walk.map(
          (exchange) =>
            (exchange.response.result as { cacheScope?: unknown }).cacheScope
        );
        return new Set(scopes).size > 1
          ? [`${walk[0]!.method}: ${json(scopes)}`]
          : [];
      });
      return problems.length === 0
        ? {
            pass: true,
            message: `Every page of ${walks.length} paginated list(s) had the same cacheScope`,
          }
        : {
            pass: false,
            message: `cacheScope changed between pages: ${problems.join('; ')}`,
          };
    },
  },
  {
    name: 'resource_not_found_error',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/server/resources#error-handling`,
    async run(context) {
      if (!context.capabilities?.resources) return null;
      const uri = `mst-conformance://missing/${randomUUID()}`;
      try {
        const result = await context.mcp.client.readResource({ uri });
        if (!result.contents || result.contents.length === 0) {
          return {
            pass: false,
            message:
              'resources/read of a missing resource returned empty contents; servers must return -32602 instead',
          };
        }
        return {
          skip: `The server returned content for an arbitrary URI (${uri}), so not-found handling could not be observed.`,
        };
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        // The SDK maps a legacy -32002 to ResourceNotFoundError (code -32602),
        // so read the code the server actually sent from the wire when we can.
        const wireCode = errorCodeOf(
          context.tap?.lastExchange('resources/read')?.response ?? null
        );
        const code = wireCode ?? error.code;
        if (code === -32602) {
          return {
            pass: true,
            message: 'Missing resource returned -32602 (Invalid Params)',
          };
        }
        return {
          pass: false,
          message:
            code === -32002
              ? 'Missing resource returned -32002; 2026-07-28 servers must use -32602'
              : `Missing resource returned ${code}; expected -32602`,
        };
      }
    },
  },
  {
    name: 'unknown_tool_protocol_error',
    eras: ['modern'],
    severity: 'should',
    specRef: `${SPEC}/server/tools#error-handling`,
    async run(context) {
      const result = await context.mcp.callTool(
        `__mst_nonexistent_${randomUUID().slice(0, 8)}__`,
        {}
      );
      const protocolError = getToolProtocolError(result);
      if (protocolError) {
        return {
          pass: true,
          message: `Unknown tool returned a protocol error (${protocolError.code})`,
        };
      }
      return {
        pass: false,
        message: result.isError
          ? 'Unknown tool was reported as a tool execution error (isError); the spec classifies unknown tools as protocol errors (JSON-RPC error, e.g. -32602)'
          : 'Unknown tool call did not fail',
      };
    },
  },
  {
    name: 'unsupported_version_rejected',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/basic/versioning#protocol-version-negotiation`,
    async run(context) {
      const skip = needsProbe(context);
      if (skip) return skip;
      const response = await probeRequest(context, {
        method: 'tools/list',
        params: { _meta: modernMeta('1900-01-01') },
        headers: { 'MCP-Protocol-Version': '1900-01-01' },
      });
      const error = response.message?.error as
        | { code?: number; data?: { supported?: unknown } }
        | undefined;
      const problems: string[] = [];
      if (error?.code !== -32022) problems.push('expected error -32022');
      if (!Array.isArray(error?.data?.supported)) {
        problems.push('expected data.supported to list supported versions');
      }
      if (response.status !== undefined && response.status !== 400) {
        problems.push('expected HTTP 400');
      }
      return problems.length === 0
        ? {
            pass: true,
            message: `Unsupported version rejected with -32022 (supports ${json(error?.data?.supported)})`,
          }
        : {
            pass: false,
            message: `${problems.join('; ')}. Got ${formatProbe(response)}`,
          };
    },
  },
  {
    name: 'missing_meta_rejected',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/basic/index#_meta`,
    async run(context) {
      const skip = needsProbe(context);
      if (skip) return skip;
      // `_meta` names the (supported) version, so the request is unambiguously
      // modern and consistent with the version header; only the required
      // clientCapabilities field is missing, which must be -32602.
      const response = await probeRequest(context, {
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': probeVersion(context),
          },
        },
      });
      const code = errorCodeOf(response.message);
      const statusOk = response.status === undefined || response.status === 400;
      const pass = code === -32602 && statusOk;
      return pass
        ? {
            pass,
            message: `Request without the required clientCapabilities rejected with ${response.status !== undefined ? '400 / ' : ''}-32602`,
          }
        : {
            pass,
            message: `Expected ${response.status !== undefined ? 'HTTP 400 with ' : ''}-32602 for a request missing _meta clientCapabilities. Got ${formatProbe(response)}`,
          };
    },
  },
  {
    name: 'header_mismatch_rejected',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/basic/transports/streamable-http#server-validation`,
    async run(context) {
      const skip = needsProbe(context, true);
      if (skip) return skip;
      const meta = modernMeta(probeVersion(context));
      const cases: Array<{
        label: string;
        request: {
          method: string;
          params: Record<string, unknown>;
          headers: Record<string, string>;
        };
      }> = [
        {
          label: 'Mcp-Method',
          request: {
            method: 'tools/list',
            params: { _meta: meta },
            headers: { 'Mcp-Method': 'prompts/list' },
          },
        },
        {
          label: 'Mcp-Name',
          request: {
            method: 'tools/call',
            params: {
              name: `mst_probe_${randomUUID().slice(0, 8)}`,
              arguments: {},
              _meta: meta,
            },
            headers: { 'Mcp-Name': 'mst_other_tool' },
          },
        },
      ];
      const problems: string[] = [];
      for (const { label, request } of cases) {
        const response = await probeRequest(context, request);
        if (
          errorCodeOf(response.message) !== -32020 ||
          response.status !== 400
        ) {
          problems.push(`${label}: ${formatProbe(response)}`);
        }
      }
      return problems.length === 0
        ? {
            pass: true,
            message:
              'Mcp-Method and Mcp-Name mismatches rejected with 400 / -32020',
          }
        : {
            pass: false,
            message: `Expected HTTP 400 with -32020 (HeaderMismatch). Got ${problems.join('; ')}`,
          };
    },
  },
  {
    name: 'unknown_method_not_found',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/basic/transports/streamable-http#protocol-version-header`,
    async run(context) {
      const skip = needsProbe(context, true);
      if (skip) return skip;
      const response = await probeRequest(context, {
        method: 'mst/nonexistent',
        params: { _meta: modernMeta(probeVersion(context)) },
      });
      const code = errorCodeOf(response.message);
      const pass = code === -32601 && response.status === 404;
      return pass
        ? { pass, message: 'Unknown method returned 404 / -32601' }
        : {
            pass,
            message: `Expected HTTP 404 with -32601. Got ${formatProbe(response)}`,
          };
    },
  },
  {
    name: 'no_session_id',
    eras: ['modern'],
    severity: 'should',
    specRef: `${SPEC}/basic/transports/streamable-http#earlier-streamable-http-revisions`,
    async run(context) {
      const skip = needsProbe(context, true);
      if (skip) return skip;
      // Sends a session id, as an older client would: it must be ignored,
      // neither echoed nor replaced by a minted one.
      const response = await probeRequest(context, {
        method: 'server/discover',
        params: { _meta: modernMeta(probeVersion(context)) },
        headers: { 'Mcp-Session-Id': 'mst-probe-session' },
      });
      const session = response.headers?.['mcp-session-id'];
      return session
        ? {
            pass: false,
            message: `Modern response carried Mcp-Session-Id (${session}); 2026-07-28 has no sessions`,
          }
        : { pass: true, message: 'No Mcp-Session-Id minted or echoed' };
    },
  },
  {
    name: 'result_type_present',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/basic/index#resulttype`,
    async run(context) {
      const skip = needsTap(context);
      if (skip) return skip;
      const seen = observedResults(context);
      if (seen.length === 0) return { skip: 'No results observed.' };
      const missing = seen
        .filter(
          (exchange) =>
            typeof (exchange.response.result as { resultType?: unknown })
              .resultType !== 'string'
        )
        .map((exchange) => exchange.method);
      return missing.length === 0
        ? {
            pass: true,
            message: `All ${seen.length} observed results carry resultType`,
          }
        : {
            pass: false,
            message: `Results without resultType: ${[...new Set(missing)].join(', ')}`,
          };
    },
  },
  {
    name: 'cache_hints_present',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/server/utilities/caching#cacheable-results`,
    async run(context) {
      const skip = needsTap(context);
      if (skip) return skip;
      const cacheable = observedResults(context).filter((exchange) => {
        const result = exchange.response.result as { resultType?: unknown };
        return (
          CACHEABLE_METHODS.has(exchange.method) &&
          (result.resultType ?? 'complete') === 'complete'
        );
      });
      if (cacheable.length === 0) {
        return { skip: 'No cacheable results observed.' };
      }
      const problems: string[] = [];
      for (const { method, response } of cacheable) {
        const { ttlMs, cacheScope } = response.result as {
          ttlMs?: unknown;
          cacheScope?: unknown;
        };
        // The spec types ttlMs as a number with a minimum of 0.
        if (typeof ttlMs !== 'number' || ttlMs < 0) {
          problems.push(`${method}: ttlMs ${json(ttlMs)}`);
        }
        if (cacheScope !== 'public' && cacheScope !== 'private') {
          problems.push(`${method}: cacheScope ${json(cacheScope)}`);
        }
      }
      const methods = [
        ...new Set(cacheable.map((exchange) => exchange.method)),
      ];
      return problems.length === 0
        ? {
            pass: true,
            message: `ttlMs and cacheScope present on ${methods.join(', ')}`,
          }
        : {
            pass: false,
            message: `Missing or invalid cache hints: ${[...new Set(problems)].join('; ')}`,
          };
    },
  },
  {
    name: 'result_server_info',
    eras: ['modern'],
    severity: 'should',
    specRef: `${SPEC}/basic/index#_meta`,
    async run(context) {
      const skip = needsTap(context);
      if (skip) return skip;
      const seen = observedResults(context);
      if (seen.length === 0) return { skip: 'No results observed.' };
      const missing = seen
        .filter((exchange) => {
          const meta = (
            exchange.response.result as { _meta?: Record<string, unknown> }
          )._meta;
          return !meta?.[SERVER_INFO_KEY];
        })
        .map((exchange) => exchange.method);
      return missing.length === 0
        ? {
            pass: true,
            message: `serverInfo present in _meta on all ${seen.length} observed results`,
          }
        : {
            pass: false,
            message: `Results without _meta["${SERVER_INFO_KEY}"]: ${[...new Set(missing)].join(', ')}`,
          };
    },
  },
  {
    name: 'reserved_error_codes',
    eras: ['modern'],
    severity: 'must',
    specRef: `${SPEC}/basic/index#error-codes`,
    async run(context) {
      const skip = needsTap(context);
      if (skip) return skip;
      const codes = [
        ...(context.tap?.exchanges() ?? [])
          .map((exchange) => errorCodeOf(exchange.response))
          .filter((code): code is number => code !== null),
        ...context.observedErrorCodes,
      ];
      if (codes.length === 0) return { skip: 'No error responses observed.' };
      const bad = [...new Set(codes)].filter(
        (code) =>
          RETIRED_CODES.has(code) ||
          (code <= -32020 &&
            code >= -32099 &&
            !DEFINED_RESERVED_CODES.has(code))
      );
      return bad.length === 0
        ? {
            pass: true,
            message: `All ${codes.length} observed error codes are allowed`,
          }
        : {
            pass: false,
            message: `Server emitted codes it must not use on 2026-07-28: ${bad.join(', ')} (-32020..-32099 is reserved for spec-defined codes; -32002 and -32042 are retired)`,
          };
    },
  },
];
