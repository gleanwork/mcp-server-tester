import type * as Fs from 'node:fs';

/**
 * What a credential helper reads and how it checks it. The generated script
 * holds it as JSON: a path and header names, never a credential.
 */
export type CredentialHelperSpec =
  | {
      kind: 'headers';
      /** A JSON object of the MCP server's headers. */
      path: string;
      /** The header names the file must have: no more, no fewer. */
      names: string[];
      /** `Authorization` must be a bearer token. */
      bearer: boolean;
    }
  | {
      kind: 'inference';
      /** `{ "ANTHROPIC_API_KEY": "<key>" }`. */
      path: string;
    };

const FAILURE: Record<CredentialHelperSpec['kind'], string> = {
  headers: 'Unable to read Cowork MCP runtime headers.\n',
  inference: 'Unable to read Cowork inference credential.\n',
};

/**
 * Reads the credential file `spec` names and returns what its helper prints:
 * the headers as JSON, or the inference key, then a newline. Throws, without
 * saying why, if the file is unsafe or malformed.
 *
 * The file must be a regular file (never a symlink, FIFO or directory) that
 * this user owns and no one else can read, at most 64 KiB, and unchanged
 * while it is read. It must be UTF-8 JSON without a BOM or duplicate keys.
 *
 * The generated script runs this function's own source
 * (`credentialHelperScript`). Its body may use only its parameters and
 * Node's globals: no imports, module constants or other functions. The
 * script tests in `credentialHelper.test.ts` fail if it uses more, both as
 * Vitest compiles it and as tsx does.
 */
export function readCredential(
  spec: CredentialHelperSpec,
  fs: typeof Fs
): string {
  const limit = 65536;
  const reject: () => never = () => {
    throw new Error('Invalid credential file.');
  };
  const uid = process.getuid?.();
  if (uid === undefined) reject();
  const check = (info: Fs.BigIntStats): void => {
    if (
      !info.isFile() ||
      info.uid !== BigInt(uid) ||
      (info.mode & 0o077n) !== 0n ||
      info.size > BigInt(limit)
    )
      reject();
  };

  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(spec.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    check(before);
    for (;;) {
      const read = fs.readSync(
        fd,
        buffer,
        length,
        buffer.length - length,
        null
      );
      if (read === 0) break;
      length += read;
      if (length === buffer.length) break;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    check(after);
    if (
      length > limit ||
      BigInt(length) !== after.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      reject();
  } finally {
    fs.closeSync(fd);
  }

  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(buffer.subarray(0, length));
  const data: unknown = JSON.parse(text);
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    reject();
  const entries = Object.entries(data);
  for (const [, value] of entries) if (typeof value !== 'string') reject();
  // JSON.parse keeps the last of two equal keys. Every value is a string, so
  // a file without duplicates has exactly two strings per key.
  let strings = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    strings++;
    for (i++; text[i] !== '"'; i++) if (text[i] === '\\') i++;
  }
  if (strings !== entries.length * 2) reject();

  if (spec.kind === 'inference') {
    const [only] = entries;
    if (
      entries.length !== 1 ||
      only === undefined ||
      only[0] !== 'ANTHROPIC_API_KEY' ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(String(only[1]))
    )
      reject();
    return `${String(only[1])}\n`;
  }

  if (
    entries.length !== spec.names.length ||
    entries.some(([name]) => !spec.names.includes(name))
  )
    reject();
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      seen.has(name.toLowerCase())
    )
      reject();
    seen.add(name.toLowerCase());
    for (const character of String(value)) {
      const code = character.codePointAt(0) ?? 0;
      if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255)))
        reject();
    }
  }
  if (spec.bearer) {
    const authorization = entries.find(([name]) => name === 'Authorization');
    if (
      authorization === undefined ||
      !/^Bearer [A-Za-z0-9._~+/-]+=*$/.test(String(authorization[1]))
    )
      reject();
  }
  // ASCII only, so the output survives any locale Claude Desktop reads it in.
  const json = JSON.stringify(Object.fromEntries(entries)).replace(
    /[\u0080-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return `${json}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A credential helper for Claude Desktop to run: a shell script that starts
 * `node` (by default the Node that runs MST) on `readCredential` for `spec`,
 * and prints what it returns. On any failure it prints a fixed message to
 * stderr and exits 1. The script holds a path and header names only, never
 * a credential.
 *
 * `env -i` starts Node with an empty environment, so nothing Claude Desktop
 * starts the script with, such as `NODE_OPTIONS`, can load code into the
 * process that reads the credential (ADR 0006).
 */
export function credentialHelperScript(
  spec: CredentialHelperSpec,
  node: string = process.execPath
): string {
  const program = [
    // esbuild's keepNames, which tsx uses even on packages, wraps named
    // functions in __name(). Make it a no-op so the source runs on its own.
    'const __name = (target) => target;',
    `const readCredential = (${readCredential.toString()});`,
    'try {',
    `  process.stdout.write(readCredential(${JSON.stringify(spec)}, require('node:fs')));`,
    '} catch {',
    `  process.stderr.write(${JSON.stringify(FAILURE[spec.kind])});`,
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
  return `#!/bin/sh
exec /usr/bin/env -i ${shellQuote(node)} - <<'MST_CREDENTIAL_HELPER'
${program}
MST_CREDENTIAL_HELPER
`;
}
