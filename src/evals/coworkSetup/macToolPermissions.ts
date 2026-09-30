import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../../mcp/clientFactory.js';
import { installMacToolPermissions } from './macToolPermissionStore.js';

const ERROR = 'Unable to prepare Cowork default tool permissions safely.';
const Property = z
  .object({
    description: z.string().optional(),
    type: z.string().optional(),
    title: z.string().optional(),
  })
  .optional();
const Tool = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
    description: z.string().optional(),
    inputSchema: z
      .object({ properties: z.record(z.string(), z.unknown()).optional() })
      .passthrough(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

// Match the pinned renderer's normalization before computing its approval key.
function normalize(text: string): string {
  for (let i = 0; i < 10; i++) {
    const next = text
      .normalize('NFKC')
      .replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{DI}]/gu, (c) =>
        ['\u200c', '\u200d', '\ufe0e', '\ufe0f'].includes(c) ? c : ''
      )
      .replace(/\p{Cc}/gu, (c) => (['\n', '\t', '\r'].includes(c) ? c : ''))
      .replace(
        /[\u200B\u200E\u200F]|[\u202A-\u202E]|[\u2066-\u2069]|\uFEFF|[\uE000-\uF8FF]|[\uFE00-\uFE0D]|[\u180B-\u180F]|[\u{E0000}-\u{E01EF}]|\u034F|\u115F|\u1160|\u17B4|\u17B5|\u3164|\uFFA0/gu,
        ''
      );
    if (next === text) return text;
    text = next;
  }
  throw new Error(ERROR);
}

// The renderer normalizes nested schema keys as well as strings. Refuse a
// normalization collision instead of silently granting a different schema.
function normalizeTool(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error(ERROR);
  if (typeof value === 'string') return normalize(value);
  if (Array.isArray(value))
    return value.map((entry) => normalizeTool(entry, depth + 1));
  if (value && typeof value === 'object') {
    const entries: [string, unknown][] = [];
    const seen = new Set<string>();
    for (const [key, entry] of Object.entries(value)) {
      const normalized = normalize(key);
      if (normalized === '__proto__' || seen.has(normalized))
        throw new Error(ERROR);
      seen.add(normalized);
      entries.push([normalized, normalizeTool(entry, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

/** Claude 1.52386.6's local connector picker writes enabledKey and an MD5
 * content-fingerprint key. This is app compatibility, not a security hash. */
export function macToolPermissionGrants(
  label: string,
  inventory: unknown[],
  uiFingerprints: Record<string, string | null> = {}
): Record<string, boolean> {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label) || !inventory.length)
    throw new Error(ERROR);
  const grants: Record<string, boolean> = {};
  for (const value of inventory) {
    const tool = Tool.parse(normalizeTool(value));
    // UI resources can add further permission/CSP inputs to the fingerprint.
    // Never guess those grants; the caller must fail before submitting a task.
    if (
      ((tool._meta?.ui as { resourceUri?: unknown } | undefined)
        ?.resourceUri !== undefined ||
        tool._meta?.['ui/resourceUri'] !== undefined) &&
      !Object.hasOwn(uiFingerprints, tool.name)
    )
      throw new Error(ERROR);
    const name = normalize(tool.name);
    // The pinned renderer's connect-local path (mg/pg) uses bare server names
    // unless cowork_snapshot_sync is enabled. The direct-client path (Jh/kr)
    // uses local:<name>. Both address the same isolated evaluation connector.
    const keys = [`${label}:${name}`, `local:${label}:${name}`];
    if (keys.some((key) => Object.hasOwn(grants, key))) throw new Error(ERROR);
    const descriptions = Object.entries(tool.inputSchema.properties ?? {})
      .map(([name, value]) => {
        const parsed = Property.safeParse(value);
        return [
          normalize(name),
          normalize(parsed.success ? (parsed.data?.description ?? '') : ''),
        ];
      })
      .sort(([a], [b]) => a!.localeCompare(b!));
    for (const key of keys) grants[key] = true;
    for (const scope of new Set([null, uiFingerprints[tool.name] ?? null])) {
      const digest = createHash('md5')
        .update(
          JSON.stringify([
            normalize(tool.description ?? ''),
            descriptions,
            scope,
          ])
        )
        .digest('hex');
      for (const key of keys) grants[`${key}-${digest}`] = true;
    }
  }
  return grants;
}

export function macUiPermissionFingerprint(value: unknown): string | null {
  const ui = z
    .object({
      permissions: z
        .object({
          camera: z.object({}).optional(),
          microphone: z.object({}).optional(),
          geolocation: z.object({}).optional(),
          clipboardWrite: z.object({}).optional(),
        })
        .optional(),
      csp: z
        .object({
          connectDomains: z.array(z.string()).optional(),
          resourceDomains: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional()
    .parse(value);
  const parts: string[] = [];
  const permissions = Object.keys(ui?.permissions ?? {}).sort();
  if (permissions.length) parts.push(`perm:${JSON.stringify(permissions)}`);
  for (const [prefix, values] of [
    ['connect', ui?.csp?.connectDomains],
    ['resource', ui?.csp?.resourceDomains],
  ] as const) {
    if (values?.length)
      parts.push(`${prefix}:${JSON.stringify([...new Set(values)].sort())}`);
  }
  return parts.length ? parts.join('|') : null;
}

/** App is stopped; probe only the session-owned launchers, never vendor writes. */
export async function configureMacToolDefaults(
  directory: string,
  labels: string[]
): Promise<void> {
  if (!labels.length) return;
  try {
    const grants: Record<string, boolean> = {};
    for (const label of labels) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label)) throw new Error(ERROR);
      const client = await createMCPClientForConfig({
        transport: 'stdio',
        command: process.execPath,
        args: [
          join(directory, `${label}.cjs`),
          join(directory, `${label}.json`),
        ],
        inheritEnv: false,
        env: {},
        quiet: true,
        connectTimeoutMs: 30000,
      });
      try {
        const { tools } = await client.listTools(undefined, { timeout: 30000 });
        const uiFingerprints: Record<string, string | null> = {};
        for (const tool of tools) {
          const ui = tool._meta?.ui as { resourceUri?: unknown } | undefined;
          const uri = ui?.resourceUri ?? tool._meta?.['ui/resourceUri'];
          if (uri === undefined) continue;
          if (typeof uri !== 'string' || !uri.startsWith('ui://'))
            throw new Error(ERROR);
          const result = await client.readResource({ uri }, { timeout: 30000 });
          if (result.contents.length !== 1) throw new Error(ERROR);
          const resource = result.contents[0]!;
          if (
            !['text/html+mcp', 'text/html;profile=mcp-app'].includes(
              resource.mimeType ?? ''
            )
          )
            throw new Error(ERROR);
          uiFingerprints[tool.name] = macUiPermissionFingerprint(
            resource._meta?.ui
          );
        }
        Object.assign(
          grants,
          macToolPermissionGrants(label, tools, uiFingerprints)
        );
      } finally {
        await closeMCPClient(client);
      }
    }
    await installMacToolPermissions(directory, grants);
  } catch {
    throw new Error(ERROR);
  }
}
