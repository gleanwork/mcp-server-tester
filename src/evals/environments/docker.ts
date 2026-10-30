/**
 * The built-in `docker` environment (ADR 0004): each shard runs in a
 * container from MST's Linux Cowork image (docker/cowork-linux), on a Docker
 * context. The channel is the Docker CLI: `docker exec` runs `mst collect`
 * as the desktop user, and `docker cp` moves the bundle and results.
 *
 * Cowork's VM listens on a host-wide vsock port, so each Docker context runs
 * one Cowork container at a time; `contexts=a,b` spreads shards over several.
 * Grade containers share a context, as many at once as its memory allows
 * (dockerCapacity.ts). Cowork's inference token comes from MST's LLM gateway settings on this
 * machine and is kept fresh in the container's tmpfs, never in the image.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import packageJson from '../../../package.json' with { type: 'json' };
import { resolveLLMEndpoint } from '../../llm/endpoint.js';
import { machineEnvironment } from './channel.js';
import {
  formatMemory,
  memoryArg,
  parseDockerInfo,
  parseMemory,
  planContext,
  type ContainerLimits,
  type ContextCapacity,
  type ContextPlan,
} from './dockerCapacity.js';
import {
  KEPT_SUFFIX,
  RUN_LABEL,
  claimContainer,
  contextArgs,
  dockerCommand,
  ownerLabelArgs,
  releaseContainer,
  sweepOrphanedContainers,
} from './dockerContainers.js';
import type {
  EnvironmentContext,
  EnvironmentDefinition,
  Machine,
  ShardWork,
  WorkerChannel,
} from '../evalFrameworkTypes.js';

/** The image `mst env setup docker` builds for this MST version. */
export const DEFAULT_COWORK_IMAGE = `mst-cowork-linux:${packageJson.version}`;

/** Inside the image (docker/cowork-linux/Dockerfile). */
const USER = 'mst';
const WORK_DIR = '/home/mst/work';
const SESSION_DIR = '/run/mst/session';
const TOKEN_FILE = '/run/mst/inference-token';
const DEFAULT_READY_TIMEOUT_S = 1200;
/** Shorter than the gateway token's life, and than MST's token cache. */
const TOKEN_REFRESH_MS = 4 * 60 * 1000;

const DockerOptionsSchema = z
  .object({
    image: z.string().min(1).optional(),
    /** Docker contexts, comma-separated. Default: the current context. */
    contexts: z.string().min(1).optional(),
    /** How long a new container's desktop has to come up, in seconds. */
    readyTimeout: z.string().regex(/^\d+$/).optional(),
    /**
     * Each container's memory, in Docker's syntax (`8g`, `512m`). Default:
     * all a context can spare for a Cowork container, 2g for a grade one.
     */
    memory: z
      .string()
      .refine((value) => parseMemory(value) !== undefined, {
        message: 'memory must be a size such as 8g or 512m',
      })
      .optional(),
    /**
     * Each container's CPUs (`--cpus`), capped at the context's CPU count.
     * Default: no limit.
     */
    cpus: z
      .string()
      .regex(/^\d+(\.\d+)?$/, 'cpus must be a number such as 2 or 1.5')
      .refine((value) => Number(value) > 0, 'cpus must be more than 0')
      .optional(),
    /** `mst env setup docker` only: the Claude Desktop package to install. */
    claudeDesktopVersion: z.string().min(1).optional(),
  })
  .strict();
type DockerOptions = z.infer<typeof DockerOptionsSchema>;

interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the Docker CLI on `context` (undefined: the current one). */
function docker(
  context: string | undefined,
  args: readonly string[],
  options: { input?: string; signal?: AbortSignal; echo?: boolean } = {}
): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn(dockerCommand(), [...contextArgs(context), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (options.echo) process.stderr.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (options.echo) process.stderr.write(chunk);
    });
    child.on('error', (error) =>
      resolve({ code: -1, stdout, stderr: stderr + error.message })
    );
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

async function dockerOk(
  context: string | undefined,
  args: readonly string[],
  what: string,
  options: { input?: string; signal?: AbortSignal } = {}
): Promise<string> {
  const result = await docker(context, args, options);
  if (result.code !== 0)
    throw new Error(
      `${what} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`
    );
  return result.stdout.trim();
}

/** The image's directory in this package: the Dockerfile and its files. */
export function coworkImageDirectory(): string {
  return path.dirname(
    createRequire(
      typeof __filename === 'string' ? __filename : import.meta.url
    ).resolve('@gleanwork/mcp-server-tester/cowork-linux-image')
  );
}

/** `--memory` and `--cpus`, for the limits that are set. */
function limitArgs(limits: ContainerLimits = {}): string[] {
  return [
    ...(limits.memory !== undefined
      ? ['--memory', memoryArg(limits.memory)]
      : []),
    ...(limits.cpus !== undefined ? ['--cpus', String(limits.cpus)] : []),
  ];
}

/** `docker run` arguments for a shard's container. */
export function dockerRunArgs(options: {
  name: string;
  image: string;
  runId: string;
  seccompProfile: string;
  inference: { baseURL: string; authScheme: 'bearer' | 'x-api-key' };
  /** Forwarded to the container's desktop-ready helper when set. */
  warmVmTimeoutS?: string;
  /** The container's memory and CPUs. Default: no limits. */
  limits?: ContainerLimits;
}): string[] {
  const warm = options.warmVmTimeoutS;
  return [
    'run',
    '--detach',
    '--name',
    options.name,
    '--label',
    `${RUN_LABEL}=${options.runId}`,
    // Whose it is, so a later run can remove it if this process dies.
    ...ownerLabelArgs(),
    // Cowork's VM: KVM, its vsock and network devices, and the vsock socket
    // family Docker's default seccomp profile denies. Nothing privileged.
    '--device',
    '/dev/kvm',
    '--device',
    '/dev/vhost-vsock',
    '--device',
    '/dev/vhost-net',
    '--device',
    '/dev/net/tun',
    '--security-opt',
    `seccomp=${options.seccompProfile}`,
    // The session, the worker's tokens and the inference token: memory only.
    '--tmpfs',
    '/run/mst:mode=0755',
    '--shm-size',
    '1g',
    '--env',
    `MST_INFERENCE_GATEWAY_URL=${options.inference.baseURL}`,
    '--env',
    `MST_INFERENCE_AUTH_SCHEME=${options.inference.authScheme}`,
    // The coordinator's Cowork VM warm-up budget; without it the container
    // falls back to its own default.
    ...(warm !== undefined && /^[1-9][0-9]*$/.test(warm)
      ? ['--env', `MST_COWORK_WARM_VM_TIMEOUT_S=${warm}`]
      : []),
    // Out of memory, the kernel kills a process in this container, not the
    // Docker daemon or another shard's.
    ...limitArgs(options.limits),
    options.image,
  ];
}

/**
 * `docker run` arguments for a grade shard's container (ADR 0005): the same
 * image, with no desktop. Grading starts no client, so it needs no VM
 * devices and no inference, and the entrypoint only keeps the container up
 * for `mst grade-shard`.
 */
export function gradeContainerRunArgs(options: {
  name: string;
  image: string;
  runId: string;
  limits?: ContainerLimits;
}): string[] {
  return [
    'run',
    '--detach',
    '--name',
    options.name,
    '--label',
    `${RUN_LABEL}=${options.runId}`,
    ...ownerLabelArgs(),
    '--tmpfs',
    '/run/mst:mode=0755',
    ...limitArgs(options.limits),
    '--entrypoint',
    '/usr/bin/tini',
    options.image,
    '--',
    'sleep',
    'infinity',
  ];
}

/** A container name for a shard: Docker allows `[a-zA-Z0-9][a-zA-Z0-9_.-]`. */
export function containerName(runId: string, index: number): string {
  return `mst-${runId}-${index + 1}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

/**
 * Docker contexts, each running up to `slots(context)` containers at once
 * (default one, and never fewer): a shard takes the context with the most
 * room, or waits for room on any.
 */
export function contextPool(
  contexts: readonly (string | undefined)[],
  slots: (context: string | undefined) => Promise<number> = async () => 1
) {
  type Entry = { context: string | undefined; free: number };
  let entries: Entry[] | undefined;
  let loading: Promise<Entry[]> | undefined;
  const load = () =>
    (loading ??= Promise.all(
      contexts.map(async (context) => ({
        context,
        free: Math.max(1, await slots(context).catch(() => 1)),
      }))
    ).then((loaded) => (entries = loaded)));
  const waiting: Array<(context: string | undefined) => void> = [];
  return {
    async acquire(signal: AbortSignal): Promise<string | undefined> {
      const loaded = await load();
      if (signal.aborted) throw new Error('The run was cancelled.');
      const roomiest = loaded.reduce<Entry | undefined>(
        (best, entry) => (entry.free > (best?.free ?? 0) ? entry : best),
        undefined
      );
      if (roomiest) {
        roomiest.free--;
        return roomiest.context;
      }
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const index = waiting.indexOf(take);
          if (index >= 0) waiting.splice(index, 1);
          reject(new Error('The run was cancelled.'));
        };
        const take = (context: string | undefined) => {
          signal.removeEventListener('abort', onAbort);
          resolve(context);
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
        waiting.push(take);
      });
    },
    release(context: string | undefined) {
      const next = waiting.shift();
      if (next) return next(context);
      const entry = entries?.find((candidate) => candidate.context === context);
      if (entry) entry.free++;
    },
  };
}

/**
 * Why a failed shard's container failed, when Docker knows: the kernel
 * killed one of its processes for memory.
 */
async function diagnoseContainer(
  dockerContext: string | undefined,
  name: string,
  work: ShardWork,
  limits: ContainerLimits,
  memorySet: boolean
): Promise<string | undefined> {
  const result = await docker(dockerContext, [
    'inspect',
    '--format',
    '{{.State.OOMKilled}}',
    name,
  ]);
  if (result.code !== 0 || result.stdout.trim() !== 'true') return undefined;
  const limit =
    limits.memory !== undefined
      ? ` (its limit: ${formatMemory(limits.memory)})`
      : '';
  const fix =
    work === 'grade'
      ? 'raise --env-option memory (fewer grade containers then share a context)'
      : memorySet
        ? 'raise --env-option memory, or give the Docker context more memory'
        : 'give the Docker context more memory';
  return `Container ${name} ran out of memory${limit}: ${fix}.`;
}

/** Cowork's inference: MST's Anthropic gateway settings, or an API key. */
async function inference(): Promise<{
  baseURL: string;
  authScheme: 'bearer' | 'x-api-key';
  token: string;
}> {
  const endpoint = await resolveLLMEndpoint('anthropic');
  const token = endpoint.authToken ?? endpoint.apiKey;
  if (!token)
    throw new Error(
      'Cowork in a container needs inference: set ANTHROPIC_BASE_URL with MST_LLM_AUTH_COMMAND or ANTHROPIC_AUTH_TOKEN (an LLM gateway), or ANTHROPIC_API_KEY. See docs/llm-gateways.md.'
    );
  return {
    baseURL: endpoint.baseURL,
    authScheme: endpoint.authToken ? 'bearer' : 'x-api-key',
    token,
  };
}

/** Writes the inference token where the image's credential helper reads it. */
async function deliverToken(
  context: string | undefined,
  name: string,
  token: string
): Promise<void> {
  await dockerOk(
    context,
    [
      'exec',
      '-i',
      '-u',
      USER,
      name,
      'sh',
      '-c',
      `umask 077 && cat > ${TOKEN_FILE}.new && mv -f ${TOKEN_FILE}.new ${TOKEN_FILE}`,
    ],
    'Delivering the inference token',
    { input: token }
  );
}

/** Waits for the image's desktop session to say it's ready (or failed). */
async function waitForDesktop(
  context: string | undefined,
  name: string,
  timeoutS: number,
  signal: AbortSignal
): Promise<void> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('The run was cancelled.');
    const state = await docker(context, [
      'exec',
      name,
      'sh',
      '-c',
      `if [ -e ${SESSION_DIR}/ready ]; then echo ready; elif [ -e ${SESSION_DIR}/failed ]; then echo failed; else echo starting; fi`,
    ]);
    const status = state.stdout.trim();
    if (status === 'ready') return;
    if (status === 'failed' || state.code !== 0) {
      const why =
        status === 'failed'
          ? (
              await docker(context, [
                'exec',
                name,
                'tail',
                '-n',
                '3',
                `${SESSION_DIR}/restart.log`,
              ])
            ).stdout
          : (await docker(context, ['logs', '--tail', '5', name])).stderr ||
            state.stderr;
      throw new Error(
        `The desktop in container ${name} didn't come up: ${why.trim().replace(/\s+/g, ' ')}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(
    `The desktop in container ${name} wasn't ready within ${timeoutS} s (--env-option readyTimeout).`
  );
}

/** The channel to a container: the Docker CLI on its context. */
function containerChannel(
  context: string | undefined,
  name: string
): WorkerChannel {
  return {
    exec(argv, { stdin, signal }) {
      const child = spawn(
        dockerCommand(),
        [
          ...(context ? ['--context', context] : []),
          'exec',
          '-i',
          '-u',
          USER,
          '-w',
          WORK_DIR,
          name,
          ...argv,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const kill = () => {
        child.kill('SIGKILL');
        // Killing `docker exec` leaves its process running in the container.
        void docker(context, ['exec', name, 'pkill', '-f', 'mst collect']);
      };
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
      child.stdin.on('error', () => {});
      void (async () => {
        try {
          for await (const line of stdin) child.stdin.write(line);
        } finally {
          child.stdin.end();
        }
      })();
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        exit: new Promise<number>((resolve) =>
          child.on('close', (code) => resolve(code ?? -1))
        ),
      };
    },
    async put(localDir, remoteDir) {
      await dockerOk(
        context,
        ['cp', `${localDir}/.`, `${name}:${remoteDir}`],
        'Copying the bundle'
      );
      // `docker cp` writes as root; the worker runs as the desktop user.
      await dockerOk(
        context,
        [
          'exec',
          '-u',
          'root',
          name,
          'chown',
          '-R',
          `${USER}:${USER}`,
          remoteDir,
        ],
        'Handing the bundle to the desktop user'
      );
    },
    async get(remoteDir, localDir) {
      await fs.mkdir(localDir, { recursive: true });
      // Nothing to copy yet is fine: the trials are missing, not the run.
      await docker(context, ['cp', `${name}:${remoteDir}/.`, localDir]);
    },
  };
}

function contextsOf(options: DockerOptions): Array<string | undefined> {
  const named = (options.contexts ?? '')
    .split(',')
    .map((context) => context.trim())
    .filter(Boolean);
  return named.length ? named : [undefined];
}

function openDocker(
  options: DockerOptions,
  context: EnvironmentContext
): ReturnType<typeof machineEnvironment> {
  const image = options.image ?? DEFAULT_COWORK_IMAGE;
  const readyTimeoutS = Number(options.readyTimeout ?? DEFAULT_READY_TIMEOUT_S);
  const requested: ContainerLimits = {
    ...(options.memory ? { memory: parseMemory(options.memory) } : {}),
    ...(options.cpus ? { cpus: Number(options.cpus) } : {}),
  };
  // Once per context: its size. Once per context and work: the plan, logged.
  const capacities = new Map<string, Promise<ContextCapacity | undefined>>();
  const capacityOf = (dockerContext: string | undefined) => {
    const id = dockerContext ?? '';
    if (!capacities.has(id))
      capacities.set(
        id,
        docker(dockerContext, [
          'info',
          '--format',
          '{{.MemTotal}} {{.NCPU}}',
        ]).then((result) =>
          result.code === 0 ? parseDockerInfo(result.stdout) : undefined
        )
      );
    return capacities.get(id)!;
  };
  const plans = new Map<string, Promise<ContextPlan>>();
  const planOf = (work: ShardWork, dockerContext: string | undefined) => {
    const id = `${work}:${dockerContext ?? ''}`;
    if (!plans.has(id))
      plans.set(
        id,
        capacityOf(dockerContext).then((capacity) => {
          const plan = planContext(work, capacity, requested);
          console.error(
            `[mst] ${dockerContext ?? 'The current Docker context'} ${plan.note}`
          );
          return plan;
        })
      );
    return plans.get(id)!;
  };
  const diagnose =
    (
      dockerContext: string | undefined,
      name: string,
      work: ShardWork,
      limits: ContainerLimits
    ) =>
    () =>
      diagnoseContainer(
        dockerContext,
        name,
        work,
        limits,
        requested.memory !== undefined
      );
  // Cowork containers: one per context. Grade containers: as many as fit.
  const pool = contextPool(contextsOf(options));
  const gradePool = contextPool(
    contextsOf(options),
    async (dockerContext) => (await planOf('grade', dockerContext)).slots
  );
  const seccompProfile = path.join(coworkImageDirectory(), 'seccomp.json');
  // Once per context: containers an earlier run on this machine left behind.
  const swept = new Map<string, Promise<void>>();
  const sweep = (dockerContext: string | undefined) => {
    const id = dockerContext ?? '';
    if (!swept.has(id))
      swept.set(
        id,
        sweepOrphanedContainers(dockerContext, (args) =>
          docker(dockerContext, args)
        ).then(({ removed, unowned }) => {
          for (const name of removed)
            console.error(
              `[mst] removed container ${name}: the run that started it is gone`
            );
          if (unowned.length)
            console.error(
              `[mst] ${unowned.length} MST container(s) without an owner (an older MST's) on ${dockerContext ?? 'the current context'}: ${unowned.join(', ')}. Remove them with \`docker${dockerContext ? ` --context ${dockerContext}` : ''} rm -f <name>\` if no run uses them.`
            );
        })
      );
    return swept.get(id)!;
  };
  return machineEnvironment(
    context,
    async (shard, signal): Promise<Machine> => {
      if (shard.work === 'grade') {
        // No VM, so no host-wide vsock port: grade shards share contexts.
        const dockerContext = await gradePool.acquire(signal);
        const name = containerName(shard.runId, shard.index);
        try {
          const { limits } = await planOf('grade', dockerContext);
          const machine = await gradeMachine(
            dockerContext,
            name,
            image,
            shard.runId,
            limits,
            sweep,
            signal
          );
          return {
            ...machine,
            diagnose: diagnose(dockerContext, name, 'grade', limits),
            async dispose(options) {
              try {
                await machine.dispose(options);
              } finally {
                gradePool.release(dockerContext);
              }
            },
          };
        } catch (error) {
          gradePool.release(dockerContext);
          throw error;
        }
      }
      const dockerContext = await pool.acquire(signal);
      const name = containerName(shard.runId, shard.index);
      let refresh: NodeJS.Timeout | undefined;
      const remove = async () => {
        clearInterval(refresh);
        await docker(dockerContext, ['rm', '--force', name]);
        releaseContainer(dockerContext, name);
      };
      let limits: ContainerLimits | undefined;
      try {
        await sweep(dockerContext);
        ({ limits } = await planOf('collect', dockerContext));
        const credential = await inference();
        const digest = await dockerOk(
          dockerContext,
          ['image', 'inspect', '--format', '{{.Id}}', image],
          `Finding image ${image} (build it with \`mst env setup docker\`)`
        );
        // Guarded from here: removed at exit even if this run never disposes it.
        claimContainer(dockerContext, name);
        await dockerOk(
          dockerContext,
          dockerRunArgs({
            name,
            image,
            runId: shard.runId,
            seccompProfile,
            inference: credential,
            warmVmTimeoutS: process.env.MST_COWORK_WARM_VM_TIMEOUT_S,
            limits,
          }),
          `Starting container ${name}`,
          { signal }
        );
        await deliverToken(dockerContext, name, credential.token);
        refresh = setInterval(() => {
          void inference()
            .then((fresh) => deliverToken(dockerContext, name, fresh.token))
            .catch(() => {
              // The next refresh tries again; the token still has time.
            });
        }, TOKEN_REFRESH_MS);
        refresh.unref();
        await waitForDesktop(dockerContext, name, readyTimeoutS, signal);
        await dockerOk(
          dockerContext,
          ['exec', '-u', USER, name, 'mkdir', '-p', WORK_DIR],
          'Creating the work directory'
        );
        return {
          id: name,
          image: { ref: image, digest },
          workDir: WORK_DIR,
          channel: containerChannel(dockerContext, name),
          diagnose: diagnose(dockerContext, name, 'collect', limits),
          async dispose({ keep }) {
            try {
              if (keep) {
                clearInterval(refresh);
                // Renamed so no later run's sweep removes it.
                const kept = `${name}${KEPT_SUFFIX}`;
                const renamed =
                  (await docker(dockerContext, ['rename', name, kept])).code ===
                  0;
                releaseContainer(dockerContext, name);
                console.error(
                  `[mst] kept container ${renamed ? kept : name}: docker ${dockerContext ? `--context ${dockerContext} ` : ''}exec -it -u ${USER} ${renamed ? kept : name} bash`
                );
              } else await remove();
            } finally {
              pool.release(dockerContext);
            }
          },
        };
      } catch (error) {
        // A desktop that didn't come up may have run out of memory.
        const cause = limits
          ? await diagnose(dockerContext, name, 'collect', limits)().catch(
              () => undefined
            )
          : undefined;
        await remove();
        pool.release(dockerContext);
        if (!cause) throw error;
        throw new Error(
          `${cause} ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}

/**
 * A grade shard's machine: a container of the image with no desktop, whose
 * worker runs `mst grade-shard` (ADR 0005).
 */
async function gradeMachine(
  dockerContext: string | undefined,
  name: string,
  image: string,
  runId: string,
  limits: ContainerLimits,
  sweep: (dockerContext: string | undefined) => Promise<void>,
  signal: AbortSignal
): Promise<Machine> {
  const remove = async () => {
    await docker(dockerContext, ['rm', '--force', name]);
    releaseContainer(dockerContext, name);
  };
  try {
    await sweep(dockerContext);
    const digest = await dockerOk(
      dockerContext,
      ['image', 'inspect', '--format', '{{.Id}}', image],
      `Finding image ${image} (build it with \`mst env setup docker\`)`
    );
    claimContainer(dockerContext, name);
    await dockerOk(
      dockerContext,
      gradeContainerRunArgs({ name, image, runId, limits }),
      `Starting container ${name}`,
      { signal }
    );
    await dockerOk(
      dockerContext,
      ['exec', '-u', USER, name, 'mkdir', '-p', WORK_DIR],
      'Creating the work directory'
    );
    return {
      id: name,
      image: { ref: image, digest },
      workDir: WORK_DIR,
      channel: containerChannel(dockerContext, name),
      async dispose({ keep }) {
        if (!keep) return remove();
        const kept = `${name}${KEPT_SUFFIX}`;
        const renamed =
          (await docker(dockerContext, ['rename', name, kept])).code === 0;
        releaseContainer(dockerContext, name);
        console.error(
          `[mst] kept container ${renamed ? kept : name}: docker ${dockerContext ? `--context ${dockerContext} ` : ''}exec -it -u ${USER} ${renamed ? kept : name} bash`
        );
      },
    };
  } catch (error) {
    await remove();
    throw error;
  }
}

/**
 * `npm pack` arguments. A checkout runs its `prepare` script so it is packed
 * as built; an installed package is already built (and lacks the dev
 * dependencies its build needs), so its scripts are skipped.
 */
export function npmPackArgs(
  destination: string,
  { ignoreScripts }: { ignoreScripts: boolean }
): string[] {
  return [
    'pack',
    '--silent',
    ...(ignoreScripts ? ['--ignore-scripts'] : []),
    '--pack-destination',
    destination,
  ];
}

/** `npm pack`s the package in `dir` into `destination`. `MST_NPM` names another npm CLI. */
async function npmPack(
  dir: string,
  destination: string,
  { ignoreScripts = false }: { ignoreScripts?: boolean } = {}
): Promise<void> {
  const packed = await new Promise<number>((resolve) => {
    const child = spawn(
      process.env.MST_NPM || 'npm',
      npmPackArgs(destination, { ignoreScripts }),
      { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] }
    );
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
  if (packed !== 0) throw new Error(`npm pack failed in ${dir}.`);
}

async function setupDocker(
  options: DockerOptions,
  log: (line: string) => void,
  plugins: ReadonlyArray<{ name: string; version: string; dir: string }>
): Promise<void> {
  const image = options.image ?? DEFAULT_COWORK_IMAGE;
  const source = coworkImageDirectory();
  const build = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-cowork-image-'));
  try {
    await fs.cp(source, build, { recursive: true });
    const packages = path.join(build, 'mst-package');
    await fs.mkdir(packages, { recursive: true });
    // The worker runs this MST, packed from where it runs: a source checkout
    // or an installed package. Installing the published version instead
    // would let the worker drift from the coordinator.
    const root = path.resolve(source, '../..');
    const checkout = existsSync(path.join(root, 'src', 'cli', 'index.ts'));
    log(`Packing MST from ${root}…`);
    await npmPack(root, packages, { ignoreScripts: !checkout });
    // The eval's plugins, packed from where this machine has them, so a
    // private or linked package needs no registry: the image installs them
    // (and their dependencies) in MST_PLUGIN_DIR.
    const pluginPackages = path.join(build, 'plugins');
    await fs.mkdir(pluginPackages, { recursive: true });
    for (const plugin of plugins) {
      log(`Packing plugin ${plugin.name}@${plugin.version}…`);
      await npmPack(plugin.dir, pluginPackages);
    }
    for (const dockerContext of contextsOf(options)) {
      log(`Building ${image}${dockerContext ? ` on ${dockerContext}` : ''}…`);
      const result = await docker(
        dockerContext,
        [
          'build',
          '--tag',
          image,
          ...(options.claudeDesktopVersion
            ? [
                '--build-arg',
                `CLAUDE_DESKTOP_VERSION=${options.claudeDesktopVersion}`,
              ]
            : []),
          build,
        ],
        { echo: true }
      );
      if (result.code !== 0)
        throw new Error(
          `Building ${image}${dockerContext ? ` on ${dockerContext}` : ''} failed.`
        );
    }
    log(`Built ${image}. Run with --env docker.`);
  } finally {
    await fs.rm(build, { recursive: true, force: true });
  }
}

export const dockerEnvironment: EnvironmentDefinition = {
  schema: DockerOptionsSchema,
  description:
    "Run shards in containers from MST's Linux Cowork image: one Cowork container per Docker context at a time, grade containers as many as fit.",
  async open(options, context) {
    return openDocker(options as DockerOptions, context);
  },
  async setup(options, { log, plugins = [] }) {
    await setupDocker(options as DockerOptions, log, plugins);
  },
};
