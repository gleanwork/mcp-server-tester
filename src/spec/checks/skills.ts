import { randomUUID } from 'node:crypto';
import { ProtocolError } from '@modelcontextprotocol/client';
import type { Resource } from '@modelcontextprotocol/client';
import {
  getSkill,
  getSkillsExtension,
  listSkillsDetailed,
  readSkillDirectory,
  readSkillFile,
  verifySkillFile,
  type SkillsListing,
} from '../../skills/skillsClient.js';
import {
  skillRootUri,
  stableJson,
  validateSkillEntry,
} from '../../skills/skillEntry.js';
import type { SkillEntry } from '../../skills/skillsTypes.js';
import { errorMessage } from '../../utils/errorMessage.js';
import type {
  CheckOutcome,
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
  /**
   * How many `skills/list` pages to read. SEP-2640 allows listings of any
   * size, so reaching the limit is reported, not failed.
   * @default 64
   */
  maxPages?: number;
}

const SEP = 'https://modelcontextprotocol.io/seps/2640-skills-extension';
const LISTING_KEY = 'skills.listing';
const both = ['legacy', 'modern'] as const;
const EMPTY: CheckOutcome = { skip: 'skills/list is empty.' };

function listing(context: ConformanceContext): SkillsListing | undefined {
  return context.shared.get(LISTING_KEY) as SkillsListing | undefined;
}

function entries(context: ConformanceContext): SkillEntry[] | undefined {
  return listing(context)?.skills;
}

function declared(context: ConformanceContext): boolean {
  return getSkillsExtension(context.mcp.client) !== null;
}

/** Pass when there are no problems, otherwise fail listing them. */
function fromProblems(problems: string[], passMessage: string): CheckOutcome {
  return problems.length === 0
    ? { pass: true, message: passMessage }
    : { pass: false, message: problems.join('; ') };
}

/** The parts of an entry `skills/get` must agree on, independent of order. */
function entryShape(entry: SkillEntry): string {
  return stableJson({
    uri: entry.uri,
    frontmatter: entry.frontmatter,
    resources:
      entry.resources === 'dynamic'
        ? 'dynamic'
        : entry.resources
            .map((file) => `${file.uri}|${file.digest}|${file.size}`)
            .sort(),
  });
}

/** The code the server sent, preferring the raw wire over the SDK's class. */
function wireErrorCode(
  context: ConformanceContext,
  method: string,
  error: unknown
): number | null {
  return (
    errorCodeOf(context.tap?.lastExchange(method)?.response ?? null) ??
    (error instanceof ProtocolError ? error.code : null)
  );
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
        let result: SkillsListing;
        try {
          result = await listSkillsDetailed(context.mcp.client, {
            maxPages: options.maxPages,
          });
        } catch (error) {
          return {
            pass: false,
            message: `skills/list failed: ${errorMessage(error)}`,
          };
        }
        context.shared.set(LISTING_KEY, result);
        const count = result.skills.length + result.invalid.length;
        const truncated = result.truncated
          ? ` (stopped after ${options.maxPages ?? 64} page(s); later checks use the entries read so far)`
          : '';
        return {
          pass: true,
          message: `skills/list returned ${count} entr${count === 1 ? 'y' : 'ies'}${truncated}`,
        };
      },
    },
    {
      name: 'skills_entries_valid',
      eras: both,
      severity: 'must',
      specRef: `${SEP}#enumeration-via-skillslist`,
      async run(context) {
        const result = listing(context);
        if (!result) return null;
        if (result.skills.length === 0 && result.invalid.length === 0) {
          return EMPTY;
        }
        const problems = [
          ...result.invalid.map(
            (raw) =>
              `malformed entry ${JSON.stringify(raw).slice(0, 120)}: needs uri, frontmatter, and resources (an array or "dynamic")`
          ),
          ...result.skills.flatMap((entry) =>
            validateSkillEntry(entry)
              .filter((problem) => problem.severity === 'must')
              .map((problem) => problem.message)
          ),
        ];
        return fromProblems(
          problems,
          `All ${result.skills.length} entries are valid`
        );
      },
    },
    {
      name: 'skills_within_limits',
      eras: both,
      severity: 'should',
      specRef: `${SEP}#limits`,
      async run(context) {
        const skills = entries(context);
        if (!skills) return null;
        if (skills.length === 0) return EMPTY;
        const problems = skills.flatMap((entry) =>
          validateSkillEntry(entry)
            .filter((problem) => problem.severity === 'should')
            .map((problem) => `${entry.uri}: ${problem.message}`)
        );
        return fromProblems(
          problems,
          'Every skill is within the 512-file / 16 MiB limits'
        );
      },
    },
    {
      name: 'skills_list_cache_hints',
      eras: ['modern'],
      severity: 'must',
      specRef: `${SEP}#enumeration-via-skillslist`,
      async run(context) {
        if (!listing(context)) return null;
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
      // A differing entry is a warning (the listing is a point-in-time
      // snapshot); a failing or invalid skills/get is a MUST failure.
      severity: 'should',
      specRef: `${SEP}#retrieval-via-skillsget`,
      async run(context) {
        if (!entries(context)) return null;
        const skills = sample(context);
        if (skills.length === 0) return EMPTY;
        const broken: string[] = [];
        const differing: string[] = [];
        for (const entry of skills) {
          try {
            const fetched = await getSkill(context.mcp.client, entry.uri);
            const invalid = validateSkillEntry(fetched).filter(
              (problem) => problem.severity === 'must'
            );
            if (fetched.uri !== entry.uri) {
              broken.push(`${entry.uri}: skills/get returned ${fetched.uri}`);
            } else if (invalid.length > 0) {
              broken.push(
                `${entry.uri}: skills/get entry is invalid (${invalid.map((p) => p.message).join('; ')})`
              );
            } else if (entryShape(fetched) !== entryShape(entry)) {
              differing.push(entry.uri);
            }
          } catch (error) {
            broken.push(
              `${entry.uri}: skills/get failed: ${errorMessage(error)}`
            );
          }
        }
        if (broken.length > 0) {
          return { pass: false, severity: 'must', message: broken.join('; ') };
        }
        return differing.length === 0
          ? {
              pass: true,
              message: `skills/get matches skills/list for ${skills.length} skill(s)`,
            }
          : {
              pass: false,
              message: `skills/get returned a different frontmatter or file set than skills/list for: ${differing.join(', ')}`,
            };
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
              message: `skills/get of an unknown URI failed locally: ${errorMessage(error)}`,
            };
          }
          const code = wireErrorCode(context, 'skills/get', error);
          return code === -32602
            ? { pass: true, message: 'Unknown skill URI returned -32602' }
            : {
                pass: false,
                message: `Unknown skill URI returned ${String(code)}; expected -32602`,
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
        if (!entries(context)) return null;
        const skills = sample(context);
        if (skills.length === 0) return EMPTY;
        const problems: string[] = [];
        let files = 0;
        let dynamic = 0;
        for (const entry of skills) {
          // A "dynamic" skill has no digests, but its SKILL.md frontmatter
          // must still match the entry.
          if (entry.resources === 'dynamic') dynamic += 1;
          const uris =
            options.verifyFiles === 'all' && entry.resources !== 'dynamic'
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
                `${uri}: resources/read failed: ${errorMessage(error)}`
              );
            }
          }
        }
        return fromProblems(
          problems,
          `${files} file(s) match their entries${dynamic > 0 ? ` (${dynamic} dynamic skill(s): frontmatter only)` : ''}`
        );
      },
    },
    {
      name: 'skill_md_resource_metadata',
      eras: both,
      severity: 'should',
      specRef: `${SEP}#resource-metadata`,
      async run(context) {
        const skills = entries(context);
        if (!skills) return null;
        if (skills.length === 0) return EMPTY;
        let resources: Resource[];
        try {
          // Without a cursor the SDK walks every page.
          resources = (await context.mcp.client.listResources()).resources;
        } catch (error) {
          return { skip: `resources/list failed: ${errorMessage(error)}` };
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
        return fromProblems(
          problems,
          `${listed.length} listed SKILL.md resource(s) carry frontmatter metadata`
        );
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
            `resources/directory/read ${root} failed: ${errorMessage(error)}`
          );
        }
        // Both a file and a URI that does not exist must be -32602.
        for (const [label, uri] of [
          ['the file', entry.uri],
          [
            'a missing directory',
            `${root}/mst-missing-${randomUUID().slice(0, 8)}`,
          ],
        ] as const) {
          try {
            await readSkillDirectory(context.mcp.client, uri);
            problems.push(
              `resources/directory/read of ${label} ${uri} did not fail`
            );
          } catch (error) {
            const code = wireErrorCode(
              context,
              'resources/directory/read',
              error
            );
            if (code !== -32602) {
              problems.push(
                `reading ${label} returned ${String(code)}; expected -32602`
              );
            }
          }
        }
        return fromProblems(
          problems,
          `resources/directory/read lists ${root} and rejects files and missing directories`
        );
      },
    },
  ];
}
