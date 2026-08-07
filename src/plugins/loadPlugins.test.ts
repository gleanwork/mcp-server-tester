import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPluginModule } from './loadPlugins.js';

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
  return dir;
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
    const mod = await import(new URL('./index.mjs', `file://${pluginDir}/`).href);
    expect(mod.wasCalled()).toBe(true);
  });

  it('invokes registerGleanJudges export', async () => {
    const pluginDir = makeTempPlugin(`
      export const registerGleanJudges = () => {};
    `);

    await expect(loadPluginModule(pluginDir)).resolves.toBeUndefined();
  });

  it('throws when no register export exists', async () => {
    const pluginDir = makeTempPlugin(`
      export const noop = () => {};
    `);

    await expect(loadPluginModule(pluginDir)).rejects.toThrow(/does not export a register function/);
  });
});
