import { describe, expect, it } from 'vitest';
import {
  ExternalHostConfigSchema,
  getExternalHostConfigJsonSchema,
  getExternalHostReference,
  listExternalHostDriverReferences,
} from './schema.js';

describe('external host schema and reference', () => {
  it('validates minimal built-in external host config', () => {
    const parsed = ExternalHostConfigSchema.parse({
      driver: 'anthropic.claude.cowork.desktop-app.macos',
      timeoutMs: 60_000,
    });

    expect(parsed).toEqual({
      driver: 'anthropic.claude.cowork.desktop-app.macos',
      timeoutMs: 60_000,
    });
  });

  it('exposes known driver slugs in the JSON schema for editor autocomplete', () => {
    const schema = getExternalHostConfigJsonSchema();
    const driver = (schema.properties as Record<string, unknown>)
      .driver as Record<string, unknown>;
    const choices = driver.anyOf as Array<Record<string, unknown>>;

    expect(choices[0]).toMatchObject({
      type: 'string',
      enum: [
        'anthropic.claude.chat.desktop-app.macos',
        'anthropic.claude.cowork.desktop-app.macos',
      ],
    });
  });

  it('lists built-in drivers with examples and internal capability defaults', () => {
    const references = listExternalHostDriverReferences();
    const cowork = references.find(
      (reference) =>
        reference.slug === 'anthropic.claude.cowork.desktop-app.macos'
    );

    expect(cowork).toMatchObject({
      name: 'Claude Cowork Desktop',
      builtIn: true,
      example: {
        mode: 'external_host',
        externalHost: {
          driver: 'anthropic.claude.cowork.desktop-app.macos',
        },
      },
    });
    expect(cowork?.capabilities?.input).toMatchObject({
      uses: 'builtin:desktop.macos.accessibilitySubmit',
      with: { appName: 'Claude' },
    });
  });

  it('bundles schema and driver references for agents and docs generators', () => {
    const reference = getExternalHostReference();

    expect(reference).toMatchObject({
      schema: { title: 'MCP Server Tester ExternalHostConfig' },
      drivers: expect.any(Array),
    });
  });
});
