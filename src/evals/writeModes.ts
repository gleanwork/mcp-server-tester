/**
 * Write modes (ADR 0014): how each server in a variant handles a write, known
 * before the run starts, or the run doesn't start.
 *
 * - `planned`, `simulated`: the dry-run proxy stops each write and records it.
 * - `server-planned`: the server stops writes itself and marks each one with
 *   the connector's `plannedWriteKey`; the proxy forwards every call and
 *   records each marked result.
 * - `live`: writes reach the service. Needs `--allow-live-writes`, and an
 *   outcome check on every write case.
 * - `unguarded`: MST can't see the server's writes, and the eval config
 *   accepts that (`"writes": { "<label>": "unguarded" }`).
 * - `read-only`: none of the above, so the server must list no tool that
 *   isn't read-only. The load check (`assertWriteModes`) makes sure.
 */
import type { Tool } from '@modelcontextprotocol/client';
import { mcpServerLabel, type MCPConfig } from '../config/mcpConfig.js';
import { isReadOnlyTool } from '../proxy/plannedWrite.js';
import { launchedWriteHandling } from '../proxy/launchedWriteHandling.js';
import type { StoppedWriteMode } from '../proxy/writeRecordLines.js';
import type { WriteMode, DeclaredWriteMode } from '../types/index.js';

export type { WriteMode, DeclaredWriteMode };

/** The modes in which MST records a server's writes. */
function recordsWrites(mode: WriteMode | undefined): boolean {
  return (
    mode === 'planned' || mode === 'simulated' || mode === 'server-planned'
  );
}

export function isStoppedMode(mode: WriteMode): mode is StoppedWriteMode {
  return recordsWrites(mode);
}

/**
 * The write mode a connector's launched `entry` establishes, or `undefined`
 * when it establishes none (a launch that isn't the dry-run proxy, or one
 * that forwards writes with no `plannedWriteKey`). `writes` is what MST gave
 * the launch: a proxy that drops it, or ignores whether to simulate, fails
 * here, because MST would see none of its writes (ADR 0014).
 */
export function launchedWriteMode(
  entry: MCPConfig,
  label: string,
  writes?: { file: string; simulate: boolean }
): WriteMode | undefined {
  const handling = launchedWriteHandling(entry);
  if (!handling.proxy) return undefined;
  if (writes && handling.writeRecord !== writes.file)
    throw new Error(
      `Connector server "${label}" doesn't pass the launch context's writes to its dry-run proxy, so MST can't see its writes. Pass \`writes: context.writes\` to dryRunProxyServer (ADR 0014).`
    );
  if (handling.forwardWrites)
    return handling.plannedWriteKey !== undefined
      ? 'server-planned'
      : undefined;
  if (writes && handling.simulate !== writes.simulate)
    throw new Error(
      `Connector server "${label}" ${writes.simulate ? 'ignores' : 'sets'} simulateWrites: its dry-run proxy ${handling.simulate ? 'simulates' : "doesn't simulate"} writes, and the eval config ${writes.simulate ? 'does' : "doesn't"}. Pass \`writes: context.writes\` to dryRunProxyServer unchanged.`
    );
  return handling.simulate ? 'simulated' : 'planned';
}

/** A variant's servers with their write modes. */
export interface VariantWriteModes {
  variant: string;
  /** By server label. */
  modes: Record<string, WriteMode>;
}

/**
 * Each server's write mode in a variant: what its launch established, else
 * what the eval config's `writes` declares, else `read-only`. A declaration
 * for a server whose launch already established a mode is an error.
 */
export function resolveWriteModes(
  variant: string,
  servers: readonly MCPConfig[],
  established: ReadonlyMap<string, WriteMode>,
  declared: Readonly<Record<string, DeclaredWriteMode>> = {}
): VariantWriteModes {
  const modes: Record<string, WriteMode> = {};
  servers.forEach((server, index) => {
    const label = mcpServerLabel(server, index);
    const launched = established.get(label);
    const declaration = declared[label];
    if (launched && declaration)
      throw new Error(
        `Server "${label}" already has a write mode (${launched}): its connector's dry-run proxy handles its writes. Remove "${label}" from the eval config's \`writes\`.`
      );
    modes[label] = launched ?? declaration ?? 'read-only';
  });
  return { variant, modes };
}

/**
 * The labels of `servers` whose write mode is `read-only`: no launch
 * established one and the eval config declares none. The readiness check
 * refuses a batch where one of them lists a tool that isn't read-only.
 */
export function readOnlyServerLabels(
  servers: readonly MCPConfig[],
  declared: Readonly<Record<string, DeclaredWriteMode>> = {}
): Set<string> {
  const labels = new Set<string>();
  servers.forEach((server, index) => {
    const label = mcpServerLabel(server, index);
    if (launchedWriteMode(server, label) === undefined && !declared[label])
      labels.add(label);
  });
  return labels;
}

/** What the load check needs about the run. */
export interface WriteModeCheck {
  variants: ReadonlyArray<
    VariantWriteModes & {
      servers: readonly MCPConfig[];
      /** The client checks its effective, authenticated tool set before submission. */
      toolsCheckedAfterPrepare?: boolean;
    }
  >;
  /** `--allow-live-writes`. */
  allowLiveWrites: boolean;
  allowMixedWriteModes?: boolean;
  /** The cases that list writes in `expected.writes`, with the servers they name. */
  writeCases: ReadonlyArray<{ id: string; servers: readonly string[] }>;
  /** The eval config's `writes`, to check it names real servers. */
  declared?: Readonly<Record<string, DeclaredWriteMode>>;
  /**
   * Lists a server's tools, or returns `undefined` when this machine can't
   * launch it (a client resolves it). A server it can't list here, or whose
   * listing fails, is left to the readiness check before its first trial.
   */
  listTools: (server: MCPConfig) => Promise<readonly Tool[] | undefined>;
  /** Receives a line for each server left to the readiness check. */
  log?: (line: string) => void;
}

/**
 * The load check (ADR 0014). Throws, naming the servers, when:
 *
 * - a server is `live` without `--allow-live-writes`, or with write cases
 *   (they need an outcome check, which MST doesn't have yet);
 * - compared variants' servers stop writes in different ways (planned,
 *   simulated, server-planned), so the same request gets different replies;
 * - a case lists writes MST can't see: to a server whose writes it doesn't
 *   record, or in a variant where it records none;
 * - a `read-only` server lists a tool that isn't read-only.
 */
export async function assertWriteModes(check: WriteModeCheck): Promise<void> {
  const labels = new Set(
    check.variants.flatMap(({ modes }) => Object.keys(modes))
  );
  const unknown = Object.keys(check.declared ?? {}).filter(
    (label) => !labels.has(label)
  );
  if (unknown.length > 0)
    throw new Error(
      `The eval config's \`writes\` names no server: ${unknown.join(', ')}. Its keys are server labels (${[...labels].join(', ') || 'none'}).`
    );
  const live = check.variants.flatMap(({ variant, modes }) =>
    Object.entries(modes)
      .filter(([, mode]) => mode === 'live')
      .map(([label]) => `${label} (${variant})`)
  );
  if (live.length > 0 && !check.allowLiveWrites)
    throw new Error(
      `Writes reach the service on ${live.join(', ')}: run with --allow-live-writes to allow that.`
    );
  if (live.length > 0 && check.writeCases.length > 0)
    throw new Error(
      `Writes reach the service on ${live.join(', ')}, and cases ${check.writeCases.map((c) => c.id).join(', ')} list writes: a live write case needs an outcome check, which MST doesn't have yet (ADR 0014). Run them with a dry-run proxy.`
    );

  for (const { variant, modes } of check.variants) {
    const recorded = Object.entries(modes)
      .filter(([, mode]) => recordsWrites(mode))
      .map(([label]) => label);
    for (const writeCase of check.writeCases) {
      const unseen = writeCase.servers.filter(
        (server) => !recorded.includes(server)
      );
      if (unseen.length > 0 || recorded.length === 0)
        throw new Error(
          `Case "${writeCase.id}" lists writes MST can't see in variant "${variant}": ${
            unseen.length > 0
              ? unseen
                  .map(
                    (server) =>
                      `"${server}" is ${modes[server] ?? 'not one of its servers'}`
                  )
                  .join(', ')
              : 'none of its servers is behind a dry-run proxy'
          }. The writes grader reads the write record, which only a dry-run proxy keeps; check those calls with toolsTriggered instead.`
        );
    }
  }

  if (check.variants.length > 1) {
    const byMode = new Map<StoppedWriteMode, string[]>();
    for (const { variant, modes } of check.variants)
      for (const [label, mode] of Object.entries(modes))
        if (isStoppedMode(mode))
          byMode.set(mode, [
            ...(byMode.get(mode) ?? []),
            `${label} (${variant})`,
          ]);
    if (byMode.size > 1) {
      const unsafe = check.variants.flatMap(({ variant, modes }) =>
        Object.entries(modes)
          .filter(([, mode]) => mode === 'live' || mode === 'unguarded')
          .map(([label, mode]) => `${label} (${variant}): ${mode}`)
      );
      if (!check.allowMixedWriteModes || unsafe.length > 0)
        throw new Error(
          `The variants compared get different replies to a write: ${[...byMode]
            .map(([mode, servers]) => `${mode} on ${servers.join(', ')}`)
            .join('; ')}. ${
            unsafe.length > 0 && check.allowMixedWriteModes
              ? `Mixed write modes cannot be compared with live or unguarded servers: ${unsafe.join(', ')}.`
              : 'Give every server the same write mode, or opt in to mixed stopped-write modes (ADR 0014).'
          }`
        );
    }
  }

  // Each read-only server once, however many variants use it. One this
  // machine can't list (a client resolves it, or it is down) is checked by
  // the readiness check before its first trial, which retries it; this check
  // stops the run before any trial when it can.
  const checked = new Set<string>();
  const problems: string[] = [];
  const log = check.log ?? ((line: string) => console.warn(line));
  for (const { servers, modes, toolsCheckedAfterPrepare } of check.variants)
    for (const [index, server] of servers.entries()) {
      if (toolsCheckedAfterPrepare) continue;
      const label = mcpServerLabel(server, index);
      if (modes[label] !== 'read-only') continue;
      const key = JSON.stringify(server);
      if (checked.has(key)) continue;
      checked.add(key);
      let tools: readonly Tool[] | undefined;
      try {
        tools = await check.listTools(server);
      } catch (error) {
        log(
          `[mst] Couldn't list server "${label}"'s tools to check that it only reads (${error instanceof Error ? error.message : String(error)}); the readiness check checks it before its first trial.`
        );
        continue;
      }
      const writeTools = (tools ?? [])
        .filter((tool) => !isReadOnlyTool(tool))
        .map((tool) => tool.name);
      if (writeTools.length > 0)
        problems.push(
          `"${label}" lists tools that aren't read-only (${writeTools.join(', ')})`
        );
    }
  if (problems.length > 0)
    throw new Error(
      `MST can't see these servers' writes: ${problems.join('; ')}. Put each behind a connector's dry-run proxy, or accept its writes in the eval config with \`"writes": { "<label>": "unguarded" }\` (ADR 0014).`
    );
}
