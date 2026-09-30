import { describe, expect, it } from 'vitest';
import { inferenceOnlyManagedPreferences } from './macManagedPreferences.js';

describe('read-only managed inference exception', () => {
  it('allows only the narrow inference routing keys', () => {
    expect(
      inferenceOnlyManagedPreferences({
        inferenceProvider: 'gateway',
        inferenceCredentialHelper: '/trusted/helper',
        inferenceModels: ['model'],
        modelDiscoveryEnabled: false,
      })
    ).toBe(true);
  });
  it.each([
    'managedMcpServers',
    'mcpServers',
    'allowedMcpServers',
    'allowManagedMcpServersOnly',
    'toolPolicy',
    'allowedPluginMarketplaces',
    'autoUpdate',
    'unknownKey',
  ])('rejects managed %s even beside valid inference settings', (key) => {
    expect(
      inferenceOnlyManagedPreferences({
        inferenceProvider: 'gateway',
        [key]: [],
      })
    ).toBe(false);
  });
  it.each([null, [], 'inferenceProvider', 42])(
    'rejects malformed content: %j',
    (value) => {
      expect(inferenceOnlyManagedPreferences(value)).toBe(false);
    }
  );
});
