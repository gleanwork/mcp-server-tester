import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import {
  judgeIdentity as identityWithPolicy,
  judgeIsVersioned,
  type JudgeVerdictPolicy,
} from './judgeIdentity.js';
import { RUBRIC_JUDGE } from './rubricJudge.js';
import type * as Rubrics from './rubrics.js';
import {
  stagedPairwiseJudge,
  type StagedJudgeBundle,
} from './agentic/stagedJudge.js';
import { agenticJudge } from './agentic/agenticJudge.js';

afterEach(() => {
  resetPluginsForTests();
  vi.doUnmock('./rubrics.js');
  vi.resetModules();
});

const HEX64 = /^[0-9a-f]{64}$/;

const POLICY: JudgeVerdictPolicy = { threshold: 0.7, reps: 1 };

/** An identity under the default verdict policy. */
function judgeIdentity(
  reference: string,
  definition: Parameters<typeof identityWithPolicy>[1],
  options: Record<string, unknown>
): string {
  return identityWithPolicy(reference, definition, options, POLICY);
}

const schema = z.object({ level: z.string().default('strict') }).passthrough();

function judge(version?: string) {
  return {
    schema,
    evaluate: async () => ({ score: 1 }),
    ...(version !== undefined && { version }),
  };
}

function install(meta: { version?: string }, judgeVersion?: string) {
  const definition = judge(judgeVersion);
  installPlugins([
    {
      meta: { name: 'acme-plugin', namespace: 'acme', ...meta },
      judges: { quality: definition },
    },
  ]);
  return definition;
}

describe('judgeIdentity', () => {
  it('is a SHA-256 hash, the same for the same options in any key order', () => {
    const definition = install({});
    const a = judgeIdentity('acme/judge/quality', definition, {
      level: 'strict',
      model: 'm',
    });
    const b = judgeIdentity('acme/judge/quality', definition, {
      model: 'm',
      level: 'strict',
    });
    expect(a).toMatch(HEX64);
    expect(b).toBe(a);
  });

  it('changes with the options', () => {
    const definition = install({});
    expect(
      judgeIdentity('acme/judge/quality', definition, { model: 'a' })
    ).not.toBe(judgeIdentity('acme/judge/quality', definition, { model: 'b' }));
  });

  it("counts an option's default: leaving it out is the same as setting it", () => {
    const definition = install({});
    expect(judgeIdentity('acme/judge/quality', definition, {})).toBe(
      judgeIdentity('acme/judge/quality', definition, { level: 'strict' })
    );
  });

  it("changes with the judge's version", () => {
    const v1 = judgeIdentity('acme/judge/quality', install({}, '1'), {});
    resetPluginsForTests();
    const v2 = judgeIdentity('acme/judge/quality', install({}, '2'), {});
    expect(v2).not.toBe(v1);
  });

  it("uses the plugin's version when the judge declares none", () => {
    const v1 = judgeIdentity(
      'acme/judge/quality',
      install({ version: '1.0.0' }),
      {}
    );
    resetPluginsForTests();
    const v2 = judgeIdentity(
      'acme/judge/quality',
      install({ version: '1.1.0' }),
      {}
    );
    expect(v2).not.toBe(v1);
  });

  it("ignores the plugin's version when the judge declares its own", () => {
    const v1 = judgeIdentity(
      'acme/judge/quality',
      install({ version: '1.0.0' }, 'prompt-7'),
      {}
    );
    resetPluginsForTests();
    const v2 = judgeIdentity(
      'acme/judge/quality',
      install({ version: '1.1.0' }, 'prompt-7'),
      {}
    );
    expect(v2).toBe(v1);
  });

  it('differs between two judges with the same options', () => {
    const definition = judge('1');
    expect(judgeIdentity('acme/judge/a', definition, {})).not.toBe(
      judgeIdentity('acme/judge/b', definition, {})
    );
  });

  it('names a built-in the same with or without mst/judge/', () => {
    const options = { rubric: 'correctness' };
    expect(judgeIdentity('mst/judge/rubric', RUBRIC_JUDGE, options)).toBe(
      judgeIdentity('rubric', RUBRIC_JUDGE, options)
    );
  });

  it('changes with the pass threshold and the repetitions', () => {
    const definition = install({});
    const base = identityWithPolicy(
      'acme/judge/quality',
      definition,
      {},
      POLICY
    );
    expect(
      identityWithPolicy('acme/judge/quality', definition, {}, { ...POLICY })
    ).toBe(base);
    expect(
      identityWithPolicy(
        'acme/judge/quality',
        definition,
        {},
        {
          ...POLICY,
          threshold: 0.9,
        }
      )
    ).not.toBe(base);
    expect(
      identityWithPolicy(
        'acme/judge/quality',
        definition,
        {},
        {
          ...POLICY,
          reps: 3,
        }
      )
    ).not.toBe(base);
  });

  it('hashes the options as given when the schema rejects them', () => {
    expect(
      judgeIdentity('rubric', RUBRIC_JUDGE, { rubric: 'no-such-rubric' })
    ).toMatch(HEX64);
  });
});

describe('built-in and helper judges declare a version', () => {
  it('the rubric judge has one, which changes when a built-in rubric changes', async () => {
    expect(RUBRIC_JUDGE.version).toMatch(/^[0-9a-f]{16,}$/);
    vi.resetModules();
    vi.doMock('./rubrics.js', async (importOriginal) => {
      const original = await importOriginal<typeof Rubrics>();
      return {
        ...original,
        BUILT_IN_RUBRICS: {
          ...original.BUILT_IN_RUBRICS,
          correctness: `${original.BUILT_IN_RUBRICS.correctness} Be strict.`,
        },
      };
    });
    const changed = await import('./rubricJudge.js');
    expect(changed.RUBRIC_JUDGE.version).not.toBe(RUBRIC_JUDGE.version);
  });

  it("a staged judge's is its bundle's version, or a hash of the bundle", () => {
    const bundle: StagedJudgeBundle = {
      schemaVersion: 1,
      name: 'one-stage',
      files: [{ path: 'prompt.md', content: 'Which is better?' }],
      stages: [
        { id: 'overall', prompt: [{ file: 'prompt.md' }], output: 'verdict' },
      ],
      result: { overall: 'overall' },
    };
    expect(stagedPairwiseJudge(bundle).version).toMatch(HEX64);
    expect(stagedPairwiseJudge({ ...bundle, version: 'v3' }).version).toBe(
      'v3'
    );
  });

  it("an agentic judge's is its spec's version", () => {
    const spec = {
      buildPrompt: async () => ({ prompt: 'Grade it.' }),
      parseScore: () => ({ score: 1 }),
    };
    expect(agenticJudge({ ...spec, version: 'p-2' } as never).version).toBe(
      'p-2'
    );
    expect(agenticJudge(spec as never).version).toBeUndefined();
  });
});

describe('judgeIsVersioned', () => {
  it('is true for a built-in, a judge with a version, or a versioned plugin', () => {
    expect(judgeIsVersioned('rubric', RUBRIC_JUDGE)).toBe(true);
    expect(judgeIsVersioned('mst/judge/rubric', RUBRIC_JUDGE)).toBe(true);
    expect(judgeIsVersioned('acme/judge/quality', install({}, 'q-1'))).toBe(
      true
    );
    resetPluginsForTests();
    expect(
      judgeIsVersioned('acme/judge/quality', install({ version: '1.2.0' }))
    ).toBe(true);
  });

  it('is false when neither the judge nor its plugin has a version', () => {
    expect(judgeIsVersioned('acme/judge/quality', install({}))).toBe(false);
  });
});
