import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type {
  CodexExit,
  CodexOwnedProcess,
  CodexProcessFacade,
  CodexProcessIdentity,
  CodexSpawnRequest,
} from './launcher.js';

const metadataEnvironment = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  LANG: 'C',
};
const MAX_PROCESS_CANDIDATES = 32;
const CODEX_FAMILY_TOKEN =
  /(?:^|[^A-Za-z0-9])(?:Codex|ChatGPT)(?:[^A-Za-z0-9]|$)/i;

interface ProcessCandidate {
  pid: number;
  startIdentity: string;
}

function parseProcessCandidates(output: string): ProcessCandidate[] {
  if (!output.trim()) throw new Error('Empty executable process inventory.');
  const candidates: ProcessCandidate[] = [];
  const candidatePids = new Set<number>();
  for (const line of output.split('\n').filter((entry) => entry.trim())) {
    const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s*$/.exec(
      line
    );
    if (!match?.[1] || !match[2] || !match[3])
      throw new Error('Cannot read executable process inventory.');
    if (!CODEX_FAMILY_TOKEN.test(match[3])) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || candidatePids.has(pid))
      throw new Error('Cannot read executable process inventory.');
    candidatePids.add(pid);
    candidates.push({
      pid,
      startIdentity: match[2].replace(/\s+/g, ' '),
    });
    if (candidates.length > MAX_PROCESS_CANDIDATES)
      throw new Error('Too many executable process candidates.');
  }
  return candidates;
}

function parseLsofExecutable(output: string, pid: number): string {
  let currentPid: number | undefined;
  let textDescriptor = false;
  let executablePath: string | undefined;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('p')) {
      const parsedPid = Number(line.slice(1));
      if (!Number.isSafeInteger(parsedPid) || parsedPid <= 0)
        throw new Error('Cannot resolve executable process identity.');
      currentPid = parsedPid;
      textDescriptor = false;
    } else if (line.startsWith('f')) {
      textDescriptor = line === 'ftxt';
    } else if (
      line.startsWith('n') &&
      currentPid === pid &&
      textDescriptor &&
      executablePath === undefined
    ) {
      executablePath = line.slice(1);
    }
  }
  if (!executablePath?.startsWith('/'))
    throw new Error('Cannot resolve executable process identity.');
  return executablePath;
}

async function resolveCandidate(
  candidate: ProcessCandidate
): Promise<CodexProcessIdentity | undefined> {
  const output = await metadata('/usr/sbin/lsof', [
    '-a',
    '-d',
    'txt',
    '-p',
    String(candidate.pid),
    '-Fn',
  ]);
  const executablePath = parseLsofExecutable(output, candidate.pid);
  return CODEX_FAMILY_TOKEN.test(executablePath)
    ? { ...candidate, executablePath }
    : undefined;
}

/** No shell, argv inventory, app output capture, or auth/config reads. */
export function createNativeCodexProcesses(): CodexProcessFacade {
  async function listProcesses(): Promise<CodexProcessIdentity[]> {
    const candidates = parseProcessCandidates(
      await metadata('/bin/ps', ['-ww', '-axo', 'pid=,lstart=,comm='])
    );
    const resolved = await Promise.all(candidates.map(resolveCandidate));
    return resolved.filter(
      (process): process is CodexProcessIdentity => process !== undefined
    );
  }
  return {
    platform: process.platform,
    async readBundleInfo(bundlePath) {
      const plist = join(bundlePath, 'Contents/Info.plist');
      const identifier = await metadata('/usr/bin/plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        plist,
      ]);
      const executable = await metadata('/usr/bin/plutil', [
        '-extract',
        'CFBundleExecutable',
        'raw',
        '-o',
        '-',
        plist,
      ]);
      const version = await metadata('/usr/bin/plutil', [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        plist,
      ]);
      if (!identifier || !executable || !version)
        throw new Error('Cannot read app bundle identity.');
      return { identifier, executable, version };
    },
    async verifyBundleSignature(bundlePath) {
      await metadataOutput(
        '/usr/bin/codesign',
        ['--verify', '--deep', '--strict', bundlePath],
        30_000
      );
      const signature = await metadataOutput(
        '/usr/bin/codesign',
        ['-dv', '--verbose=4', bundlePath],
        30_000
      );
      const details = `${signature.stdout}\n${signature.stderr}`;
      const teamIdentifier = /^TeamIdentifier=(.+)$/m
        .exec(details)?.[1]
        ?.trim();
      if (!teamIdentifier)
        throw new Error('Cannot read app bundle signature identity.');
      return { teamIdentifier };
    },
    listProcesses,
    spawn: spawnOwned,
  };
}

async function metadata(
  executablePath: string,
  args: string[]
): Promise<string> {
  return (await metadataOutput(executablePath, args)).stdout.trim();
}

function metadataOutput(
  executablePath: string,
  args: string[],
  timeout = 5000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executablePath,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 1048576,
        env: metadataEnvironment,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error('Cannot verify local app process metadata.'));
        else resolve({ stdout, stderr });
      }
    );
  });
}

class NativeCodexProcess implements CodexOwnedProcess {
  constructor(
    private readonly child: ChildProcess,
    readonly exited: Promise<CodexExit>
  ) {}
  get pid(): number {
    if (this.child.pid === undefined)
      throw new Error('Codex app did not start.');
    return this.child.pid;
  }
}

async function spawnOwned(
  request: CodexSpawnRequest
): Promise<CodexOwnedProcess> {
  const child = spawn(request.executablePath, request.args, {
    cwd: request.cwd,
    env: request.env,
    detached: request.detached,
    shell: request.shell,
    stdio: request.stdio,
  });
  let resolveExit!: (exit: CodexExit) => void;
  const exited = new Promise<CodexExit>((resolve) => {
    resolveExit = resolve;
  });
  child.once('exit', (code, signal) => resolveExit({ code, signal }));
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => {
      resolveExit({ code: null, signal: null });
      reject(new Error('Codex app spawn failed.'));
    });
  });
  return new NativeCodexProcess(child, exited);
}
