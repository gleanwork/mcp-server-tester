import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/**
 * Every Mermaid diagram in the repo's Markdown renders, with the Mermaid the
 * docs site uses (website/node_modules). The site build doesn't parse
 * diagrams: a broken one builds and shows an error box in the browser.
 * Mermaid needs a DOM to parse a flowchart, so this runs in a browser.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MERMAID = path.join(
  REPO,
  'website/node_modules/mermaid/dist/mermaid.min.js'
);

function markdownIn(dir: string): string[] {
  return readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const file = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) return markdownIn(file);
      return file.endsWith('.md') ? [file] : [];
    }
  );
}

interface Diagram {
  where: string;
  source: string;
}

function diagrams(): Diagram[] {
  const files = [
    ...markdownIn('docs'),
    ...markdownIn('skills'),
    ...readdirSync(REPO).filter((file) => file.endsWith('.md')),
  ];
  return files.flatMap((file) => {
    const text = readFileSync(path.join(REPO, file), 'utf8');
    return [...text.matchAll(/^```mermaid\n([\s\S]*?)^```/gm)].map((match) => ({
      where: `${file}:${text.slice(0, match.index).split('\n').length}`,
      source: match[1]!,
    }));
  });
}

test('every Mermaid diagram renders', async ({ page }) => {
  const found = diagrams();
  // A guard: the architecture page alone has several.
  expect(found.length).toBeGreaterThan(4);

  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: MERMAID });
  const failures = await page.evaluate(async (all) => {
    const mermaid = (
      globalThis as unknown as {
        mermaid: {
          initialize(config: object): void;
          render(id: string, source: string): Promise<unknown>;
        };
      }
    ).mermaid;
    mermaid.initialize({ startOnLoad: false });
    const problems: string[] = [];
    for (const [index, { where, source }] of all.entries()) {
      try {
        await mermaid.render(`diagram-${index}`, source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        problems.push(`${where}: ${message.split('\n')[0]}`);
      }
    }
    return problems;
  }, found);
  expect(failures).toEqual([]);
});
