/**
 * The agent skills in `skills/`, which `npx skills add` installs and the
 * package ships. They aren't covered by `docs:check`, so this keeps them
 * true to the code: every eval dataset, case and eval config they show
 * validates, they name no renamed client, and they link only to files an
 * agent can open from a consumer's project.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { resolveClientName } from '../src/evals/clientNames.js';
import { validateEvalConfig } from '../src/evals/configValidation.js';
import { validateEvalDataset } from '../src/evals/datasetTypes.js';
import { loadEvalConfigFromObject } from '../src/evals/evalConfig.js';

const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));

interface SkillFile {
  /** The path from `skills/`, for test names. */
  name: string;
  path: string;
  text: string;
}

function skillDirs(): string[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

function skillFiles(): SkillFile[] {
  return markdownFiles(SKILLS)
    .sort()
    .map((file) => ({
      name: path.relative(SKILLS, file),
      path: file,
      text: readFileSync(file, 'utf8'),
    }));
}

/** The ```json blocks that parse as JSON, with the line each starts on. */
function jsonBlocks(text: string): Array<{ line: number; value: unknown }> {
  const blocks: Array<{ line: number; value: unknown }> = [];
  for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    const line = text.slice(0, match.index).split('\n').length;
    try {
      blocks.push({ line, value: JSON.parse(match[1]!) });
    } catch {
      // A fragment, such as one key of an assertions block.
    }
  }
  return blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lines outside the 1.x rename tables, whose first column lists old names
 * on purpose.
 */
function linesOutsideRenameTables(text: string): string[] {
  const lines: string[] = [];
  let inRenameTable = false;
  for (const line of text.split('\n')) {
    const isRow = line.startsWith('|');
    if (!isRow) inRenameTable = false;
    else if (/^\|\s*1\.x\s*\|/.test(line)) inRenameTable = true;
    if (!inRenameTable) lines.push(line);
  }
  return lines;
}

describe('shipped skills', () => {
  it.each(skillDirs())('%s has valid frontmatter', (dir) => {
    const file = path.join(SKILLS, dir, 'SKILL.md');
    expect(existsSync(file)).toBe(true);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(
      readFileSync(file, 'utf8')
    );
    expect(frontmatter).not.toBeNull();
    const meta = parseYaml(frontmatter![1]!) as Record<string, unknown>;
    // The Agent Skills spec: the name is the directory's, in kebab-case,
    // and the description is at most 1024 characters.
    expect(meta.name).toBe(dir);
    expect(dir).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof meta.description).toBe('string');
    expect((meta.description as string).length).toBeGreaterThan(0);
    expect((meta.description as string).length).toBeLessThanOrEqual(1024);
  });

  describe.each(skillFiles())('$name', ({ path: file, text }) => {
    it('shows only eval datasets, cases and eval configs that validate', () => {
      for (const { line, value } of jsonBlocks(text)) {
        if (!isRecord(value)) continue;
        const where = `${path.basename(file)}:${line}`;
        if (Array.isArray(value.cases)) {
          expect(() => validateEvalDataset(value), where).not.toThrow();
        } else if (Array.isArray(value.datasets)) {
          expect(
            () =>
              validateEvalConfig(
                loadEvalConfigFromObject(value, { skipDatasetValidation: true })
              ),
            where
          ).not.toThrow();
        } else if (typeof value.id === 'string' && 'input' in value) {
          expect(
            () =>
              validateEvalDataset({ name: 'skill-example', cases: [value] }),
            where
          ).not.toThrow();
        }
      }
    });

    it('names no renamed client', () => {
      const stale: string[] = [];
      for (const line of linesOutsideRenameTables(text)) {
        for (const [, token] of line.matchAll(/`([\w.-]+)`/g)) {
          // `mst` is the CLI's name as well as the api client's old one.
          if (token === 'mst') continue;
          try {
            resolveClientName(token!);
          } catch (error) {
            stale.push(`${line.trim()}\n  ${(error as Error).message}`);
          }
        }
      }
      expect(stale).toEqual([]);
    });

    it("links only to files a consumer's agent can open", () => {
      // The repo's docs aren't in the package or the installed skill.
      const withoutUrls = text.replace(/https?:\/\/[^\s)>`]+/g, '');
      expect(withoutUrls.match(/\bdocs\/[\w./-]+\.md\b/g) ?? []).toEqual([]);
      // Links within a skill, such as references/, resolve.
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        expect(
          existsSync(path.resolve(path.dirname(file), target!)),
          target
        ).toBe(true);
      }
    });
  });
});
