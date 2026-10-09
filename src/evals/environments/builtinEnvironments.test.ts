import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveEnvironment } from './builtinEnvironments.js';
import {
  installPlugins,
  resetPluginsForTests,
} from '../../plugins/extensions.js';
import type { EnvironmentDefinition } from '../evalFrameworkTypes.js';

afterEach(() => resetPluginsForTests());

const vm: EnvironmentDefinition = {
  schema: z.object({ zone: z.string().default('us-west1-b') }).strict(),
  maxShards: 5,
  async open() {
    throw new Error('not opened in these tests');
  },
};

function installVm(): void {
  installPlugins([
    { meta: { name: 'acme-plugin', namespace: 'acme' }, environments: { vm } },
  ]);
}

describe('resolveEnvironment', () => {
  it('is local, one shard, keeping nothing, by default', () => {
    expect(resolveEnvironment('local', {})).toMatchObject({
      name: 'local',
      shards: 1,
      keep: 'never',
      options: {},
    });
  });

  it('records mst/env/local by its short name', () => {
    expect(resolveEnvironment('mst/env/local', {}).name).toBe('local');
  });

  it('runs local on one shard only', () => {
    expect(() => resolveEnvironment('local', { shards: '2' })).toThrow(
      'The local environment runs one shard: drop --env-option shards=2, or use an environment that creates machines.'
    );
    expect(resolveEnvironment('local', { shards: '1' }).shards).toBe(1);
  });

  it('rejects an option local does not have', () => {
    expect(() => resolveEnvironment('local', { zone: 'x' })).toThrow(
      'Invalid --env-option for local'
    );
  });

  it.each(['0', '-1', '1.5', 'two', ''])('rejects shards=%s', (shards) => {
    installVm();
    expect(() => resolveEnvironment('acme/env/vm', { shards })).toThrow(
      `--env-option shards must be a positive integer, got "${shards}"`
    );
  });

  it('checks keep', () => {
    expect(resolveEnvironment('local', { keep: 'failed' }).keep).toBe('failed');
    expect(() => resolveEnvironment('local', { keep: 'sometimes' })).toThrow(
      '--env-option keep must be never, failed or always, got "sometimes"'
    );
  });

  it("parses a plugin environment's own options with its schema", () => {
    installVm();
    expect(
      resolveEnvironment('acme/env/vm', { shards: '5', zone: 'eu-west1-a' })
    ).toMatchObject({
      name: 'acme/env/vm',
      shards: 5,
      options: { zone: 'eu-west1-a' },
    });
    expect(resolveEnvironment('acme/env/vm', {}).options).toEqual({
      zone: 'us-west1-b',
    });
    expect(() => resolveEnvironment('acme/env/vm', { size: 'big' })).toThrow(
      'Invalid --env-option for acme/env/vm'
    );
  });

  it('caps shards at maxShards', () => {
    installVm();
    expect(() => resolveEnvironment('acme/env/vm', { shards: '6' })).toThrow(
      'acme/env/vm runs at most 5 shards: --env-option shards=6 is more.'
    );
  });

  it('checks the kind, and names the plugin an environment needs', () => {
    expect(() => resolveEnvironment('acme/judge/x', {})).toThrow(
      '"acme/judge/x" is a judge, not an environment.'
    );
    expect(() => resolveEnvironment('acme/env/vm', {})).toThrow(
      'Environment "acme/env/vm" needs the "acme" plugin, which is not loaded.'
    );
    expect(() => resolveEnvironment('docker', {})).toThrow(
      'Environment "docker" is not available. Available: local.'
    );
  });
});
