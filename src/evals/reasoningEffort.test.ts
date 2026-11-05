/**
 * `reasoningEffort` has one list of values (ADR 0011). Each client accepts
 * the values of it that its product supports, fails on the others naming
 * the ones it accepts, and fails on a value outside the list as unknown.
 * `mst clients show --json` lists accepted values; text output lists defaults.
 */
import { describe, expect, it } from 'vitest';
import { getClient } from './builtinClients.js';
import { REASONING_EFFORTS } from './reasoningEffort.js';
import { showClient } from '../cli/commands/clients/index.js';

const ACCEPTED = {
  'codex-cli': ['minimal', 'low', 'medium', 'high', 'xhigh'],
  chatgpt: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'codex-app': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
} as const;

const parse = (client: string, reasoningEffort: unknown) =>
  getClient(client).schema.parse({
    type: client,
    model: 'test-model',
    reasoningEffort,
  });

describe('reasoningEffort', () => {
  it('is one list, from least to most effort', () => {
    expect(REASONING_EFFORTS).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it.each(Object.entries(ACCEPTED))(
    '%s accepts its values of the list, and fails on the others naming them',
    (client, accepted) => {
      for (const value of accepted)
        expect(parse(client, value)).toMatchObject({ reasoningEffort: value });
      const values = accepted.join(', ');
      for (const value of REASONING_EFFORTS.filter(
        (effort) => !(accepted as readonly string[]).includes(effort)
      ))
        expect(() => parse(client, value)).toThrow(
          `${client} doesn't support reasoningEffort \`${value}\`: it accepts ${values}.`
        );
      expect(() => parse(client, 'turbo')).toThrow(
        `Unknown reasoningEffort \`turbo\`: the values are minimal, low, medium, high, xhigh, max, ultra, and ${client} accepts ${values}.`
      );
    }
  );

  it('is not an option of api or claude-code, which set no effort', () => {
    for (const client of ['api', 'claude-code'])
      expect(() => parse(client, 'high')).toThrow(/reasoningEffort/);
  });

  it.each(Object.entries(ACCEPTED))(
    'mst clients show %s lists accepted values in JSON and the default in text',
    async (client, accepted) => {
      let json = '';
      await showClient(client, { json: true }, (text) => (json += text));
      const option = (
        JSON.parse(json) as {
          options: {
            properties: Record<
              string,
              { enum?: string[]; description?: string }
            >;
          };
        }
      ).options.properties.reasoningEffort!;
      expect(option.enum).toEqual(accepted);
      expect(option.description).toBe(
        `How hard the model reasons. ${client} accepts ${accepted.join(', ')}, of minimal, low, medium, high, xhigh, max, ultra.`
      );
      let text = '';
      await showClient(client, {}, (line) => (text += line));
      expect(text).toMatch(
        client === 'codex-cli'
          ? /reasoningEffort\s+Codex default/
          : /reasoningEffort\s+app default/
      );
    }
  );
});
