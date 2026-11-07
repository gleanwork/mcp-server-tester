import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveRunner } from './builtinRunners.js';
import {
  installPlugins,
  resetPluginsForTests,
} from '../../plugins/extensions.js';
import { assertPlugin } from '../../plugins/plugin.js';
import type { RunnerDefinition } from '../evalFrameworkTypes.js';

afterEach(() => resetPluginsForTests());

const vm: RunnerDefinition = {
  schema: z.object({ zone: z.string().default('us-west1-b') }).strict(),
  maxShards: 5,
  async open() {
    throw new Error('not opened in these tests');
  },
};

function installVm(): void {
  installPlugins([
    { meta: { name: 'acme-plugin', namespace: 'acme' }, runners: { vm } },
  ]);
}

describe('resolveRunner', () => {
  it('is local, one shard, keeping nothing, by default', () => {
    expect(resolveRunner('local', {})).toMatchObject({
      name: 'local',
      shards: 1,
      keep: 'never',
      options: {},
    });
  });

  it('records mst/runner/local by its short name', () => {
    expect(resolveRunner('mst/runner/local', {}).name).toBe('local');
  });

  it('runs local on one shard only', () => {
    expect(() => resolveRunner('local', { shards: '2' })).toThrow(
      'The local runner runs one shard: drop --runner-option shards=2, or use a runner that creates machines.'
    );
    expect(resolveRunner('local', { shards: '1' }).shards).toBe(1);
  });

  it('rejects an option local does not have', () => {
    expect(() => resolveRunner('local', { zone: 'x' })).toThrow(
      'Invalid --runner-option for local'
    );
  });

  it.each(['0', '-1', '1.5', 'two', ''])('rejects shards=%s', (shards) => {
    installVm();
    expect(() => resolveRunner('acme/runner/vm', { shards })).toThrow(
      `--runner-option shards must be a positive integer, got "${shards}"`
    );
  });

  it('checks keep', () => {
    expect(resolveRunner('local', { keep: 'failed' }).keep).toBe('failed');
    expect(() => resolveRunner('local', { keep: 'sometimes' })).toThrow(
      '--runner-option keep must be never, failed or always, got "sometimes"'
    );
  });

  it("parses a plugin runner's own options with its schema", () => {
    installVm();
    expect(
      resolveRunner('acme/runner/vm', { shards: '5', zone: 'eu-west1-a' })
    ).toMatchObject({
      name: 'acme/runner/vm',
      shards: 5,
      options: { zone: 'eu-west1-a' },
    });
    expect(resolveRunner('acme/runner/vm', {}).options).toEqual({
      zone: 'us-west1-b',
    });
    expect(() => resolveRunner('acme/runner/vm', { size: 'big' })).toThrow(
      'Invalid --runner-option for acme/runner/vm'
    );
  });

  it('caps shards at maxShards', () => {
    installVm();
    expect(() => resolveRunner('acme/runner/vm', { shards: '6' })).toThrow(
      'acme/runner/vm runs at most 5 shards: --runner-option shards=6 is more.'
    );
  });

  it('checks the kind, and names the plugin a runner needs', () => {
    expect(() => resolveRunner('acme/judge/x', {})).toThrow(
      '"acme/judge/x" is a judge, not a runner.'
    );
    expect(() => resolveRunner('acme/runner/vm', {})).toThrow(
      'Runner "acme/runner/vm" needs the "acme" plugin, which is not loaded.'
    );
    expect(() => resolveRunner('podman', {})).toThrow(
      'Runner "podman" is not available. Available: docker, local.'
    );
  });

  it('names the runner kind for a reference that uses the old env kind', () => {
    installVm();
    expect(() => resolveRunner('acme/env/vm', {})).toThrow(
      'Runner "acme/env/vm": the `env` kind is now `runner`: use "acme/runner/vm".'
    );
    expect(() => resolveRunner('mst/env/local', {})).toThrow(
      'the `env` kind is now `runner`: use "mst/runner/local".'
    );
  });

  it('names runners for a plugin that still has environments', () => {
    expect(() =>
      assertPlugin(
        { meta: { name: 'acme-plugin', namespace: 'acme' }, environments: {} },
        'inline'
      )
    ).toThrow('Invalid plugin "acme-plugin": `environments` is now `runners`.');
  });
});
