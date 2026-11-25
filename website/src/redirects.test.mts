import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Redirects in vercel.json keep the URLs of moved or removed pages working.
// Each one must lead from a URL no page serves to a page that exists.

const website = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const docsDir = path.resolve(website, '../docs');

interface Redirect {
  source: string;
  destination: string;
}

const { redirects = [] } = JSON.parse(
  readFileSync(path.join(website, 'vercel.json'), 'utf8')
) as { redirects?: Redirect[] };

/** The Markdown files that would serve a /docs/ URL, as Docusaurus routes them. */
function pagesFor(url: string): string[] {
  const route = url.replace(/^\/docs\/?/, '');
  const base = path.join(docsDir, route);
  return [
    `${base}.md`,
    path.join(base, 'README.md'),
    path.join(base, 'index.md'),
  ];
}

test('vercel.json has redirects', () => {
  assert.ok(redirects.length > 0);
});

for (const { source, destination } of redirects) {
  test(`${source} redirects to a page that exists`, () => {
    assert.match(destination, /^\/docs\//);
    assert.ok(
      pagesFor(destination).some((file) => existsSync(file)),
      `no page in docs/ serves ${destination}`
    );
  });

  test(`${source} is not a page any more`, () => {
    const served = pagesFor(source).filter((file) => existsSync(file));
    assert.deepEqual(
      served,
      [],
      `${source} still has a page, so the redirect hides it`
    );
  });
}
