import { describe, expect, it } from 'vitest';
import { selectedChatgptServerLabels } from './selection.js';

describe('ChatGPT server selection', () => {
  it('includes the existing first-party server in the measured selection', () => {
    expect([
      ...selectedChatgptServerLabels([], {
        serverName: 'glean_default',
        expectedEmail: 'test@example.com',
        expectedAccountId: '00000000-0000-4000-8000-000000000001',
        expectedOrganizationId: 'org-example123456',
        source: { kind: 'cdp', endpoint: 'http://127.0.0.1:9222' },
        acknowledgeToolPolicyIsNotASandbox: true,
      }),
    ]).toEqual(['glean_default']);
  });

  it('does not attribute account apps or duplicate selected servers', () => {
    expect([
      ...selectedChatgptServerLabels(['glean_default', 'glean_default'], {
        appId: 'glean',
        allowedTools: ['search'],
      }),
    ]).toEqual(['glean_default']);
  });
});
