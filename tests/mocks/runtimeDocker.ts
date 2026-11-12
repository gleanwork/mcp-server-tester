/** Offline CLI boundary for the actual Docker runner's runtime lifecycle tests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import packageJson from '../../package.json' with { type: 'json' };

const root = process.env.RUNTIME_DOCKER_ROOT!;
const invoked = path.basename(process.argv[1]!);
// Image scripts run only against redirected scratch paths, never the host.
if (
  [
    'id',
    'install',
    'chown',
    'chmod',
    'setpriv',
    'seq',
    'Xvfb',
    'dbus-daemon',
    'gdbus',
    'gnome-keyring-daemon',
    'at-spi-bus-launcher',
    'restart-desktop',
  ].includes(invoked)
) {
  const args = process.argv.slice(2);
  await fs.appendFile(
    path.join(root, 'image-calls.jsonl'),
    `${JSON.stringify({ invoked, args })}\n`
  );
  if (invoked === 'id')
    console.log(process.env.RUNTIME_IMAGE_USER === '1' ? '1000' : '0');
  else if (invoked === 'setpriv') {
    if (args.at(-1) === '--prepared') {
      // Emulate only the unprivileged desktop, after the real root shell drops
      // privileges. The private-log prelude is also exercised directly below.
      const session = path.join(root, 'run/mst/session');
      await fs.writeFile(
        path.join(session, 'startup.log'),
        process.env.RUNTIME_IMAGE_DIAGNOSTIC ?? '',
        { mode: 0o600 }
      );
      if (process.env.RUNTIME_IMAGE_MARKERS === '1') {
        await fs.writeFile(path.join(session, 'ready'), '');
        await fs.writeFile(path.join(session, 'failed'), '');
      }
    }
    if (process.env.RUNTIME_IMAGE_ATTACK) {
      let session = path.join(root, 'run/mst/session');
      if (process.env.RUNTIME_IMAGE_ATTACK === 'swap') {
        await fs.rename(session, `${session}-original`);
        const replacement = path.join(root, 'replacement-session');
        await fs.mkdir(replacement);
        await fs.symlink(replacement, session);
        session = replacement;
      }
      await fs.symlink(
        path.join(root, 'victim'),
        path.join(session, 'startup-exit.new')
      );
      await fs.symlink(
        path.join(root, 'failed-victim'),
        path.join(session, 'failed')
      );
    }
    if (process.env.RUNTIME_IMAGE_EXIT_CODE) {
      console.error(process.env.RUNTIME_IMAGE_DIAGNOSTIC);
      process.exit(Number(process.env.RUNTIME_IMAGE_EXIT_CODE));
    }
  } else if (['install', 'chown', 'chmod'].includes(invoked)) {
    let index = 0;
    if (invoked === 'install') {
      while (args[index]?.startsWith('-'))
        index += args[index] === '-d' ? 1 : 2;
    } else index = invoked === 'chown' && args[0] === '-h' ? 2 : 1;
    for (const target of args.slice(index)) {
      if (!path.resolve(target).startsWith(`${root}${path.sep}`))
        throw new Error('Image fixture refused a non-scratch path');
      if (invoked === 'install') await fs.mkdir(target, { recursive: true });
    }
  }
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
else if (command === 'image') {
  console.log(
    args.join(' ').includes('runtime-preparation')
      ? (process.env.RUNTIME_DOCKER_CAPABILITY ?? '1')
      : 'sha256:runtime-test'
  );
} else if (command === 'inspect') console.log('false');
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
    if (process.env.RUNTIME_DOCKER_IMAGE_SESSION) {
      const imageRoot = process.env.RUNTIME_DOCKER_IMAGE_ROOT!;
      if (imageRoot !== container(name))
        fail('image script must use the scratch container root');
      const session = spawnSync(
        'bash',
        [process.env.RUNTIME_DOCKER_IMAGE_SESSION, ...argv.slice(1)],
        {
          timeout: 3000,
          encoding: 'utf8',
          env: {
            ...process.env,
            RUNTIME_DOCKER_ROOT: imageRoot,
            PATH: `${imageRoot}/bin:${process.env.PATH}`,
            HOME: `${imageRoot}/home/mst`,
            DISPLAY: ':99',
            LANG: 'C',
            DBUS_SESSION_BUS_ADDRESS: `unix:path=${imageRoot}/bus`,
            XDG_RUNTIME_DIR: `${imageRoot}/session`,
            GNOME_KEYRING_CONTROL: `${imageRoot}/keyring`,
            AT_SPI_BUS_ADDRESS: `unix:path=${imageRoot}/a11y`,
            MST_INFERENCE_GATEWAY_URL: '',
          },
        }
      );
      // A detached exec succeeds at dispatch even when its session exits.
      // Output stays in the image's private log, never on this CLI boundary.
      if (!rest.includes('--detach') && session.status !== 0)
        fail('image initialization failed');
    } else if (argv[1] === '--dirs-only' || argv[1] === '--prepare') {
      if (
        argv[1] === '--prepare' &&
        process.env.RUNTIME_DOCKER_WAIT_INITIALIZE === '1'
      )
        await new Promise(() => setInterval(() => {}, 1000));
      await directories(name);
    } else if (process.env.RUNTIME_DOCKER_DESKTOP === 'exited') {
      await fs.mkdir(inside(name, '/run/mst-root'), { recursive: true });
      await fs.writeFile(inside(name, '/run/mst-root/startup-exit'), '23\n');
      await fs.writeFile(
        inside(name, '/run/mst/session/startup.log'),
        'synthetic-opaque-runtime-input'
      );
    } else await desktop(name);
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
  } else if (argv[0] === 'channel-probe') {
    if (process.env.RUNTIME_DOCKER_WAIT_STDIN === '1') {
      await fs.writeFile(path.join(root, 'channel-probe-started'), '');
      for await (const _chunk of process.stdin) {
        /* drain */
      }
      await new Promise(() => setInterval(() => {}, 1000));
    }
  } else if (argv[0] === 'runtime-cleanup') {
    await fs.access(inside(name, '/run/mst/opaque-runtime'));
    if (process.env.RUNTIME_DOCKER_CLEANUP_FAIL === '1')
      fail('synthetic cleanup failure');
    await fs.rm(inside(name, '/run/mst/opaque-runtime'));
  } else if (
    argv[0] === 'sh' &&
    argv.join(' ').includes('cat > /run/mst/inference-token')
  ) {
    const refreshing = await exists(inside(name, '/run/mst/inference-token'));
    const input: Buffer[] = [];
    for await (const chunk of process.stdin)
      input.push(Buffer.from(chunk as Buffer));
    await fs.writeFile(
      inside(name, '/run/mst/inference-token'),
      Buffer.concat(input)
    );
    if (refreshing) await fs.writeFile(path.join(root, 'token-refreshed'), '');
  } else if (
    argv[0] === 'sh' &&
    argv.join(' ').includes('/run/mst/session/ready')
  ) {
    if (process.env.RUNTIME_DOCKER_WAIT_READY === '1') {
      await fs.writeFile(path.join(root, 'waiting-ready'), '');
      await new Promise(() => setInterval(() => {}, 1000));
    }
    const mode = process.env.RUNTIME_DOCKER_READY_MODE;
    if (mode === 'starting' || mode === 'ready-then-block') {
      console.log(mode === 'starting' ? 'starting' : 'ready');
      await fs.writeFile(path.join(root, 'readiness-output'), '');
      if (mode === 'ready-then-block')
        await new Promise(() => setInterval(() => {}, 1000));
    } else {
      // Execute the runner's exact sh command against the scratch container,
      // including receipt precedence, whitespace and default marker handling.
      const result = spawnSync(
        'sh',
        ['-c', argv[2]!.replaceAll('/run/mst', inside(name, '/run/mst'))],
        { encoding: 'utf8' }
      );
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
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
