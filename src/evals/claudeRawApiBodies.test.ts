import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARTIFACT_LIMITS } from './allArtifacts.js';
import {
  CLAUDE_RAW_API_BODIES_DIR,
  claudeRawApiBodies,
  rawApiBodiesEnv,
  withArtifactBodyRefs,
} from './claudeRawApiBodies.js';
import type {
  HostAttributeValue,
  HostTelemetry,
} from './evalFrameworkTypes.js';

describe('claudeRawApiBodies', () => {
  let dir: string;
  let bodies: string;
  const copies: string[] = [];
  /** What Claude Code writes in file mode, with a credential in a request. */
  const writeBodies = async () => {
    await writeFile(
      join(bodies, 'r1.request.json'),
      JSON.stringify({ model: 'claude-test', system: 'token acme-secret-1' })
    );
    await writeFile(join(bodies, 'req_1.response.json'), '{"id":"msg_1"}');
    await writeFile(
      join(bodies, 'index.jsonl'),
      '{"message_id":"msg_1","request_file":"r1.request.json"}\n'
    );
  };
  const kept = async (options?: Parameters<typeof claudeRawApiBodies>[1]) => {
    const result = await claudeRawApiBodies(dir, options);
    if (result.artifacts) copies.push(result.artifacts.dir);
    return result;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mst-claude-bodies-test-'));
    bodies = join(dir, CLAUDE_RAW_API_BODIES_DIR);
    await mkdir(bodies);
  });
  afterEach(async () => {
    for (const copy of copies.splice(0))
      await rm(copy, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it('names the directory Claude Code writes them in', () => {
    expect(rawApiBodiesEnv(dir)).toEqual({
      OTEL_LOG_RAW_API_BODIES: `file:${bodies}`,
    });
  });

  it('keeps a redacted copy, and counts the requests and responses in it', async () => {
    await writeBodies();
    const result = await kept({ secrets: ['acme-secret-1'] });
    expect(result.telemetry).toEqual({
      requests: 1,
      responses: 1,
      files: 3,
      bytes: expect.any(Number),
    });
    expect(result.artifacts).toMatchObject({
      include: [CLAUDE_RAW_API_BODIES_DIR],
      temporary: true,
    });
    const copy = join(result.artifacts!.dir, CLAUDE_RAW_API_BODIES_DIR);
    expect((await readdir(copy)).sort()).toEqual([
      'index.jsonl',
      'r1.request.json',
      'req_1.response.json',
    ]);
    const request = await readFile(join(copy, 'r1.request.json'), 'utf8');
    expect(request).not.toContain('acme-secret-1');
    expect(request).toContain('[REDACTED]');
  });

  it('keeps none when Claude Code wrote none, and says so', async () => {
    expect(await kept()).toEqual({
      telemetry: {
        requests: 0,
        responses: 0,
        notKept:
          'Claude Code wrote no raw API bodies. Claude Code 2.1.274 or later writes them, unless managed settings turn them off.',
      },
    });
    await rm(bodies, { recursive: true });
    expect((await kept()).telemetry).toMatchObject({ requests: 0 });
  });

  it('keeps none over a limit, and says so', async () => {
    await writeBodies();
    const result = await kept({
      limits: { ...ARTIFACT_LIMITS, fileBytes: 16 },
    });
    expect(result.artifacts).toBeUndefined();
    expect(result.telemetry).toEqual({
      notKept: expect.stringMatching(
        /^The raw API bodies are larger than a trial's artifacts may be: claude-raw-api-bodies\/\S+ is larger than 16 bytes\.$/
      ),
    });
  });

  it('keeps none with a file MST does not copy, and says so', async () => {
    await writeBodies();
    await link(join(bodies, 'r1.request.json'), join(dir, 'outside.json'));
    const result = await kept();
    expect(result.artifacts).toBeUndefined();
    expect(result.telemetry).toEqual({
      notKept:
        "The raw API bodies hold an entry MST doesn't copy: claude-raw-api-bodies/r1.request.json is a hard link.",
    });
  });

  it('does not follow its directory swapped for a link', async () => {
    const elsewhere = join(dir, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'config.json'), '{"apiKey":"x"}');
    await rm(bodies, { recursive: true });
    await symlink(elsewhere, bodies);
    const result = await kept();
    expect(result.artifacts).toBeUndefined();
    expect(result.telemetry).toEqual({
      notKept:
        "The raw API bodies hold an entry MST doesn't copy: claude-raw-api-bodies is a symbolic link.",
    });
  });
});

describe('withArtifactBodyRefs', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mst-claude-bodies-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const host = (
    ...attributes: Array<Record<string, HostAttributeValue>>
  ): HostTelemetry => ({
    events: attributes.map((each) => ({
      name: 'api_request_body',
      time: '2026-01-01T00:00:00.000Z',
      attributes: each,
    })),
  });

  it("names each body's file as it is in the trial's artifacts", async () => {
    // Claude Code may name the directory with its links resolved.
    const real = await realpath(dir);
    const result = withArtifactBodyRefs(
      host(
        {
          body_ref: join(dir, CLAUDE_RAW_API_BODIES_DIR, 'r1.request.json'),
          model: 'claude-test',
        },
        {
          body_ref: join(
            real,
            CLAUDE_RAW_API_BODIES_DIR,
            'req_1.response.json'
          ),
        }
      ),
      dir
    );
    expect(result.events.map((event) => event.attributes)).toEqual([
      {
        body_ref: 'claude-raw-api-bodies/r1.request.json',
        model: 'claude-test',
      },
      { body_ref: 'claude-raw-api-bodies/req_1.response.json' },
    ]);
  });

  it('leaves a body_ref elsewhere, and events without one, as they are', () => {
    const given = host(
      { body_ref: '/elsewhere/r1.request.json' },
      { model: 'claude-test' },
      { body_ref: 3 }
    );
    expect(withArtifactBodyRefs(given, dir)).toEqual(given);
  });
});
