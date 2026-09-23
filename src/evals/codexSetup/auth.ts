import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { CodexSetupError, runBounded } from './native.js';

const MAX_KEY_BYTES = 8192;
const LOGIN_TIMEOUT_MS = 45_000;
const STATUS_TIMEOUT_MS = 15_000;
const STATUS_OUTPUT_BYTES = 64 * 1024;

/** Read a private 0600 single-key file. The key is returned only to the caller. */
export async function readApiKeyFile(path: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    throw new CodexSetupError('api_key_file_unsafe');
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_KEY_BYTES
    )
      throw new CodexSetupError('api_key_file_unsafe');
    const buffer = Buffer.alloc(MAX_KEY_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let start = 0;
    let end = bytesRead;
    while (start < end && isSpace(buffer[start]!)) start++;
    while (end > start && isSpace(buffer[end - 1]!)) end--;
    const key = Buffer.from(buffer.subarray(start, end));
    buffer.fill(0);
    if (
      bytesRead > MAX_KEY_BYTES ||
      key.length === 0 ||
      key.some((byte) => byte < 33 || byte > 126)
    ) {
      key.fill(0);
      throw new CodexSetupError('api_key_invalid');
    }
    return key;
  } finally {
    await handle.close();
  }
}

/**
 * API-key login through the packaged native backend. The key reaches it only on
 * stdin. Output is classified in memory and never logged or returned.
 */
export async function loginWithApiKey(
  codexPath: string,
  env: Record<string, string>,
  keyFile: string
): Promise<{ loginVerified: true; method: 'api-key' }> {
  const key = await readApiKeyFile(keyFile);
  const input = Buffer.concat([key, Buffer.from('\n')]);
  key.fill(0);
  const cwd = env.HOME;
  if (!cwd) {
    input.fill(0);
    throw new CodexSetupError('environment_invalid', 'HOME');
  }
  let login;
  try {
    login = await runBounded(codexPath, ['login', '--with-api-key'], {
      env,
      cwd,
      input,
      timeoutMs: LOGIN_TIMEOUT_MS,
      maxOutputBytes: 0,
    });
  } finally {
    input.fill(0);
  }
  if (login.failure === 'timeout') throw new CodexSetupError('login_timeout');
  if (login.failure || login.exitCode !== 0)
    throw new CodexSetupError('login_failed');
  const status = await runBounded(codexPath, ['login', 'status'], {
    env,
    cwd,
    timeoutMs: STATUS_TIMEOUT_MS,
    maxOutputBytes: STATUS_OUTPUT_BYTES,
  });
  // The native CLI writes status to stdout or stderr. Use the observed status
  // phrase, never a guessed credential-store schema.
  const verified =
    !status.failure &&
    status.exitCode === 0 &&
    status.output.toString('utf8').toLowerCase().includes('api key');
  status.output.fill(0);
  if (!verified) throw new CodexSetupError('login_unverified');
  return { loginVerified: true, method: 'api-key' };
}

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}
