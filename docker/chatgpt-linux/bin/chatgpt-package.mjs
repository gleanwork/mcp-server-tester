#!/usr/bin/env node
// Downloads the ChatGPT package for this architecture from OpenAI's apt
// repository, checked against the repository index's SHA-256 and size.
//
// Usage: chatgpt-package.mjs <repository> <version or ""> <output>
// An empty version takes the newest the index lists. Run it with
// NODE_USE_ENV_PROXY=1, as the Dockerfile does, so fetch honors HTTPS_PROXY
// and NO_PROXY in a proxied build, as the Python helper's urllib did.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';

const [repositoryArg, version, output] = process.argv.slice(2);
if (!repositoryArg || version === undefined || !output) {
  console.error(
    'Usage: chatgpt-package.mjs <repository> <version or ""> <output>'
  );
  process.exit(2);
}
const repository = repositoryArg.replace(/\/+$/, '');
const arch = execFileSync('dpkg', ['--print-architecture'], {
  encoding: 'utf8',
}).trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Ten minutes without data ends a request, as urllib's socket timeout did; a slow download still finishes. */
const IDLE_MS = 600_000;

/** The response, and `progress`, which a reader calls on each chunk to restart the idle timer. */
async function fetchOk(url) {
  if (!url.startsWith('https://')) fail(`Refusing a non-HTTPS URL: ${url}`);
  const controller = new AbortController();
  let timer;
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          new Error(`${url} sent nothing for ${IDLE_MS / 1000} s.`)
        ),
      IDLE_MS
    );
    timer.unref();
  };
  progress();
  // The CDN refuses generic user agents.
  const response = await fetch(url, {
    headers: { 'User-Agent': 'mst-chatgpt-image/1' },
    signal: controller.signal,
  });
  if (!response.ok) fail(`${url} returned HTTP ${response.status}.`);
  return { response, progress };
}

/** Version parts compared numerically when both are digits, else as text. */
function compareVersions(a, b) {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] === undefined) return -1;
    if (right[i] === undefined) return 1;
    const numeric = /^\d+$/.test(left[i]) && /^\d+$/.test(right[i]);
    const order = numeric
      ? Number(left[i]) - Number(right[i])
      : left[i] < right[i]
        ? -1
        : left[i] > right[i]
          ? 1
          : 0;
    if (order !== 0) return order;
  }
  return 0;
}

const index = await (
  await fetchOk(`${repository}/dists/stable/main/binary-${arch}/Packages`)
).response.text();
let entries = index
  .split('\n\n')
  .map((stanza) =>
    Object.fromEntries(
      stanza
        .split('\n')
        .filter((line) => line.includes(': '))
        .map((line) => {
          const at = line.indexOf(': ');
          return [line.slice(0, at), line.slice(at + 2)];
        })
    )
  )
  .filter(
    (fields) => fields.Package === 'chatgpt' && fields.Architecture === arch
  );
if (version) entries = entries.filter((entry) => entry.Version === version);
if (!entries.length)
  fail(`No chatgpt ${version || 'package'} for ${arch} in ${repository}.`);

const entry = entries.reduce((best, next) =>
  compareVersions(next.Version, best.Version) > 0 ? next : best
);
const digest = createHash('sha256');
let size = 0;
const file = createWriteStream(output);
const download = await fetchOk(`${repository}/${entry.Filename}`);
for await (const chunk of download.response.body) {
  download.progress();
  digest.update(chunk);
  size += chunk.length;
  if (!file.write(chunk)) await once(file, 'drain');
}
file.end();
await once(file, 'finish');
if (digest.digest('hex') !== entry.SHA256 || size !== Number(entry.Size))
  fail(
    `chatgpt ${entry.Version} didn't match the repository index's checksum.`
  );
console.log(`chatgpt ${entry.Version} (${arch}), SHA-256 ${entry.SHA256}`);
