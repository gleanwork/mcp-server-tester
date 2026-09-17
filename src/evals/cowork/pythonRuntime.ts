import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let prepared: Promise<string> | undefined;

/** Worker-provided Python is never modified. Otherwise prepare one private,
 * process-owned runtime from the requirements bundled with this package. */
export async function ensureCoworkPython(
  env: NodeJS.ProcessEnv
): Promise<string> {
  if (env.MST_COWORK_PYTHON) return env.MST_COWORK_PYTHON;
  prepared ??= install(env).catch((error) => {
    prepared = undefined;
    throw error;
  });
  return prepared;
}
async function install(env: NodeJS.ProcessEnv): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mst-cowork-python-'));
  const installerEnv = Object.fromEntries(
    [
      'PATH',
      'HOME',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NO_PROXY',
    ].flatMap((key) => (env[key] ? [[key, env[key]]] : []))
  );
  const options = {
    env: installerEnv,
    timeout: 180000,
    killSignal: 'SIGKILL' as const,
    maxBuffer: 1024 * 1024,
  };
  try {
    const requirements = createRequire(
      typeof __filename === 'string' ? __filename : import.meta.url
    ).resolve('@gleanwork/mcp-server-tester/cowork-requirements');
    console.error(
      '[mst:cowork] preparing packaged Computer Use Python dependencies'
    );
    await exec('python3', ['-m', 'venv', directory], options);
    const python = join(
      directory,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
    );
    await exec(
      python,
      [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '-r',
        requirements,
      ],
      options
    );
    process.once('exit', () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        /* owned dependency scratch only */
      }
    });
    return python;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      'Unable to prepare Computer Use Python dependencies. Install Python 3.10+ or set MST_COWORK_PYTHON to a prepared interpreter.'
    );
  }
}
