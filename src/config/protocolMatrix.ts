import type { ProtocolSetting } from '../types/index.js';
import type { MCPConfig } from './mcpConfig.js';

/**
 * The subset of a Playwright project that {@link protocolMatrix} reads.
 */
export interface ProtocolMatrixProject {
  name?: string;
  use?: { mcpConfig?: MCPConfig } & Record<string, unknown>;
}

/** A project produced by {@link protocolMatrix}. */
export type ProtocolMatrixEntry<T extends ProtocolMatrixProject> = Omit<
  T,
  'name' | 'use'
> & {
  name: string;
  use: NonNullable<T['use']> & { mcpProtocol: ProtocolSetting };
};

/**
 * Expands one Playwright project into one project per protocol setting.
 *
 * Each copy is named `<name>@<protocol>` and sets both the `mcpProtocol`
 * fixture option and `mcpConfig.protocol`, so fixtures, evals, and conformance
 * checks all run against the same protocol.
 *
 * @example
 * ```ts
 * export default defineConfig({
 *   projects: [
 *     ...protocolMatrix(
 *       { name: 'docs', use: { mcpConfig } },
 *       ['legacy', '2026-07-28']
 *     ),
 *   ],
 * });
 * // → projects "docs@legacy" and "docs@2026-07-28"
 * ```
 */
export function protocolMatrix<T extends ProtocolMatrixProject>(
  project: T,
  protocols: readonly ProtocolSetting[]
): Array<ProtocolMatrixEntry<T>> {
  if (protocols.length === 0) {
    throw new Error('protocolMatrix() needs at least one protocol setting.');
  }
  const unique = new Set(protocols);
  if (unique.size !== protocols.length) {
    throw new Error('protocolMatrix() received duplicate protocol settings.');
  }
  const baseName = project.name ?? 'mcp';
  return protocols.map((protocol) => {
    const mcpConfig = project.use?.mcpConfig;
    const use = {
      ...project.use,
      mcpProtocol: protocol,
      ...(mcpConfig ? { mcpConfig: { ...mcpConfig, protocol } } : {}),
    } as ProtocolMatrixEntry<T>['use'];
    return { ...project, name: `${baseName}@${protocol}`, use };
  });
}
