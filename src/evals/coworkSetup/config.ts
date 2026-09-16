import type { HttpMCPConfig, MCPConfig } from '../../config/mcpConfig.js';
import { resolveCoworkSetupConfig, type CoworkSetupConfig } from './options.js';

export type CoworkMcpSettings = {
  managedMcpServers: Array<{
    name: string;
    transport: 'http';
    url: string;
    headersHelper?: string;
    /** Explicit server-scoped opt-in, including present and future write tools. */
    toolPolicy?: { '*': 'allow' };
  }>;
  allowedMcpServers: Array<{ serverName: string }>;
  allowManagedMcpServersOnly: true;
};

type CoworkMcpServer = { label: string; url: string; helperName?: string };

const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_KEYS = new Set([
  'transport',
  'label',
  'serverUrl',
  'headers',
  'auth',
]);
const AUTH_KEYS = new Set(['accessToken', 'accessTokenEnv']);

function invalidConfig(): never {
  throw new Error('Invalid or unsupported Cowork MCP configuration.');
}

function invalidHeaders(): never {
  throw new Error('Invalid or missing Cowork MCP runtime headers.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsControls(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}

function normalizeUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    containsControls(value) ||
    /[\s\\?#]/u.test(value)
  ) {
    invalidConfig();
  }

  // Inspect the original authority as well: URL normalizes non-literal loopback
  // spellings (127.1, integer/hex IPs) and otherwise discards empty userinfo.
  const authority = /^https?:\/\/([^/]+)/i.exec(value)?.[1];
  if (!authority || authority.includes('@')) invalidConfig();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidConfig();
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(authority)
      ))
  ) {
    invalidConfig();
  }
  return url.href;
}

function validateHelperDirectory(directory: string): string {
  // Paths become executable command strings. Restrict to a shell-safe absolute
  // Linux path, rather than relying on the host OS's path semantics or quoting.
  if (
    typeof directory !== 'string' ||
    !/^\/[A-Za-z0-9_./-]*$/.test(directory) ||
    containsControls(directory) ||
    directory.includes('//') ||
    directory.split('/').some((part) => part === '.' || part === '..')
  ) {
    invalidConfig();
  }
  return directory.endsWith('/') ? directory.slice(0, -1) : directory;
}

/** Validate structure only. Never read static header values or bearer tokens. */
function describeServers(servers: MCPConfig[]): CoworkMcpServer[] {
  if (!Array.isArray(servers)) invalidConfig();
  const labels = new Set<string>();
  const urls = new Set<string>();
  return Array.from(servers, (server) => {
    if (
      !isRecord(server) ||
      server.transport !== 'http' ||
      Object.keys(server).some((key) => !SERVER_KEYS.has(key)) ||
      typeof server.label !== 'string' ||
      !LABEL_PATTERN.test(server.label) ||
      containsControls(server.label) ||
      labels.has(server.label)
    ) {
      invalidConfig();
    }
    const url = normalizeUrl(server.serverUrl);
    if (urls.has(url)) invalidConfig();
    labels.add(server.label);
    urls.add(url);

    let headerNames: string[] = [];
    if (server.headers !== undefined) {
      if (!isRecord(server.headers)) invalidConfig();
      headerNames = Object.keys(server.headers);
    }
    const normalizedNames = headerNames.map((name) => name.toLowerCase());
    if (
      headerNames.some(
        (name) => !HEADER_NAME_PATTERN.test(name) || containsControls(name)
      ) ||
      new Set(normalizedNames).size !== headerNames.length
    ) {
      invalidConfig();
    }

    let authKeys: string[] = [];
    if (server.auth !== undefined) {
      if (!isRecord(server.auth)) invalidConfig();
      authKeys = Object.keys(server.auth);
      if (authKeys.some((key) => !AUTH_KEYS.has(key)) || authKeys.length > 1) {
        invalidConfig();
      }
    }
    const bearerConfigured = authKeys.length > 0;
    if (bearerConfigured && normalizedNames.includes('authorization')) {
      invalidConfig();
    }
    const needsHelper = headerNames.length > 0 || bearerConfigured;
    return {
      label: server.label,
      url,
      ...(needsHelper ? { helperName: `mcp-${server.label}-headers.sh` } : {}),
    };
  });
}

/** Build secret-free managed settings without resolving environment variables. */
export function createCoworkMcpPlan(
  servers: MCPConfig[],
  helperDirectory: string,
  setup?: CoworkSetupConfig
): { settings: CoworkMcpSettings; servers: CoworkMcpServer[] } {
  const { approveWriteTools } = resolveCoworkSetupConfig(setup);
  const directory = validateHelperDirectory(helperDirectory);
  const descriptions = describeServers(servers);
  return {
    settings: {
      managedMcpServers: descriptions.map((server) => ({
        name: server.label,
        transport: 'http',
        url: server.url,
        ...(approveWriteTools ? { toolPolicy: { '*': 'allow' as const } } : {}),
        ...(server.helperName
          ? { headersHelper: `${directory}/${server.helperName}` }
          : {}),
      })),
      allowedMcpServers: descriptions.map((server) => ({
        serverName: server.label,
      })),
      allowManagedMcpServersOnly: true,
    },
    servers: descriptions,
  };
}

function validateHeaderValue(value: unknown): string {
  // Permit HTTP field-value bytes, but no controls (including tabs), C1
  // controls, or characters that cannot be represented as header bytes.
  if (typeof value !== 'string' || /[^\x20-\x7e\xa0-\xff]/u.test(value)) {
    invalidHeaders();
  }
  return value;
}

/** Resolve secrets only at runtime, using the supplied environment exclusively. */
export function resolveCoworkMcpHeaders(
  servers: MCPConfig[],
  env: Record<string, string | undefined>
): Record<string, Record<string, string>> {
  const descriptions = describeServers(servers);
  if (!isRecord(env)) invalidHeaders();
  return Object.fromEntries(
    descriptions.map((description, index) => {
      // describeServers has validated the transport and all relevant metadata.
      const server = servers[index] as HttpMCPConfig;
      const entries = Object.entries(server.headers ?? {}).map(
        ([name, value]) => [name, validateHeaderValue(value)]
      );
      const auth = server.auth;
      if (auth && Object.keys(auth).length > 0) {
        let token: unknown;
        if (Object.hasOwn(auth, 'accessTokenEnv')) {
          const name = auth.accessTokenEnv;
          if (
            typeof name !== 'string' ||
            !ENV_NAME_PATTERN.test(name) ||
            containsControls(name)
          ) {
            invalidHeaders();
          }
          token = Object.hasOwn(env, name) ? env[name] : undefined;
        } else {
          token = auth.accessToken;
        }
        // RFC 6750 b64token: disallow whitespace and header injection, without
        // requiring a particular provider's token format or decoding the token.
        if (
          typeof token !== 'string' ||
          !/^[A-Za-z0-9._~+/-]+=*$/.test(token) ||
          containsControls(token)
        ) {
          invalidHeaders();
        }
        entries.push(['Authorization', `Bearer ${token}`]);
      }
      return [description.label, Object.fromEntries(entries)];
    })
  );
}
