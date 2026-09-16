import { describe, expect, it } from 'vitest';
import { loadEvalManifestFromObject } from '../evalManifest.js';
import { resolveCoworkSetupConfig, type CoworkSetupConfig } from './options.js';

const baseManifest = {
  name: 'setup',
  datasets: [{ type: 'fixture' }],
  servers: [],
};

describe('Cowork setup approval options', () => {
  it.each([
    [undefined, undefined, false],
    [{}, {}, false],
    [{ approveWriteTools: false }, undefined, false],
    [{ approveWriteTools: true }, undefined, true],
    [{ approveWriteTools: true }, {}, true],
    [{ approveWriteTools: true }, { approveWriteTools: false }, false],
    [{ approveWriteTools: false }, { approveWriteTools: true }, true],
  ] as const)('merges %j with %j into %s', (defaults, override, expected) => {
    expect(resolveCoworkSetupConfig(defaults, override)).toEqual({
      approveWriteTools: expected,
    });
  });

  it.each([
    null,
    true,
    [],
    'all',
    { approveWriteTools: 'true' },
    { approveWriteTools: 1 },
    { approveWriteTools: null },
    { approveWriteTool: true },
    { approveWriteTools: true, secret: 'synthetic-private-value' },
  ])(
    'rejects malformed or unknown settings without exposing values: %#',
    (value) => {
      const invalid = value as CoworkSetupConfig;
      for (const args of [
        [invalid, undefined],
        [undefined, invalid],
      ] as const) {
        expect(() => resolveCoworkSetupConfig(...args)).toThrow(
          'Invalid Cowork setup options.'
        );
      }
      for (const input of [
        { ...baseManifest, coworkSetup: value },
        { ...baseManifest, arms: [{ name: 'invalid', coworkSetup: value }] },
      ]) {
        expect(() =>
          loadEvalManifestFromObject(input, { skipDatasetValidation: true })
        ).toThrow();
      }
    }
  );

  it('preserves typed manifest and arm settings through normalization', () => {
    const loaded = loadEvalManifestFromObject(
      {
        ...baseManifest,
        coworkSetup: { approveWriteTools: true },
        arms: [
          {
            name: 'default-approvals',
            coworkSetup: { approveWriteTools: false },
            servers: [],
          },
        ],
      },
      { skipDatasetValidation: true }
    );
    expect(loaded.coworkSetup).toEqual({ approveWriteTools: true });
    expect(loaded.arms?.[0]?.coworkSetup).toEqual({ approveWriteTools: false });
  });
});
