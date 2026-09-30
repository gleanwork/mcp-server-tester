import { describe, it, expect } from 'vitest';
import {
  recordLegacyHttpTranscript,
  recordLegacyTranscript,
} from '../../tests/mocks/recordLegacyTranscript.js';
import golden from './__fixtures__/legacyWireTranscript.json' with { type: 'json' };
import goldenHttp from './__fixtures__/legacyWireTranscript.http.json' with { type: 'json' };

/**
 * Wire-compatibility guard for the default ('legacy') protocol mode.
 *
 * The golden transcripts were recorded with the MCP TypeScript SDK v1 client
 * on `main` before the v2 migration (release 2.0.0-beta.6), by running
 * `node --import tsx tests/mocks/recordLegacyTranscript.ts stdio|http` in that
 * checkout. With protocol left at its default, MST must send exactly the same
 * messages (and, over HTTP, the same methods and MCP headers: session id,
 * protocol version, standalone GET, session DELETE) so existing servers see
 * no change. Regenerate only for an intended wire change, and call it out in
 * the changelog.
 */
describe('legacy wire compatibility', () => {
  it('sends the same stdio frames as the v1 SDK client', async () => {
    expect(await recordLegacyTranscript()).toEqual(golden);
  }, 30_000);

  it('sends the same HTTP requests as the v1 SDK client', async () => {
    expect(await recordLegacyHttpTranscript()).toEqual(goldenHttp);
  }, 30_000);
});
