/**
 * The runtime exports of each public entry point (type-only exports aren't
 * pinned). A change here is a change to the public API: add a name to the
 * narrowest tier that fits (see AGENTS.md), note a removal in the migration
 * guides, and update with `npx vitest run src/publicApi.test.ts -u`.
 */
import { describe, expect, it } from 'vitest';
import * as root from './index.js';
import * as auth from './entries/auth.js';
import * as evals from './entries/evals.js';
import * as experimentalHosts from './entries/experimentalHosts.js';
import * as fixturesMcp from './fixtures/mcp.js';
import * as fixturesMcpAuth from './fixtures/mcpAuth.js';

function names(entry: Record<string, unknown>): string[] {
  return Object.keys(entry).sort();
}

describe('public API', () => {
  it('root', () => {
    expect(names(root)).toMatchSnapshot();
  });
  it('./evals', () => {
    expect(names(evals)).toMatchSnapshot();
  });
  it('./auth', () => {
    expect(names(auth)).toMatchSnapshot();
  });
  it('./experimental/hosts', () => {
    expect(names(experimentalHosts)).toMatchSnapshot();
  });
  // Separate bundles that re-export `test` and `expect` on purpose.
  it('./fixtures/mcp and ./fixtures/mcpAuth', () => {
    expect({
      mcp: names(fixturesMcp),
      mcpAuth: names(fixturesMcpAuth),
    }).toMatchSnapshot();
  });
  it('exports each name from one tier', () => {
    const tiers = { root, auth, evals, experimentalHosts };
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [tier, entry] of Object.entries(tiers)) {
      for (const name of names(entry)) {
        const other = seen.get(name);
        if (other) duplicates.push(`${name} (${other}, ${tier})`);
        else seen.set(name, tier);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
