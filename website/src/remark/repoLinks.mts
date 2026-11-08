/**
 * A remark plugin for pages read from the repo's docs/ directory.
 *
 * The pages are written to be read on GitHub too, so they link to files
 * outside docs/ with relative paths: `../examples`, `../src/judge/prompts/`,
 * `../../CONTEXT.md`. On the site those paths go nowhere. This plugin rewrites
 * each one to the file on GitHub, and fails the build when the target doesn't
 * exist, which GitHub never checks.
 *
 * Links between pages in docs/ are left alone: Docusaurus resolves them, and
 * `onBrokenMarkdownLinks: 'throw'` fails the build when one is broken.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Definition, Link, Nodes, Root } from 'mdast';

export interface RepoLinksOptions {
  /** Absolute path of the repository root. */
  repoRoot: string;
  /** Absolute path of the docs directory the site renders. */
  docsDir: string;
  /** The repository on GitHub, such as `https://github.com/org/repo`. */
  repoUrl: string;
  /** The branch the GitHub links point at. */
  branch: string;
}

interface MarkdownFile {
  path?: string;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The GitHub URL for a relative link from a page, or null to leave it as is. */
export function repoLinkFor(
  url: string,
  pagePath: string,
  options: RepoLinksOptions
): string | null {
  if (url === '' || url.startsWith('#') || url.startsWith('/')) return null;
  if (SCHEME.test(url)) return null;

  const hashAt = url.indexOf('#');
  const target = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const resolved = path.resolve(path.dirname(pagePath), decodeURI(target));

  const inDocs = !path.relative(options.docsDir, resolved).startsWith('..');
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) {
    // A missing page in docs/ is Docusaurus' to report, with its own message.
    if (inDocs && /\.mdx?$/.test(resolved)) return null;
    throw new Error(
      `Broken link in ${path.relative(options.repoRoot, pagePath)}: ${url} (no file at ${path.relative(options.repoRoot, resolved)})`
    );
  }
  if (inDocs && !stat.isDirectory()) return null;

  const repoPath = path
    .relative(options.repoRoot, resolved)
    .split(path.sep)
    .join('/');
  if (repoPath.startsWith('..')) {
    throw new Error(
      `Link outside the repository in ${path.relative(options.repoRoot, pagePath)}: ${url}`
    );
  }
  const kind = stat.isDirectory() ? 'tree' : 'blob';
  return `${options.repoUrl}/${kind}/${options.branch}/${repoPath}${hash}`;
}

function visitLinks(node: Nodes, visit: (node: Link | Definition) => void) {
  if (node.type === 'link' || node.type === 'definition') visit(node);
  if ('children' in node) {
    for (const child of node.children) visitLinks(child, visit);
  }
}

export default function repoLinks(options: RepoLinksOptions) {
  return function transform(tree: Root, file: MarkdownFile) {
    const pagePath = file.path;
    if (!pagePath) return;
    if (path.relative(options.docsDir, pagePath).startsWith('..')) return;
    visitLinks(tree, (node) => {
      const url = repoLinkFor(node.url, pagePath, options);
      if (url !== null) node.url = url;
    });
  };
}
