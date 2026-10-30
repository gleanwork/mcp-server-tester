import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as CredentialHelper from './credentialHelper.js';
import {
  credentialHelperScript,
  readCredential,
  type CredentialHelperSpec,
} from './credentialHelper.js';

const TOKEN = 'synthetic-only-token';
let root: string;
let file: string;

function headers(
  names: string[] = ['Authorization'],
  bearer = true
): CredentialHelperSpec {
  return { kind: 'headers', path: file, names, bearer };
}
function inference(): CredentialHelperSpec {
  return { kind: 'inference', path: file };
}
function write(content: string, mode = 0o600): void {
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}
function read(spec: CredentialHelperSpec): string {
  return readCredential(spec, fs);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mst-credential-')));
  file = join(root, 'credential.json');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('readCredential', () => {
  it('returns the headers as ASCII-only JSON', () => {
    const values = {
      "X-!#$%&'*+.^_`|~": 'synthetic "quote" \\ literal $HOME café',
      Authorization: 'Basic synthetic-static',
    };
    write(JSON.stringify(values));
    const output = read(headers(Object.keys(values), false));
    expect(output).toMatch(/^[\x20-\x7e]*\n$/);
    expect(output).toContain('caf\\u00e9');
    expect(JSON.parse(output)).toEqual(values);
  });

  it('returns a bearer token, in any JSON layout', () => {
    write(`{\n  "Authorization" : "Bearer ${TOKEN}=="\n}\n`);
    expect(JSON.parse(read(headers()))).toEqual({
      Authorization: `Bearer ${TOKEN}==`,
    });
  });

  it('returns the inference key and a newline', () => {
    write(JSON.stringify({ ANTHROPIC_API_KEY: TOKEN }));
    expect(read(inference())).toBe(`${TOKEN}\n`);
  });

  it('accepts exactly 64 KiB and rejects one byte more', () => {
    const empty = JSON.stringify({ Authorization: 'Bearer ' });
    const content = JSON.stringify({
      Authorization: `Bearer ${'x'.repeat(65536 - empty.length)}`,
    });
    expect(Buffer.byteLength(content)).toBe(65536);
    write(content);
    expect(JSON.parse(read(headers()))).toEqual(JSON.parse(content));
    write(`${content} `);
    expect(() => read(headers())).toThrow();
  });

  it('reads the file again on every call', () => {
    write(JSON.stringify({ Authorization: 'Bearer first' }));
    expect(read(headers())).toContain('first');
    write(JSON.stringify({ Authorization: 'Bearer rotated' }));
    expect(read(headers())).toContain('rotated');
  });

  it.each([
    ['grows', () => write(JSON.stringify({ Authorization: 'Bearer longer' }))],
    [
      'keeps its size but gets a new mtime',
      () => fs.utimesSync(file, new Date(0), new Date(1_000_000)),
    ],
  ] as const)('rejects a file that %s while it is read', (_, change) => {
    write(JSON.stringify({ Authorization: 'Bearer first' }));
    // Change the file between readCredential's first and last fstat.
    let changed = false;
    const readSync = ((...args: unknown[]) => {
      if (!changed) {
        changed = true;
        change();
      }
      return (fs.readSync as (...a: unknown[]) => number)(...args);
    }) as typeof fs.readSync;
    expect(() => readCredential(headers(), { ...fs, readSync })).toThrow(
      'Invalid credential file.'
    );
    expect(changed).toBe(true);
  });

  it.each(['missing', 'symlink', 'directory', 'fifo', 'public', 'group'])(
    'rejects a %s file',
    (kind) => {
      const target = join(root, 'target.json');
      fs.writeFileSync(target, JSON.stringify({ ANTHROPIC_API_KEY: TOKEN }), {
        mode: 0o600,
      });
      if (kind === 'symlink') fs.symlinkSync(target, file);
      if (kind === 'directory') fs.mkdirSync(file, { mode: 0o700 });
      if (kind === 'fifo')
        expect(spawnSync('/usr/bin/mkfifo', ['-m', '600', file]).status).toBe(
          0
        );
      if (kind === 'public')
        write(JSON.stringify({ ANTHROPIC_API_KEY: TOKEN }), 0o644);
      if (kind === 'group')
        write(JSON.stringify({ ANTHROPIC_API_KEY: TOKEN }), 0o640);
      expect(() => read(inference())).toThrow();
    }
  );

  it.each([
    `not-json-${TOKEN}`,
    '[]',
    '{}',
    'null',
    `"Bearer ${TOKEN}"`,
    JSON.stringify({ Authorization: `Bearer ${TOKEN}`, 'X-Extra': TOKEN }),
    '{"Authorization":"Bearer one","Authorization":"Bearer two"}',
    ...['\r\nX-Injected: yes', '\t', '\u0085', '\u2603', '\u{1f600}'].map(
      (suffix) => JSON.stringify({ Authorization: `Bearer ${TOKEN}${suffix}` })
    ),
    '{"Authorization":42}',
    '{"Authorization":{"nested":"Bearer x"}}',
    '{"Authorization":"Basic synthetic"}',
    '{"Authorization":"Bearer two words"}',
    JSON.stringify({ 'Authorization\r\nX-Injected': TOKEN }),
    `\ufeff${JSON.stringify({ Authorization: `Bearer ${TOKEN}` })}`,
  ])('rejects malformed headers (#%#)', (payload) => {
    write(payload);
    expect(() => read(headers())).toThrow();
  });

  it('rejects headers whose names differ only in case', () => {
    write(JSON.stringify({ 'X-Key': 'a', 'x-key': 'b' }));
    expect(() => read(headers(['X-Key', 'x-key'], false))).toThrow();
  });

  it('rejects invalid UTF-8', () => {
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.from('{"Authorization":"Basic '),
        Buffer.from([0xc3, 0x28]),
        Buffer.from('"}'),
      ]),
      { mode: 0o600 }
    );
    expect(() => read(headers(['Authorization'], false))).toThrow();
  });

  it.each([
    TOKEN,
    `{"ANTHROPIC_API_KEY":"${TOKEN}","ANTHROPIC_API_KEY":"other"}`,
    '{"ANTHROPIC_API_KEY":"bad value"}',
    `{"ANTHROPIC_API_KEY":"${TOKEN}","OTHER":"x"}`,
    '{"anthropic_api_key":"x"}',
    'a'.repeat(65537),
  ])('rejects a malformed inference credential (#%#)', (payload) => {
    write(payload);
    expect(() => read(inference())).toThrow();
  });
});

describe('credentialHelperScript', () => {
  // The only tests that start a process: they prove the generated script
  // runs readCredential's source on its own, with no imports or closures.
  function run(
    spec: CredentialHelperSpec,
    env: NodeJS.ProcessEnv = {},
    generate = credentialHelperScript
  ) {
    const script = join(root, 'helper.sh');
    fs.writeFileSync(script, generate(spec), { mode: 0o700 });
    return spawnSync(script, [], {
      encoding: 'utf8',
      env,
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    });
  }

  it('prints the headers, ignoring the environment it starts with', () => {
    const hook = join(root, 'hook.cjs');
    fs.writeFileSync(hook, "process.stdout.write('hooked');\n");
    // Shell and JavaScript punctuation in a name stays data in the script.
    const values = {
      "X-!#$%&'*+.^_`|~": 'synthetic "quote" \\ literal $HOME café',
      Authorization: `Bearer ${TOKEN}`,
    };
    write(JSON.stringify(values));
    const result = run(headers(Object.keys(values)), {
      NODE_OPTIONS: `--require ${hook}`,
    });
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual(values);
  });

  it('prints the inference key', () => {
    write(JSON.stringify({ ANTHROPIC_API_KEY: TOKEN }));
    expect(run(inference())).toMatchObject({
      status: 0,
      stdout: `${TOKEN}\n`,
      stderr: '',
    });
  });

  it.each([
    ['headers', 'Unable to read Cowork MCP runtime headers.\n'],
    ['inference', 'Unable to read Cowork inference credential.\n'],
  ] as const)(
    'fails a %s read with a fixed message and no output',
    (kind, message) => {
      write(`{"leak":"${TOKEN}"}`);
      const result = run(kind === 'headers' ? headers() : inference());
      expect(result).toMatchObject({ status: 1, stdout: '', stderr: message });
    }
  );

  it('runs when tsx compiled MST, which rewrites function source', async () => {
    const compiled = (await tsImport(
      './credentialHelper.ts',
      import.meta.url
    )) as typeof CredentialHelper;
    expect(compiled.credentialHelperScript(inference())).toContain('__name(');
    write(JSON.stringify({ ANTHROPIC_API_KEY: TOKEN }));
    expect(run(inference(), {}, compiled.credentialHelperScript)).toMatchObject(
      { status: 0, stdout: `${TOKEN}\n`, stderr: '' }
    );
  });

  it('holds the path and names, never a credential', () => {
    write(JSON.stringify({ Authorization: `Bearer ${TOKEN}` }));
    const script = credentialHelperScript(headers(), "/opt/it's/node");
    expect(script).not.toContain(TOKEN);
    expect(script).toContain(JSON.stringify(file));
    expect(script).toContain(`exec /usr/bin/env -i '/opt/it'\\''s/node' -`);
  });
});
