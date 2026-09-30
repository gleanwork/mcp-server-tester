/**
 * Serves the skills under tests/mocks/skills/ over the MCP skills extension
 * (SEP-2640): each file as a `skill://` resource, plus `skills/list`,
 * `skills/get`, and `resources/directory/read`.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import {
  ProtocolError,
  ProtocolErrorCode,
  type McpServer,
} from '@modelcontextprotocol/server';

const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';
const SKILLS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skills'
);

interface MockSkillFile {
  uri: string;
  relativePath: string;
  bytes: Buffer;
  mimeType: string;
}

interface MockSkill {
  uri: string;
  root: string;
  frontmatter: Record<string, unknown>;
  files: MockSkillFile[];
}

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    return statSync(full).isDirectory()
      ? listFiles(full, relative)
      : [relative];
  });
}

function loadSkills(): MockSkill[] {
  return readdirSync(SKILLS_DIR).map((name) => {
    const dir = path.join(SKILLS_DIR, name);
    const root = `skill://${name}`;
    const files = listFiles(dir)
      .sort()
      .map((relativePath) => ({
        uri: `${root}/${relativePath}`,
        relativePath,
        bytes: readFileSync(path.join(dir, relativePath)),
        mimeType: relativePath.endsWith('.md') ? 'text/markdown' : 'text/plain',
      }));
    const skillMd = files.find((file) => file.relativePath === 'SKILL.md')!;
    const frontmatter = parseYaml(
      /^---\n([\s\S]*?)\n---/.exec(skillMd.bytes.toString('utf8'))![1]!
    ) as Record<string, unknown>;
    return { uri: skillMd.uri, root, frontmatter, files };
  });
}

/**
 * Spec violations for skills-check tests, from MOCK_SKILL_FAULTS
 * (comma-separated): bad-digest, wrong-size, frontmatter-mismatch,
 * name-mismatch, unlisted-skill-md, get-differs, get-unknown-ok,
 * no-cache-hints, bad-mime, dir-accepts-files, dir-unknown-ok,
 * no-resources, list-error, invalid-entry.
 *
 * SEP-legal variations that must still pass, from MOCK_SKILL_VARIANTS:
 * blob (SKILL.md served as a blob), dynamic (resources: "dynamic"),
 * paginate (skills/list over two pages), get-extra (skills/get adds _meta and
 * reorders resources).
 */
function envSet(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}
const faults = envSet('MOCK_SKILL_FAULTS');
const variants = envSet('MOCK_SKILL_VARIANTS');

function toEntry(skill: MockSkill) {
  const resources = skill.files
    .filter(
      (file) =>
        !(faults.has('unlisted-skill-md') && file.relativePath === 'SKILL.md')
    )
    .map((file) => {
      const isSkillMd = file.relativePath === 'SKILL.md';
      const digest = createHash('sha256').update(file.bytes).digest('hex');
      return {
        uri: file.uri,
        digest: `sha256:${faults.has('bad-digest') && isSkillMd ? digest.replace(/^./, digest[0] === '0' ? '1' : '0') : digest}`,
        size:
          file.bytes.byteLength +
          (faults.has('wrong-size') && isSkillMd ? 1 : 0),
      };
    });
  return {
    uri: skill.uri,
    ...(variants.has('dynamic') ? { resources: 'dynamic' as const } : {}),
    frontmatter: {
      ...skill.frontmatter,
      ...(faults.has('frontmatter-mismatch')
        ? { description: 'Not what SKILL.md says' }
        : {}),
      ...(faults.has('name-mismatch') ? { name: 'renamed-skill' } : {}),
    },
    ...(variants.has('dynamic') ? {} : { resources }),
  };
}

/** Direct children of a directory URI within the served skills. */
function directoryChildren(skills: MockSkill[], uri: string) {
  const skill = skills.find(
    (candidate) =>
      uri === candidate.root || uri.startsWith(`${candidate.root}/`)
  );
  if (!skill) return null;
  const prefix = `${uri}/`;
  const children = new Map<
    string,
    { uri: string; name: string; mimeType: string }
  >();
  for (const file of skill.files) {
    if (!file.uri.startsWith(prefix)) continue;
    const rest = file.uri.slice(prefix.length);
    const [head, ...tail] = rest.split('/');
    const childUri = `${prefix}${head}`;
    children.set(childUri, {
      uri: childUri,
      name: head!,
      mimeType: tail.length > 0 ? 'inode/directory' : file.mimeType,
    });
  }
  return children.size > 0 ? [...children.values()] : null;
}

/** Registers the mock skills on a server and declares the extension. */
export function registerMockSkills(server: McpServer): void {
  const skills = loadSkills();
  // no-resources: declares the extension without the resources capability.
  for (const skill of faults.has('no-resources') ? [] : skills) {
    for (const file of skill.files) {
      const isSkillMd = file.relativePath === 'SKILL.md';
      server.registerResource(
        isSkillMd
          ? String(skill.frontmatter.name)
          : `${String(skill.frontmatter.name)}/${file.relativePath}`,
        file.uri,
        {
          mimeType:
            faults.has('bad-mime') && isSkillMd ? 'text/plain' : file.mimeType,
          ...(isSkillMd
            ? { description: String(skill.frontmatter.description) }
            : {}),
        },
        async () => ({
          contents: [
            variants.has('blob') && isSkillMd
              ? {
                  uri: file.uri,
                  mimeType: file.mimeType,
                  blob: file.bytes.toString('base64'),
                }
              : {
                  uri: file.uri,
                  mimeType: file.mimeType,
                  text: file.bytes.toString('utf8'),
                },
          ],
        })
      );
    }
  }

  const entries = new Map(skills.map((skill) => [skill.uri, toEntry(skill)]));
  const cacheHints = () => {
    const version = server.server.getNegotiatedProtocolVersion();
    return version !== undefined &&
      version >= '2026-07-28' &&
      !faults.has('no-cache-hints')
      ? { ttlMs: 0, cacheScope: 'private' as const }
      : {};
  };

  server.server.setRequestHandler(
    'skills/list',
    { params: z.looseObject({ cursor: z.string().optional() }).optional() },
    async (params) => {
      if (faults.has('list-error')) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          'skills/list is broken'
        );
      }
      const all: unknown[] = [...entries.values()];
      if (faults.has('invalid-entry'))
        all.push({ uri: 'skill://broken/SKILL.md' });
      // paginate: an empty first page, then the skills.
      if (variants.has('paginate') && params?.cursor !== 'page-2') {
        return { skills: [], nextCursor: 'page-2', ...cacheHints() };
      }
      return { skills: all, ...cacheHints() };
    }
  );
  server.server.setRequestHandler(
    'skills/get',
    { params: z.looseObject({ uri: z.string() }) },
    async ({ uri }) => {
      const skill =
        entries.get(uri) ??
        (faults.has('get-unknown-ok') ? [...entries.values()][0] : undefined);
      if (skill && faults.has('get-differs')) {
        return {
          skill: {
            ...skill,
            frontmatter: { ...skill.frontmatter, license: 'changed' },
          },
        };
      }
      if (!skill) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown skill: ${uri}`
        );
      }
      if (variants.has('get-extra')) {
        return {
          skill: {
            ...skill,
            _meta: { 'com.example/served-by': 'mock' },
            ...(Array.isArray(skill.resources)
              ? { resources: [...skill.resources].reverse() }
              : {}),
          },
        };
      }
      return { skill };
    }
  );
  server.server.setRequestHandler(
    'resources/directory/read',
    { params: z.looseObject({ uri: z.string() }) },
    async ({ uri }) => {
      const children = directoryChildren(skills, uri);
      const isKnownFile = skills.some((skill) =>
        skill.files.some((file) => file.uri === uri)
      );
      if (
        !children &&
        ((isKnownFile && faults.has('dir-accepts-files')) ||
          (!isKnownFile && faults.has('dir-unknown-ok')))
      ) {
        return { resources: [] };
      }
      if (!children) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Not a directory: ${uri}`
        );
      }
      return { resources: children };
    }
  );
  server.server.registerCapabilities({
    ...(faults.has('no-resources') ? {} : { resources: {} }),
    extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } },
  });
}
