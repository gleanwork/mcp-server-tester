#!/usr/bin/env -S node --import tsx
/** Offline CLI boundary for the actual Docker runner's runtime lifecycle tests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };

const root = process.env.RUNTIME_DOCKER_ROOT!;
const invoked = path.basename(process.argv[1]!);
// Stand-ins for the image entrypoint's directory-only invocation.
if (invoked === 'id') {
  console.log('0');
  process.exit(0);
}
if (invoked === 'install') {
  await fs.appendFile(
    path.join(root, 'image-calls.jsonl'),
    `${JSON.stringify(process.argv.slice(2))}\n`
  );
  process.exit(0);
}

let args = process.argv.slice(2);
let context: string | undefined;
if (args[0] === '--context') {
  context = args[1];
  args = args.slice(2);
}
await fs.appendFile(
  path.join(root, 'calls.jsonl'),
  `${JSON.stringify({ context, args })}\n`
);
const [command, ...rest] = args;
const container = (name: string) => path.join(root, 'containers', name);
const inside = (name: string, value: string) =>
  path.join(container(name), value);
async function directories(name: string): Promise<void> {
  for (const dir of [
    'session',
    'tokens',
    'settings',
    'home',
    'tmp',
    'evidence',
  ])
    await fs.mkdir(inside(name, `/run/mst/${dir}`), { recursive: true });
  await fs.mkdir(inside(name, '/home/mst'), { recursive: true });
}
async function desktop(name: string): Promise<void> {
  await directories(name);
  if (process.env.RUNTIME_DOCKER_EXPECT_PREPARED === '1')
    await fs.access(inside(name, '/run/mst/opaque-runtime'));
  await fs.writeFile(
    inside(
      name,
      `/run/mst/session/${process.env.RUNTIME_DOCKER_DESKTOP ?? 'ready'}`
    ),
    ''
  );
  await fs.writeFile(
    inside(name, '/run/mst/session/restart.log'),
    'desktop failed'
  );
}
async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false
  );
}
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

if (command === 'ps' || command === 'logs') {
  // No orphan containers and no logs.
} else if (command === 'info') console.log(`${8 * 1024 ** 3} 4`);
else if (command === 'image') console.log('sha256:runtime-test');
else if (command === 'inspect') console.log('false');
else if (command === 'run') {
  const name = rest[rest.indexOf('--name') + 1]!;
  await fs.mkdir(container(name), { recursive: true });
  if (!rest.includes('--entrypoint')) await desktop(name);
  console.log(`${name}-id`);
} else if (command === 'rm') {
  if (process.env.RUNTIME_DOCKER_REMOVE_FAIL === '1')
    fail('daemon refused removal');
  await fs.rm(container(rest.at(-1)!), { recursive: true, force: true });
} else if (command === 'rename') {
  if (process.env.RUNTIME_DOCKER_RENAME_FAIL === '1')
    fail('daemon refused rename');
  await fs.rename(container(rest[0]!), container(rest[1]!));
} else if (command === 'cp') {
  const resolve = (value: string) => {
    const match = /^([^/:]+):(.*)$/.exec(value);
    return match ? inside(match[1]!, match[2]!) : value;
  };
  await fs.cp(resolve(rest[0]!).replace(/\/\.$/, ''), resolve(rest[1]!), {
    recursive: true,
  });
} else if (command === 'exec') {
  let index = 0;
  let cwd: string | undefined;
  while (rest[index]?.startsWith('-')) {
    const flag = rest[index]!;
    if (flag === '-w') cwd = rest[index + 1];
    index += ['-i', '--detach'].includes(flag) ? 1 : 2;
  }
  const name = rest[index]!;
  const argv = rest.slice(index + 1);
  await fs.access(container(name));
  if (argv[0] === '/opt/mst/bin/desktop-session') {
    if (argv[1] === '--dirs-only') await directories(name);
    else await desktop(name);
  } else if (argv[0] === 'mkdir' || argv[0] === 'install') {
    await fs.mkdir(inside(name, argv.at(-1)!), { recursive: true });
  } else if (argv[0] === 'chown' || argv[0] === 'pkill') {
    // Ownership and process groups belong to Docker, not this stand-in.
  } else if (argv[0] === 'runtime-prepare') {
    await fs.access(inside(name, cwd!));
    await fs.access(inside(name, '/run/mst/tokens'));
    if (await exists(inside(name, '/run/mst/session/ready')))
      fail('desktop started before preparation');
    if (process.env.RUNTIME_DOCKER_EXPECT_TOKEN === '1')
      await fs.access(inside(name, '/run/mst/inference-token'));
    const input: Buffer[] = [];
    for await (const chunk of process.stdin)
      input.push(Buffer.from(chunk as Buffer));
    await fs.writeFile(
      inside(name, '/run/mst/opaque-runtime'),
      Buffer.concat(input)
    );
  } else if (argv[0] === 'runtime-cleanup') {
    await fs.access(inside(name, '/run/mst/opaque-runtime'));
    if (process.env.RUNTIME_DOCKER_CLEANUP_FAIL === '1')
      fail('synthetic cleanup failure');
    await fs.rm(inside(name, '/run/mst/opaque-runtime'));
  } else if (
    argv[0] === 'sh' &&
    argv.join(' ').includes('cat > /run/mst/inference-token')
  ) {
    const input: Buffer[] = [];
    for await (const chunk of process.stdin)
      input.push(Buffer.from(chunk as Buffer));
    await fs.writeFile(
      inside(name, '/run/mst/inference-token'),
      Buffer.concat(input)
    );
  } else if (
    argv[0] === 'sh' &&
    argv.join(' ').includes('/run/mst/session/ready')
  ) {
    if (process.env.RUNTIME_DOCKER_WAIT_READY === '1') {
      await fs.writeFile(path.join(root, 'waiting-ready'), '');
      await new Promise(() => setInterval(() => {}, 1000));
    }
    console.log(
      (await exists(inside(name, '/run/mst/session/ready')))
        ? 'ready'
        : 'failed'
    );
  } else if (argv[0] === 'tail') {
    console.log('synthetic desktop failure');
  } else if (argv[0] === 'mst') {
    console.log(
      JSON.stringify({
        type: 'hello',
        protocol: 'mst.shard/v1',
        mst: packageJson.version,
        client: { name: 'runtime-test' },
      })
    );
    if (process.env.RUNTIME_DOCKER_WORKER_FAIL === '1')
      fail('synthetic worker failure');
    let cancelled = false;
    if (process.env.RUNTIME_DOCKER_WAIT_WORKER === '1') {
      for await (const input of process.stdin) {
        if (String(input).includes('"cancel"')) {
          cancelled = true;
          break;
        }
      }
    }
    console.log(
      JSON.stringify({
        type: 'done',
        ...(argv[1] === 'grade-shard'
          ? { graded: 1, failed: 0 }
          : { collected: 1, infra: 0 }),
        cancelled,
        cleanup: 'ok',
      })
    );
  } else fail(`unsupported exec: ${argv.join(' ')}`);
} else fail(`unsupported docker command: ${command}`);
