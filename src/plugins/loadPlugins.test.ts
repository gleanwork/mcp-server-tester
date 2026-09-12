import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPluginModule, loadPlugins } from './loadPlugins.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempPlugin(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-plugin-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'index.mjs'), contents);
  return fs.realpathSync(dir);
}

describe('loadPluginModule', () => {
  it('invokes register export', async () => {
    const pluginDir = makeTempPlugin(`
      let called = false;
      export function register() {
        called = true;
      }
      export function wasCalled() {
        return called;
      }
    `);

    await loadPluginModule(pluginDir);
    const mod = await import(
      new URL('./index.mjs', `file://${pluginDir}/`).href
    );
    expect(mod.wasCalled()).toBe(true);
  });

  it('invokes registerGleanJudges export', async () => {
    const pluginDir = makeTempPlugin(`
      export const registerGleanJudges = () => {};
    `);

    await expect(loadPluginModule(pluginDir)).resolves.toBeUndefined();
  });

  it('shares concurrent registration and caches success across aliases and module copies', async () => {
    const pluginDir = makeTempPlugin(`
      let calls = 0;
      let done = false;
      export async function register() {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        done = true;
      }
      export function state() { return { calls, done }; }
    `);
    const entry = path.join(pluginDir, 'index.mjs');
    const alias = path.join(pluginDir, 'alias.mjs');
    fs.symlinkSync(entry, alias);
    vi.resetModules();
    const secondCopy = await import('./loadPlugins.js');
    await Promise.all([
      loadPluginModule(pluginDir),
      loadPluginModule(entry),
      loadPluginModule(alias),
      secondCopy.loadPluginModule(entry),
    ]);
    await loadPlugins([entry, pluginDir]);
    const mod = await import(pathToFileURL(entry).href);
    expect(mod.state()).toEqual({ calls: 1, done: true });
  });

  it('shares failures with current callers and allows a later retry', async () => {
    const pluginDir = makeTempPlugin(`
      let calls = 0;
      export async function register() {
        calls++;
        await new Promise(resolve => setTimeout(resolve, 10));
        if (calls === 1) throw new Error('temporary failure');
      }
      export function callCount() { return calls; }
    `);
    const attempts = await Promise.allSettled([
      loadPluginModule(pluginDir),
      loadPluginModule(pluginDir),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      'rejected',
      'rejected',
    ]);
    const mod = await import(
      pathToFileURL(path.join(pluginDir, 'index.mjs')).href
    );
    expect(mod.callCount()).toBe(1);
    await loadPluginModule(pluginDir);
    expect(mod.callCount()).toBe(2);
  });

  it('throws when no register export exists', async () => {
    const pluginDir = makeTempPlugin(`
      export const noop = () => {};
    `);

    await expect(loadPluginModule(pluginDir)).rejects.toThrow(
      /does not export a register function/
    );
  });
});
