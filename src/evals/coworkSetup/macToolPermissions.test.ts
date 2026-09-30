import { describe, expect, it } from 'vitest';
import {
  macToolPermissionGrants,
  macUiPermissionFingerprint,
} from './macToolPermissions.js';
const send = {
  name: 'slack_send_message',
  description: 'Say hi',
  inputSchema: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Text' },
      channel_id: { type: 'string', description: 'Recipient' },
    },
  },
  annotations: { readOnlyHint: false },
};
describe('pinned Mac connector defaults', () => {
  it('covers both pinned local naming paths without changing write annotations', () => {
    expect(macToolPermissionGrants('slack', [send])).toEqual({
      'slack:slack_send_message': true,
      'slack:slack_send_message-4ff89ea7be6748f5f108bd891558bbfc': true,
      'local:slack:slack_send_message': true,
      'local:slack:slack_send_message-4ff89ea7be6748f5f108bd891558bbfc': true,
    });
    expect(send.annotations.readOnlyHint).toBe(false);
    expect(
      macToolPermissionGrants('slack', [{ ...send, description: 'Changed' }])
    ).not.toHaveProperty(
      'local:slack:slack_send_message-4ff89ea7be6748f5f108bd891558bbfc'
    );
  });
  it.each([false, true])(
    'resolves a content-bound grant with snapshot sync %s',
    (snapshotSync) => {
      const settings = macToolPermissionGrants('slack', [send]);
      // Pinned mg/pg constructs this key before Xj reads enabled_mcp_tools.
      const enabledKey = `${snapshotSync ? 'local:slack' : 'slack'}:${send.name}`;
      expect(settings[enabledKey]).toBe(true);
      expect(settings[`${enabledKey}-4ff89ea7be6748f5f108bd891558bbfc`]).toBe(
        true
      );
      expect(
        macToolPermissionGrants('slack', [{ ...send, description: 'Changed' }])[
          `${enabledKey}-4ff89ea7be6748f5f108bd891558bbfc`
        ]
      ).toBeUndefined();
      expect(settings[`other:${send.name}`]).toBeUndefined();
    }
  );
  it('matches pinned Unicode normalization', () => {
    expect(
      macToolPermissionGrants('slack', [
        { ...send, description: 'Ｓay\u200b hi' },
      ])
    ).toEqual(macToolPermissionGrants('slack', [send]));
  });
  it('requires UI metadata and binds grants to its permission and CSP scope', () => {
    const tool = { ...send, _meta: { ui: { resourceUri: 'ui://draft' } } };
    expect(() => macToolPermissionGrants('slack', [tool])).toThrow();
    const scope = macUiPermissionFingerprint({
      permissions: { clipboardWrite: {} },
      csp: { connectDomains: ['https://example.test', 'https://example.test'] },
    });
    expect(scope).toBe(
      'perm:["clipboardWrite"]|connect:["https://example.test"]'
    );
    expect(
      macToolPermissionGrants('slack', [tool], { slack_send_message: scope })
    ).toEqual({
      'slack:slack_send_message': true,
      'slack:slack_send_message-4ff89ea7be6748f5f108bd891558bbfc': true,
      'slack:slack_send_message-9829595ef4ce3588520dea91c3d01932': true,
      'local:slack:slack_send_message': true,
      'local:slack:slack_send_message-4ff89ea7be6748f5f108bd891558bbfc': true,
      'local:slack:slack_send_message-9829595ef4ce3588520dea91c3d01932': true,
    });
  });
  it('normalizes schema keys and rejects normalization collisions', () => {
    const properties = {
      message: { ｄescription: 'Text', type: 'string' },
      channel_id: { description: 'Recipient', type: 'string' },
    };
    expect(
      macToolPermissionGrants('slack', [
        { ...send, inputSchema: { type: 'object', properties } },
      ])
    ).toEqual(macToolPermissionGrants('slack', [send]));
    expect(() =>
      macToolPermissionGrants('slack', [
        { ...send, inputSchema: { properties: { A: {}, Ａ: {} } } },
      ])
    ).toThrow();
  });
  it('accepts visibility-only tool metadata without a resource fingerprint', () => {
    expect(
      macToolPermissionGrants('slack', [
        { ...send, _meta: { ui: { visibility: ['model'] } } },
      ])
    ).toEqual(macToolPermissionGrants('slack', [send]));
  });
  it('strips unknown UI permissions just as the pinned resource schema does', () => {
    expect(
      macUiPermissionFingerprint({
        permissions: { clipboardWrite: {}, futurePermission: {} },
      })
    ).toBe('perm:["clipboardWrite"]');
    expect(() =>
      macUiPermissionFingerprint({ permissions: { camera: true } })
    ).toThrow();
  });
  it('rejects empty or ambiguous inventories and unsafe labels', () => {
    expect(() => macToolPermissionGrants('slack', [])).toThrow();
    expect(() => macToolPermissionGrants('../slack', [send])).toThrow();
    expect(() => macToolPermissionGrants('slack', [send, send])).toThrow();
    expect(() =>
      macUiPermissionFingerprint({ csp: { connectDomains: [false] } })
    ).toThrow();
  });
});
