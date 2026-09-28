import { describe, it, expect } from 'vitest';
import { recordLegacyTranscript } from '../../tests/mocks/recordLegacyTranscript.js';
import golden from './__fixtures__/legacyWireTranscript.json' with { type: 'json' };

/**
 * Wire-compatibility guard for the default ('legacy') protocol mode.
 *
 * The golden transcript was recorded with the MCP TypeScript SDK v1 client on
 * the release before the v2 migration (tests/mocks/recordLegacyTranscript.ts).
 * With protocol left at its default, MST must put exactly the same messages on
 * the wire so existing servers see no change. Regenerate only for an intended
 * wire change, and call it out in the changelog.
 */
describe('legacy wire compatibility', () => {
  it('sends the same client frames as the v1 SDK client', async () => {
    const frames = await recordLegacyTranscript();
    expect(frames).toEqual(golden);
  }, 30_000);
});
