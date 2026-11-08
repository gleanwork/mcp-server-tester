import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Root } from 'mdast';
import repoLinks, { repoLinkFor, type RepoLinksOptions } from './repoLinks.mts';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
);
const options: RepoLinksOptions = {
  repoRoot,
  docsDir: path.join(repoRoot, 'docs'),
  repoUrl: 'https://github.com/gleanwork/mcp-server-tester',
  branch: 'main',
};
const page = path.join(repoRoot, 'docs', 'cli.md');
const blob = `${options.repoUrl}/blob/main`;
const tree = `${options.repoUrl}/tree/main`;

test('leaves links between pages in docs/ to Docusaurus', () => {
  assert.equal(repoLinkFor('./quickstart.md', page, options), null);
  assert.equal(repoLinkFor('judges.md#rubric', page, options), null);
});

test('points a directory in docs/ at the GitHub tree view', () => {
  assert.equal(repoLinkFor('./adr/', page, options), `${tree}/docs/adr`);
});

test('leaves absolute, external and fragment links alone', () => {
  assert.equal(repoLinkFor('https://example.com', page, options), null);
  assert.equal(repoLinkFor('mailto:a@b.c', page, options), null);
  assert.equal(repoLinkFor('#usage', page, options), null);
  assert.equal(repoLinkFor('/docs/cli', page, options), null);
});

test('points files outside docs/ at GitHub, keeping the fragment', () => {
  assert.equal(
    repoLinkFor('../AGENTS.md#architecture', page, options),
    `${blob}/AGENTS.md#architecture`
  );
  assert.equal(
    repoLinkFor('../package.json', page, options),
    `${blob}/package.json`
  );
});

test('points directories at the GitHub tree view', () => {
  assert.equal(repoLinkFor('../examples', page, options), `${tree}/examples`);
  assert.equal(repoLinkFor('../docs', page, options), `${tree}/docs`);
});

test('fails on a link to a file that does not exist', () => {
  assert.throws(
    () => repoLinkFor('../no-such-file.ts', page, options),
    /Broken link in docs\/cli\.md: \.\.\/no-such-file\.ts/
  );
});

test('rewrites link and definition nodes in a page', () => {
  const root: Root = {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            url: '../examples',
            children: [{ type: 'text', value: 'examples' }],
          },
        ],
      },
      { type: 'definition', identifier: 'a', url: '../AGENTS.md' },
    ],
  };
  repoLinks(options)(root, { path: page });
  const [paragraph, definition] = root.children;
  assert.equal(
    paragraph.type === 'paragraph' && paragraph.children[0].type === 'link'
      ? paragraph.children[0].url
      : null,
    `${tree}/examples`
  );
  assert.equal(
    definition.type === 'definition' ? definition.url : null,
    `${blob}/AGENTS.md`
  );
});

test('skips pages outside the docs directory', () => {
  const root: Root = {
    type: 'root',
    children: [{ type: 'definition', identifier: 'a', url: '../nowhere' }],
  };
  repoLinks(options)(root, { path: path.join(repoRoot, 'website', 'x.md') });
  const [definition] = root.children;
  assert.equal(
    definition.type === 'definition' ? definition.url : null,
    '../nowhere'
  );
});
