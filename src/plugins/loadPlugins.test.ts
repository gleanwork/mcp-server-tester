import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPlugins } from './loadPlugins.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'mst-plugin-'))
  );
  tempDirs.push(dir);
  return dir;
}

function pluginSource(namespace: string): string {
  return `export default {
    meta: { name: '${namespace}-plugin', version: '1.0.0', namespace: '${namespace}' },
    judges: {
      x: { schema: { safeParse: (v) => ({ success: true, data: v }) }, evaluate: async () => ({ score: 1 }) },
    },
  };`;
}

function write(dir: string, file: string, contents: string): string {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

describe('loadPlugins', () => {
  it('returns the default-exported plugin object', async () => {
    const dir = tempDir();
    write(dir, 'acme.mjs', pluginSource('acme'));

    const [plugin] = await loadPlugins(['./acme.mjs'], { baseDir: dir });

    expect(plugin?.meta.namespace).toBe('acme');
  });

  it('resolves a directory to its index module', async () => {
    const dir = tempDir();
    write(dir, 'acme/index.mjs', pluginSource('acme'));

    const [plugin] = await loadPlugins(['acme'], { baseDir: dir });

    expect(plugin?.meta.namespace).toBe('acme');
  });

  it('tries the base directory, then the fallback directory', async () => {
    const manifestDir = tempDir();
    const cwd = tempDir();
    write(cwd, 'plugins/acme.mjs', pluginSource('acme'));

    const [plugin] = await loadPlugins(['plugins/acme.mjs'], {
      baseDir: manifestDir,
      fallbackDir: cwd,
    });

    expect(plugin?.meta.namespace).toBe('acme');
  });

  it('prefers the base directory when both have the path', async () => {
    const manifestDir = tempDir();
    const cwd = tempDir();
    write(manifestDir, 'p.mjs', pluginSource('near'));
    write(cwd, 'p.mjs', pluginSource('far'));

    const [plugin] = await loadPlugins(['./p.mjs'], {
      baseDir: manifestDir,
      fallbackDir: cwd,
    });

    expect(plugin?.meta.namespace).toBe('near');
  });

  it('resolves a package specifier from the base directory', async () => {
    const dir = tempDir();
    write(
      dir,
      'node_modules/@acme/mst-plugin/package.json',
      JSON.stringify({
        name: '@acme/mst-plugin',
        type: 'module',
        exports: './index.js',
      })
    );
    write(dir, 'node_modules/@acme/mst-plugin/index.js', pluginSource('acme'));

    const [plugin] = await loadPlugins(['@acme/mst-plugin'], { baseDir: dir });

    expect(plugin?.meta.namespace).toBe('acme');
  });

  function writePackage(
    dir: string,
    name: string,
    manifest: Record<string, unknown>,
    files: Record<string, string>
  ): void {
    const packageDir = path.join(dir, 'node_modules', name);
    write(packageDir, 'package.json', JSON.stringify({ name, ...manifest }));
    for (const [file, contents] of Object.entries(files))
      write(packageDir, file, contents);
  }

  it('resolves an ESM-only package through its import condition', async () => {
    const dir = tempDir();
    writePackage(
      dir,
      'esm-only',
      { type: 'module', exports: { '.': { import: './index.js' } } },
      { 'index.js': pluginSource('esm') }
    );

    const [plugin] = await loadPlugins(['esm-only'], { baseDir: dir });

    expect(plugin?.meta.namespace).toBe('esm');
  });

  it('prefers the import build of a dual package', async () => {
    const dir = tempDir();
    writePackage(
      dir,
      'dual',
      {
        exports: {
          '.': { require: './index.cjs', import: './index.mjs' },
        },
      },
      {
        'index.cjs':
          'module.exports = { meta: { name: "dual", namespace: "dualcjs" } };',
        'index.mjs': pluginSource('dualesm'),
      }
    );

    const [plugin] = await loadPlugins(['dual'], { baseDir: dir });

    expect(plugin?.meta.namespace).toBe('dualesm');
  });

  it('loads a CommonJS package, including one compiled from ESM', async () => {
    const dir = tempDir();
    writePackage(
      dir,
      'plain-cjs',
      { main: 'main.js' },
      {
        'main.js':
          'module.exports = { meta: { name: "plain", namespace: "plain" } };',
      }
    );
    writePackage(
      dir,
      'compiled-cjs',
      { main: 'main.js' },
      {
        'main.js':
          'Object.defineProperty(exports, "__esModule", { value: true }); exports.default = { meta: { name: "compiled", namespace: "compiled" } };',
      }
    );

    const plugins = await loadPlugins(['plain-cjs', 'compiled-cjs'], {
      baseDir: dir,
    });

    expect(plugins.map((plugin) => plugin.meta.namespace)).toEqual([
      'plain',
      'compiled',
    ]);
  });

  it('says which subpath a package does not export', async () => {
    const dir = tempDir();
    writePackage(
      dir,
      'narrow',
      { type: 'module', exports: { './other': './other.js' } },
      { 'other.js': pluginSource('narrow') }
    );

    await expect(loadPlugins(['narrow'], { baseDir: dir })).rejects.toThrow(
      'Plugin package "narrow" doesn\'t export "." for import.'
    );
  });

  it('never treats a missing relative path as a package', async () => {
    const root = tempDir();
    write(root, 'package.json', '{}');
    write(root, 'x.mjs', pluginSource('wrong'));
    const evals = path.join(root, 'sub', 'evals');
    fs.mkdirSync(evals, { recursive: true });

    // ../x.mjs from sub/evals is sub/x.mjs, which doesn't exist.
    await expect(loadPlugins(['../x.mjs'], { baseDir: evals })).rejects.toThrow(
      'Plugin "../x.mjs" not found'
    );
    await expect(loadPlugins(['..'], { baseDir: evals })).rejects.toThrow(
      'Plugin ".." not found'
    );
  });

  it('rejects an export target outside the package', async () => {
    const dir = tempDir();
    writePackage(
      dir,
      'escapes',
      { type: 'module', exports: '../outside.js' },
      {}
    );

    await expect(loadPlugins(['escapes'], { baseDir: dir })).rejects.toThrow(
      'Plugin package "escapes" exports "." to "../outside.js", which is not a "./" path inside the package.'
    );
  });

  it('finds a main entry written without its extension', async () => {
    const dir = tempDir();
    writePackage(
      dir,
      'bare-main',
      { main: 'lib/index' },
      {
        'lib/index.js':
          'module.exports = { meta: { name: "bare", namespace: "bare" } };',
      }
    );

    const [plugin] = await loadPlugins(['bare-main'], { baseDir: dir });

    expect(plugin?.meta.namespace).toBe('bare');
  });

  it('requires a default export', async () => {
    const dir = tempDir();
    write(
      dir,
      'named.mjs',
      "export const meta = { name: 'n', namespace: 'n' };"
    );

    await expect(
      loadPlugins(['./named.mjs'], { baseDir: dir })
    ).rejects.toThrow('Plugin at ./named.mjs has no default export.');
  });

  it('returns the same object for repeated and concurrent loads', async () => {
    const dir = tempDir();
    write(dir, 'acme.mjs', pluginSource('acme'));

    const [a, b] = await Promise.all([
      loadPlugins(['./acme.mjs'], { baseDir: dir }),
      loadPlugins(['./acme.mjs'], { baseDir: dir }),
    ]);

    expect(a[0]).toBe(b[0]);
  });

  it('points a 1.x register() plugin at the migration guide', async () => {
    const dir = tempDir();
    write(dir, 'old.mjs', 'export function register() {}');

    await expect(loadPlugins(['./old.mjs'], { baseDir: dir })).rejects.toThrow(
      'exports a function. MST 2.0 plugins are objects'
    );
  });

  it('names the specifier and the places it looked when nothing matches', async () => {
    const dir = tempDir();

    await expect(
      loadPlugins(['./missing.mjs'], { baseDir: dir })
    ).rejects.toThrow(`Plugin "./missing.mjs" not found (looked in ${dir}`);
  });
});
