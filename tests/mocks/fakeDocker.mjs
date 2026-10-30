#!/usr/bin/env node
/**
 * A Docker CLI for tests of the `docker` environment (MST_DOCKER). Each
 * container is a directory under FAKE_DOCKER_ROOT, with the image's paths
 * (/run/mst, /home/mst) inside it; `exec mst collect` runs MST's CLI from
 * source. Every call is appended to FAKE_DOCKER_ROOT/calls.jsonl.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.FAKE_DOCKER_ROOT;
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(REPO, 'src/cli/index.ts');
let args = process.argv.slice(2);
let context;
if (args[0] === '--context') {
  context = args[1];
  args = args.slice(2);
}
fs.appendFileSync(
  path.join(ROOT, 'calls.jsonl'),
  `${JSON.stringify({ context, args })}\n`
);

const containerRoot = (name) => path.join(ROOT, 'containers', name);
/** A container path, on this machine. */
const inside = (name, value) =>
  value.replace(
    /(^|[\s'"=])(\/run\/mst|\/home\/mst)/g,
    `$1${containerRoot(name)}$2`
  );

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const [command, ...rest] = args;
if (command === 'image') {
  process.stdout.write('sha256:fake-image\n');
} else if (command === 'build') {
  if (process.env.FAKE_DOCKER_BUILD_ERROR) {
    process.stderr.write(
      `#12 [5/9] RUN npm install\n${process.env.FAKE_DOCKER_BUILD_ERROR}\n`
    );
    process.exit(1);
  }
  // What the image would install: the plugin packages in the context.
  const plugins = path.join(rest.at(-1), 'plugins');
  fs.appendFileSync(
    path.join(ROOT, 'builds.jsonl'),
    `${JSON.stringify({
      context,
      tag: rest[rest.indexOf('--tag') + 1],
      plugins: fs.existsSync(plugins) ? fs.readdirSync(plugins).sort() : null,
      // Which of MST's images: only ChatGPT's is recorded, so Cowork's builds read as before.
      ...(/ChatGPT/.test(
        fs.readFileSync(path.join(rest.at(-1), 'Dockerfile'), 'utf8')
      )
        ? { desktop: 'chatgpt' }
        : {}),
    })}\n`
  );
} else if (command === 'run') {
  const name = rest[rest.indexOf('--name') + 1];
  const root = containerRoot(name);
  for (const dir of ['run/mst/session', 'run/mst/tokens', 'home/mst'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'run-args.json'), JSON.stringify(rest));
  // The desktop comes up at once, unless the test says otherwise.
  fs.writeFileSync(
    path.join(
      root,
      'run/mst/session',
      process.env.FAKE_DOCKER_DESKTOP ?? 'ready'
    ),
    ''
  );
  fs.writeFileSync(
    path.join(root, 'run/mst/session/restart.log'),
    'the desktop failed\n'
  );
  process.stdout.write(`${name}-id\n`);
} else if (command === 'ps') {
  // `ps --all --filter label=mst.run --format '{{.Names}}\t<owner host>\t<owner pid>'`
  const label = (labels, name) =>
    labels
      .find((value) => value.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? '';
  const dir = path.join(ROOT, 'containers');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const runArgs = JSON.parse(
      fs.readFileSync(path.join(containerRoot(name), 'run-args.json'), 'utf8')
    );
    const labels = runArgs.flatMap((value, i) =>
      runArgs[i - 1] === '--label' ? [value] : []
    );
    if (!label(labels, 'mst.run')) continue;
    process.stdout.write(
      `${name}\t${label(labels, 'mst.owner.host')}\t${label(labels, 'mst.owner.pid')}\n`
    );
  }
} else if (command === 'rename') {
  const [from, to] = rest;
  if (!fs.existsSync(containerRoot(from))) fail(`No such container: ${from}`);
  fs.renameSync(containerRoot(from), containerRoot(to));
} else if (command === 'rm') {
  fs.rmSync(containerRoot(rest.at(-1)), { recursive: true, force: true });
} else if (command === 'logs') {
  // Nothing logged.
} else if (command === 'cp') {
  const [from, to] = rest;
  const resolve = (value) => {
    const match = /^([^/:]+):(.*)$/.exec(value);
    return match ? path.join(containerRoot(match[1]), match[2]) : value;
  };
  const source = resolve(from).replace(/\/\.$/, '');
  if (!fs.existsSync(source)) fail(`no such path: ${from}`);
  fs.cpSync(source, resolve(to), { recursive: true });
} else if (command === 'exec') {
  let index = 0;
  while (rest[index]?.startsWith('-'))
    index += ['-i'].includes(rest[index]) ? 1 : 2;
  const name = rest[index];
  const argv = rest.slice(index + 1);
  if (!fs.existsSync(containerRoot(name))) fail(`No such container: ${name}`);
  if (argv[0] === 'mst') {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        CLI,
        ...argv.slice(1).map((value) => inside(name, value)),
      ],
      {
        cwd: REPO,
        stdio: 'inherit',
        env: {
          ...process.env,
          MST_TOKENS_DIR: path.join(containerRoot(name), 'run/mst/tokens'),
          // What the worker leaves in the container goes with it.
          HOME: path.join(containerRoot(name), 'home/mst'),
          // The image's plugin packages (MST_PLUGIN_DIR in the image).
          ...(process.env.FAKE_DOCKER_PLUGIN_DIR
            ? { MST_PLUGIN_DIR: process.env.FAKE_DOCKER_PLUGIN_DIR }
            : {}),
        },
      }
    );
    child.on('close', (code) => process.exit(code ?? 1));
  } else if (
    ['chown', 'pkill', '/opt/mst/bin/desktop-session'].includes(argv[0])
  ) {
    // Ownership and processes aren't modelled.
  } else if (argv[0] === 'install' && argv[1] === '-d') {
    // `install -d [-o u -g g -m mode] dir`: the directory, without ownership.
    fs.mkdirSync(inside(name, argv.at(-1)), { recursive: true });
  } else {
    const result = spawnSync(
      argv[0],
      argv.slice(1).map((value) => inside(name, value)),
      { stdio: ['inherit', 'inherit', 'inherit'] }
    );
    process.exit(result.status ?? 1);
  }
} else {
  fail(`fake docker: unsupported command ${command}`);
}
