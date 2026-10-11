// Prints the Cowork VM bundle that this Claude Desktop package expects, as
// JSON: { sha, arch, files: [{ name, checksum, size }] }. The manifest is a
// JavaScript object literal in the app's app.asar, which the app's publish
// step writes ("versions:[{sha:...,files:{unix:{arm64:[...]}}}]"); the first
// version is the current one.
//
// Usage: vm-bundle-manifest.mjs <app.asar> <arch>
// Exits 1 if the manifest isn't found, so the image build can go on without
// seeding the bundle: Claude Desktop then downloads it on first use.
import fs from 'node:fs';

const [asarPath, arch] = process.argv.slice(2);
const source = fs.readFileSync(asarPath, 'latin1');
const start = source.search(/versions:\[\{sha:"[0-9a-f]{40}"/);
if (start < 0) fail('no Cowork VM manifest in the app');

/** The text of the bracketed literal that opens at `from`. */
function literal(from) {
  const open = source[from];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let quoted = false;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === open || c === '[' || c === '{') depth++;
    else if (c === close || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return fail('the manifest is cut off');
}

// The literal's keys are unquoted identifiers, and its values are strings,
// numbers, arrays and objects: quote the keys and it's JSON.
const versionsText = literal(source.indexOf('[', start));
let versions;
try {
  versions = JSON.parse(
    versionsText.replace(/([{,])([A-Za-z_$][\w$]*):/g, '$1"$2":')
  );
} catch (error) {
  fail(`the manifest isn't readable: ${error.message}`);
}
const current = versions[0];
const files = current?.files?.unix?.[arch];
if (!Array.isArray(files) || !files.length)
  fail(
    `no ${arch} files in the manifest (has: ${Object.keys(current?.files?.unix ?? {}).join(', ')})`
  );
process.stdout.write(
  `${JSON.stringify({
    sha: current.sha,
    arch,
    files: files.map(({ name, checksum, size }) => ({ name, checksum, size })),
  })}\n`
);

function fail(message) {
  process.stderr.write(`vm-bundle-manifest: ${message}\n`);
  process.exit(1);
}
