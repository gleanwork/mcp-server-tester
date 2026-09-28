import type {
  Client,
  DiscoverResult,
  ReadResourceResult,
  Resource,
  StandardSchemaV1,
} from '@modelcontextprotocol/client';
import {
  getSkill,
  getSkillsExtension,
  listSkills,
  readSkillFile,
  verifySkillFile,
} from '../../skills/skillsClient.js';
import { skillRootUri } from '../../skills/skillEntry.js';
import type {
  SkillEntry,
  SkillsExtensionSettings,
} from '../../skills/skillsTypes.js';

/** A file read through `mcp.skills.read()`. */
export interface MCPSkillFileRead {
  uri: string;
  mimeType?: string;
  /** Present for text contents. */
  text?: string;
  /** The raw bytes (UTF-8 for text contents). */
  bytes: Uint8Array;
  /**
   * true: matches the skill entry (digest, size, and for SKILL.md the
   * frontmatter); false: see `problems`; null: not verified (no entry found,
   * `resources: "dynamic"`, or `verify: false`).
   */
  verified: boolean | null;
  problems: string[];
}

/** Agent Skills over MCP (SEP-2640) helpers on the fixture. */
export interface MCPSkillsApi {
  /** Whether the server declares `io.modelcontextprotocol/skills`. */
  supported(): boolean;
  /** The extension settings the server declared, or null. */
  settings(): SkillsExtensionSettings | null;
  /** All skill entries from `skills/list` (paginated). */
  list(): Promise<SkillEntry[]>;
  /** One skill entry from `skills/get`, listed or not. */
  get(uri: string): Promise<SkillEntry>;
  /**
   * Reads a skill file with `resources/read` and verifies it against its
   * entry. The entry is looked up via `skills/list`, then `skills/get`, unless
   * you pass one.
   */
  read(
    uri: string,
    options?: { entry?: SkillEntry; verify?: boolean }
  ): Promise<MCPSkillFileRead>;
}

/**
 * Protocol surface beyond tools: discovery, resources, arbitrary (extension)
 * methods, and skills. Part of {@link MCPFixtureApi}.
 */
export interface MCPFixtureExtensions {
  /**
   * `server/discover` result on 2026-07-28 connections; null on legacy
   * connections (which have no discover method).
   */
  discover(): Promise<DiscoverResult | null>;
  /** All resources from `resources/list` (paginated). */
  listResources(): Promise<Resource[]>;
  /** Reads a resource with `resources/read`. */
  readResource(uri: string): Promise<ReadResourceResult>;
  /**
   * Sends any request (e.g. an extension method) and validates the result
   * against a schema, such as a Zod schema.
   */
  request<T extends StandardSchemaV1>(
    method: string,
    params: Record<string, unknown> | undefined,
    resultSchema: T
  ): Promise<StandardSchemaV1.InferOutput<T>>;
  /** Agent Skills over MCP. */
  skills: MCPSkillsApi;
}

/** Finds the entry a file belongs to (longest matching skill root). */
async function findEntry(
  client: Client,
  uri: string
): Promise<SkillEntry | null> {
  const entries = await listSkills(client).catch(() => [] as SkillEntry[]);
  const owner = entries
    .filter((entry) => {
      const root = skillRootUri(entry.uri);
      return uri === entry.uri || (root !== null && uri.startsWith(`${root}/`));
    })
    .sort((a, b) => b.uri.length - a.uri.length)[0];
  if (owner) return owner;
  if (uri.endsWith('/SKILL.md')) {
    return getSkill(client, uri).catch(() => null);
  }
  return null;
}

/**
 * Builds the {@link MCPFixtureExtensions} for a client. Exported so custom
 * fixtures (and test doubles) can provide the full {@link MCPFixtureApi}.
 */
export function createFixtureExtensions(client: Client): MCPFixtureExtensions {
  return {
    async discover() {
      return client.getProtocolEra() === 'modern'
        ? await client.request({ method: 'server/discover' })
        : null;
    },
    async listResources() {
      return (await client.listResources()).resources;
    },
    async readResource(uri) {
      return client.readResource({ uri });
    },
    async request(method, params, resultSchema) {
      return client.request(
        { method, ...(params !== undefined ? { params } : {}) },
        resultSchema
      );
    },
    skills: {
      supported() {
        return getSkillsExtension(client) !== null;
      },
      settings() {
        return getSkillsExtension(client);
      },
      async list() {
        return listSkills(client);
      },
      async get(uri) {
        return getSkill(client, uri);
      },
      async read(uri, options = {}) {
        const file = await readSkillFile(client, uri);
        const entry =
          options.verify === false
            ? null
            : (options.entry ?? (await findEntry(client, uri)));
        if (!entry || entry.resources === 'dynamic') {
          return { ...file, verified: null, problems: [] };
        }
        const problems = verifySkillFile(entry, file);
        return { ...file, verified: problems.length === 0, problems };
      },
    },
  };
}
