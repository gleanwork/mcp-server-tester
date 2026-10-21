import { describe, expect, it } from 'vitest';
import {
  checkCandidates,
  checkEditableTools,
  schemaStructure,
} from './optimizationCandidates.js';
import type { ListedServerTools } from './toolSurface.js';

const searchSchema = {
  type: 'object' as const,
  properties: {
    query: { type: 'string', description: 'What to search for.' },
    description: { type: 'boolean', description: 'Include descriptions.' },
    sort: { type: 'string', enum: ['recent', 'relevant'] },
  },
  required: ['query'],
};

const served: ListedServerTools[] = [
  {
    server: 'acme',
    tools: [
      {
        name: 'search',
        description: 'Search the company.',
        inputSchema: searchSchema,
      },
      {
        name: 'chat',
        description: 'Ask the assistant.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  },
  {
    server: 'docs',
    tools: [
      {
        name: 'search',
        description: 'Search docs.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  },
];

function check(
  candidates: unknown,
  rules: { editableTools?: string[]; takenIds?: string[] } = {}
) {
  return checkCandidates(candidates, {
    servedTools: served,
    ...(rules.editableTools ? { editableTools: rules.editableTools } : {}),
    takenIds: new Set(rules.takenIds ?? ['baseline']),
  });
}

describe('schemaStructure', () => {
  it('drops description and title text but keeps a parameter called description', () => {
    expect(
      schemaStructure({
        title: 'Search',
        ...searchSchema,
        anyOf: [{ description: 'x', required: ['query'] }],
      })
    ).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string' },
        description: { type: 'boolean' },
        sort: { type: 'string', enum: ['recent', 'relevant'] },
      },
      required: ['query'],
      anyOf: [{ required: ['query'] }],
    });
  });
});

describe('checkCandidates', () => {
  it('accepts a description and parameter text change on a qualified key', () => {
    const { variants, problems } = check([
      {
        id: 'clearer',
        description: 'Say what search covers',
        tools: {
          'acme.search': {
            description: 'Search every connected app.',
            inputSchema: {
              ...searchSchema,
              properties: {
                ...searchSchema.properties,
                query: {
                  type: 'string',
                  description: 'Keywords, not a question.',
                },
              },
            },
          },
        },
      },
    ]);
    expect(problems).toEqual([]);
    expect(variants.map((v) => v.id)).toEqual(['clearer']);
  });

  it('refuses a schema change beyond text', () => {
    const { problems } = check([
      {
        id: 'reorder',
        tools: {
          'acme.search': {
            inputSchema: { ...searchSchema, required: ['query', 'sort'] },
          },
        },
      },
    ]);
    expect(problems).toEqual([
      expect.stringContaining(
        'inputSchema changes more than description and title text'
      ),
    ]);
  });

  it('refuses a key that names no tool or several', () => {
    const { problems } = check([
      { id: 'a', tools: { serach: { description: 'x' } } },
      { id: 'b', tools: { search: { description: 'x' } } },
    ]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/Candidate "a".*serach/);
    expect(problems[1]).toMatch(/Candidate "b"/);
  });

  it('refuses tools outside the editable set', () => {
    const { problems } = check(
      [{ id: 'a', tools: { 'acme.chat': { description: 'x' } } }],
      { editableTools: ['acme.search'] }
    );
    expect(problems).toEqual([
      expect.stringContaining(
        "can't change this tool. Editable tools: acme.search"
      ),
    ]);
  });

  it('refuses taken, repeated and malformed ids, unknown fields and empty tools', () => {
    const { problems, variants } = check([
      { id: 'baseline', tools: { 'acme.search': { description: 'x' } } },
      { id: 'a', tools: { 'acme.search': { description: 'x' } } },
      { id: 'a', tools: { 'acme.search': { description: 'y' } } },
      { id: 'has space', tools: {} },
      { id: 'b', tools: {}, notes: 'x' },
      {
        id: 'c',
        tools: { 'acme.search': { annotations: {}, description: '' } },
      },
    ]);
    expect(variants.map((v) => v.id)).toEqual(['a']);
    expect(problems.join('\n')).toMatch(/"baseline": the id is taken/);
    expect(problems.join('\n')).toMatch(/Candidate "a": the id is taken/);
    expect(problems.join('\n')).toMatch(/Candidate 4's id/);
    expect(problems.join('\n')).toMatch(/unknown field "notes"/);
    expect(problems.join('\n')).toMatch(/tools must map at least one tool/);
    expect(problems.join('\n')).toMatch(/"annotations" can't change/);
    expect(problems.join('\n')).toMatch(
      /description must be a non-empty string/
    );
  });

  it('refuses something that is not a list', () => {
    expect(check({ id: 'a' }).problems[0]).toMatch(/JSON array/);
  });
});

describe('checkEditableTools', () => {
  it('accepts bare and qualified names that match one tool', () => {
    expect(() =>
      checkEditableTools(['chat', 'docs.search'], served)
    ).not.toThrow();
  });

  it('names the tools there are when one matches none or several', () => {
    expect(() => checkEditableTools(['search', 'chta'], served)).toThrow(
      'No single served tool is called "search", "chta". The servers serve: acme.search, acme.chat, docs.search.'
    );
  });
});
