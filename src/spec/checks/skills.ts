import { randomUUID } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/client';
import type { Resource } from '@modelcontextprotocol/client';
import {
  getSkill,
  getSkillsExtension,
  listSkills,
  readSkillDirectory,
  readSkillFile,
  verifySkillFile,
} from '../../skills/skillsClient.js';
import {
  skillRootUri,
  stableJson,
  validateSkillEntry,
} from '../../skills/skillEntry.js';
import type { SkillEntry } from '../../skills/skillsTypes.js';
import type {
  ConformanceCheckDefinition,
  ConformanceContext,
} from '../registry.js';
import { errorCodeOf } from '../probe.js';

/** Options for the skills extension checks. */
export interface SkillsCheckOptions {
  /**
   * How many skills to read and round-trip through `skills/get`.
   * @default 25
   */
  maxSkills?: number;
  /**
   * Which files to read and verify: each skill's SKILL.md, or every listed
   * file (slower on large catalogs).
   * @default 'skill-md'
   */
  verifyFiles?: 'skill-md' | 'all';
}

const SEP = 'https://modelcontextprotocol.io/seps/2640-skills-extension';
const ENTRIES_KEY = 'skills.entries';
const both = ['legacy', 'modern'] as const;

function entries(context: ConformanceContext): SkillEntry[] | undefined {
  return context.shared.get(ENTRIES_KEY) as SkillEntry[] | undefined;
}

function declared(context: ConformanceContext): boolean {
  return getSkillsExtension(context.mcp.client) !== null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks for servers that declare `io.modelcontextprotocol/skills`
 * (SEP-2640). Omitted entirely when the extension is not declared.
 */
export function skillsChecks(
  options: SkillsCheckOptions = {}
): ConformanceCheckDefinition[] {
  const maxSkills = options.maxSkills ?? 25;
  const sample = (context: ConformanceContext) =>
    (entries(context) ?? []).slice(0, maxSkills);

  return [
    {
      name: 'skills_extension_declares_resources',
      eras: both,
      severity: 'must',
      specRef: `${SEP}#capability-declaration`,
      async run(context) {
        if (!declared(context)) return null;
        return context.capabilities?.resources
          ? {
              pass: true,
              message:
                'Skills extension declared with the resources capability',
            }
          : {
              pass: false,
              message:
                'Servers declaring io.modelcontextprotocol/skills must also declare the resources capability',
            };
      },
    },
    {
      name: 'skills_list_succeeds',
      eras: both,
      severity: 'must',
      specRef: `${SEP}#enumeration-via-skillslist`,
      async run(context) {
        if (!declared(context)) return null;
        try {
          const skills = await listSkills(context.mcp.client);
          context.shared.set(ENTRIES_KEY, skills);
          return {
            pass: true,
            message: `skills/list returned ${skills.length} skill${skills.length === 1 ? '' : 's'}`,
          };
        } catch (error) {
          return {
            pass: false,
            message: `skills/list failed: ${describeError(error)}`,
          };
        }
      },
    },
    {
      name: 'skills_entries_valid',
      eras: both,
      severity: 'must',
      specRef: `${SEP}#enumeration-via-skillslist`,
      async run(context) {
        const skills = entries(context);
        if (!skills) return null;
        if (skills.length === 0) return { skip: 'skills/list is empty.' };
        const problems = skills.flatMap((entry) =>
          validateSkillEntry(entry)
            .filter((problem) => problem.severity === 'must')
            .map((problem) => problem.message)
        );
        return problems.length === 0
          ? { pass: true, message: `All ${skills.length} entries are valid` }
          : { pass: false, message: problems.join('; ') };
      },
    },
    {
      name: 'skills_within_limits',
      eras: both,
      severity: 'should',
      specRef: `${SEP}#limits`,
      async run(context) {
        const skills = entries(context);
        if (!skills || skills.length === 0) return null;
        const problems = skills.flatMap((entry) =>
          validateSkillEntry(entry)
            .filter((problem) => problem.severity === 'should')
            .map((problem) => `${entry.uri}: ${problem.message}`)
        );
        return problems.length === 0
          ? {
              pass: true,
              message: 'Every skill is within the 512-file / 16 MiB limits',
            }
          : { pass: false, message: problems.join('; ') };
      },
    },
    {
      name: 'skills_list_cache_hints',
      eras: ['modern'],
      severity: 'must',
      specRef: `${SEP}#enumeration-via-skillslist`,
      async run(context) {
        if (!entries(context)) return null;
        const exchange = context.tap?.lastExchange('skills/list');
        if (!exchange) {
          return {
            skip: 'Needs the raw wire; only available for clients created by MST.',
          };
        }
        const { ttlMs, cacheScope } = (exchange.response.result ?? {}) as {
          ttlMs?: unknown;
          cacheScope?: unknown;
        };
        const valid =
          typeof ttlMs === 'number' &&
          ttlMs >= 0 &&
          (cacheScope === 'public' || cacheScope === 'private');
        return valid
          ? {
              pass: true,
              message: `skills/list ttlMs=${ttlMs}, cacheScope=${String(cacheScope)}`,
            }
          : {
              pass: false,
              message: `skills/list must carry ttlMs and cacheScope on 2026-07-28 (got ttlMs=${JSON.stringify(ttlMs)}, cacheScope=${JSON.stringify(cacheScope)})`,
            };
      },
    },
    {
      name: 'skills_get_matches_list',
      eras: both,
      severity: 'must',
      specRef: `${SEP}#retrieval-via-skillsget`,
      async run(context) {
        const skills = sample(context);
        if (!entries(context)) return null;
        if (skills.length === 0) return { skip: 'skills/list is empty.' };
        const problems: string[] = [];
        for (const entry of skills) {
          try {
            const fetched = await getSkill(context.mcp.client, entry.uri);
            if (stableJson(fetched) !== stableJson(entry)) {
              problems.push(
                `${entry.uri}: skills/get entry differs from skills/list`
              );
            }
          } catch (error) {
            problems.push(
              `${entry.uri}: skills/get failed: ${describeError(error)}`
            );
          }
        }
        return problems.length === 0
          ? {
              pass: true,
              message: `skills/get matches skills/list for ${skills.length} skill(s)`,
            }
          : { pass: false, message: problems.join('; ') };
      },
    },
    {
      name: 'skills_get_unknown_uri',
      eras: both,
      severity: 'must',
      specRef: `${SEP}#retrieval-via-skillsget`,
      async run(context) {
        if (!declared(context)) return null;
        const uri = `skill://mst-conformance-${randomUUID().slice(0, 8)}/SKILL.md`;
        try {
          await getSkill(context.mcp.client, uri);
          return {
            pass: false,
            message: `skills/get answered for ${uri}, which the server does not serve`,
          };
        } catch (error) {
          if (!(error instanceof ProtocolError)) {
            return {
              pass: false,
              message: `skills/get of an unknown URI failed locally: ${describeError(error)}`,
            };
          }
          const code =
            errorCodeOf(
              context.tap?.lastExchange('skills/get')?.response ?? null
            ) ?? error.code;
          return code === -32602
            ? { pass: true, message: 'Unknown skill URI returned -32602' }
            : {
                pass: false,
                message: `Unknown skill URI returned ${code}; expected -32602`,
              };
        }
      },
    },
    {
      name: 'skills_content_verified',
      eras: both,
      severity: 'must',
      specRef: `${SEP}#integrity-and-verification`,
      async run(context) {
        const skills = sample(context);
        if (!entries(context)) return null;
        if (skills.length === 0) return { skip: 'skills/list is empty.' };
        const problems: string[] = [];
        let files = 0;
        let dynamic = 0;
        for (const entry of skills) {
          if (entry.resources === 'dynamic') {
            dynamic += 1;
            continue;
          }
          const uris =
            options.verifyFiles === 'all'
              ? entry.resources.map((resource) => resource.uri)
              : [entry.uri];
          for (const uri of uris) {
            files += 1;
            try {
              problems.push(
                ...verifySkillFile(
                  entry,
                  await readSkillFile(context.mcp.client, uri)
                )
              );
            } catch (error) {
              problems.push(
                `${uri}: resources/read failed: ${describeError(error)}`
              );
            }
          }
        }
        if (files === 0) {
          return {
            skip: `All ${dynamic} sampled skill(s) are "dynamic"; nothing to verify.`,
          };
        }
        return problems.length === 0
          ? {
              pass: true,
              message: `${files} file(s) match their digests, sizes, and frontmatter${dynamic ? ` (${dynamic} dynamic skill(s) not verifiable)` : ''}`,
            }
          : { pass: false, message: problems.join('; ') };
      },
    },
    {
      name: 'skill_md_resource_metadata',
      eras: both,
      severity: 'should',
      specRef: `${SEP}#resource-metadata`,
      async run(context) {
        const skills = entries(context);
        if (!skills || skills.length === 0) return null;
        let resources: Resource[];
        try {
          resources = (await context.mcp.client.listResources()).resources;
        } catch (error) {
          return { skip: `resources/list failed: ${describeError(error)}` };
        }
        const byUri = new Map(
          resources.map((resource) => [resource.uri, resource])
        );
        const listed = skills.filter((entry) => byUri.has(entry.uri));
        if (listed.length === 0) {
          return { skip: 'No SKILL.md appears in resources/list (allowed).' };
        }
        const problems: string[] = [];
        for (const entry of listed) {
          const resource = byUri.get(entry.uri)!;
          if (resource.mimeType !== 'text/markdown') {
            problems.push(
              `${entry.uri}: mimeType ${String(resource.mimeType)}, expected text/markdown`
            );
          }
          if (resource.name !== entry.frontmatter.name) {
            problems.push(
              `${entry.uri}: name "${resource.name}" is not the frontmatter name`
            );
          }
          if (resource.description !== entry.frontmatter.description) {
            problems.push(
              `${entry.uri}: description is not the frontmatter description`
            );
          }
        }
        return problems.length === 0
          ? {
              pass: true,
              message: `${listed.length} listed SKILL.md resource(s) carry frontmatter metadata`,
            }
          : { pass: false, message: problems.join('; ') };
      },
    },
    {
      name: 'skills_directory_read',
      eras: both,
      severity: 'must',
      specRef: `${SEP}#resourcesdirectoryread`,
      async run(context) {
        if (!getSkillsExtension(context.mcp.client)?.directoryRead) return null;
        const entry = entries(context)?.find((candidate) =>
          skillRootUri(candidate.uri)
        );
        if (!entry) return { skip: 'No skill to read a directory of.' };
        const root = skillRootUri(entry.uri)!;
        const problems: string[] = [];
        try {
          const { resources } = await readSkillDirectory(
            context.mcp.client,
            root
          );
          const outside = resources.filter(
            (child) => !child.uri.startsWith(`${root}/`)
          );
          if (outside.length > 0) {
            problems.push(
              `children outside ${root}: ${outside.map((c) => c.uri).join(', ')}`
            );
          }
          if (!resources.some((child) => child.uri === entry.uri)) {
            problems.push(`${root} listing does not include ${entry.uri}`);
          }
        } catch (error) {
          problems.push(
            `resources/directory/read ${root} failed: ${describeError(error)}`
          );
        }
        try {
          await readSkillDirectory(context.mcp.client, entry.uri);
          problems.push(
            `resources/directory/read of the file ${entry.uri} did not fail`
          );
        } catch (error) {
          const code =
            errorCodeOf(
              context.tap?.lastExchange('resources/directory/read')?.response ??
                null
            ) ?? (error instanceof ProtocolError ? error.code : null);
          if (code !== -32602) {
            problems.push(
              `reading a non-directory returned ${String(code)}; expected -32602`
            );
          }
        }
        return problems.length === 0
          ? {
              pass: true,
              message: `resources/directory/read lists ${root} and rejects non-directories`,
            }
          : { pass: false, message: problems.join('; ') };
      },
    },
  ];
}
