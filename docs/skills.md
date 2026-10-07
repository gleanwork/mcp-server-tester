# Agent Skills over MCP

Servers can ship [Agent Skills](https://agentskills.io/specification) alongside their tools using the MCP skills extension ([SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension), `io.modelcontextprotocol/skills`). A skill is a directory with a `SKILL.md` (YAML frontmatter plus instructions) and optional supporting files, served as MCP resources (usually under `skill://`, though the SEP allows any scheme). The server lists skills with `skills/list` and returns one with `skills/get`; every entry carries SHA-256 digests and sizes for its files.

MST can:

- read and verify skills from tests (`mcp.skills`)
- check that a server follows SEP-2640 (`runConformanceChecks`)
- assert on skills methods in eval datasets (`request` cases)
- run evals where the model can load skills, and measure whether skills help (the `mst` client's `skills` option, or eval variants that set it)

The extension works in both protocol eras: servers declare it in `capabilities.extensions`, which MST reads from `initialize` (legacy) or `server/discover` (2026-07-28).

## Table of Contents

- [Reading skills in tests](#reading-skills-in-tests)
- [Conformance](#conformance)
- [Checking skills methods in a test](#checking-skills-methods-in-a-test)
- [Skills in evals](#skills-in-evals)
- [Measuring whether skills help](#measuring-whether-skills-help)

## Reading skills in tests

```typescript
test('serves a valid weather skill', async ({ mcp }) => {
  expect(mcp.skills.supported()).toBe(true);

  const [entry] = await mcp.skills.list(); // paginates skills/list
  expect(entry?.frontmatter.name).toBe('weather-report');

  const skill = await mcp.skills.read(entry!.uri);
  expect(skill.verified).toBe(true); // digest, size, and frontmatter match
  expect(skill.text).toContain('get_weather');

  const style = await mcp.skills.read(
    'skill://weather-report/references/STYLE.md'
  );
  expect(style.verified).toBe(true);
});
```

| Method                        | Does                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp.skills.supported()`      | Whether the server declares the extension                                                                                                                                              |
| `mcp.skills.settings()`       | The declared settings, e.g. `{ directoryRead: true }`                                                                                                                                  |
| `mcp.skills.list()`           | All entries from `skills/list`                                                                                                                                                         |
| `mcp.skills.get(uri)`         | One entry from `skills/get`, listed or not                                                                                                                                             |
| `mcp.skills.read(uri, opts?)` | Reads a file and verifies it against its entry. `verified` is `true`, `false` (see `problems`), or `null` for `"dynamic"` skills. Pass `{ entry }` to verify against a specific entry. |

For other extension methods, use `mcp.request(method, params, schema)`, which validates the result against any Standard Schema such as a Zod schema. `mcp.listResources()` and `mcp.readResource(uri)` cover the resources the skills are built on.

## Conformance

When the server declares the extension, `runConformanceChecks(mcp)` adds:

| Check                                 | Level  | Rule                                                                                                                                                                                                                |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills_extension_declares_resources` | MUST   | The server also declares the `resources` capability                                                                                                                                                                 |
| `skills_list_succeeds`                | MUST   | `skills/list` works                                                                                                                                                                                                 |
| `skills_entries_valid`                | MUST   | Each entry has a valid `name` and `description` (see below), a `…/<name>/SKILL.md` URI, and a complete `resources` list (including `SKILL.md`, all files inside the skill, `sha256:` digests, sizes) or `"dynamic"` |
| `skills_within_limits`                | SHOULD | At most 512 files and 16 MiB per skill                                                                                                                                                                              |
| `skills_list_cache_hints`             | MUST   | 2026-07-28 only: `skills/list` carries `ttlMs` and `cacheScope`                                                                                                                                                     |
| `skills_get_matches_list`             | SHOULD | `skills/get` returns the same entry `skills/list` did (a failing or invalid `skills/get`, or one for another URI, is a MUST failure)                                                                                |
| `skills_get_unknown_uri`              | MUST   | An unknown skill URI is `-32602`                                                                                                                                                                                    |
| `skills_content_verified`             | MUST   | Each `SKILL.md` matches its digest and size, and its frontmatter matches the entry's                                                                                                                                |
| `skill_md_resource_metadata`          | SHOULD | A listed `SKILL.md` resource has `text/markdown` and the frontmatter name and description                                                                                                                           |
| `skills_directory_read`               | MUST   | With `directoryRead: true`, `resources/directory/read` lists a skill (every page) and rejects files and missing URIs with `-32602`                                                                                  |

Skill names follow the [Agent Skills rules](https://agentskills.io/specification): 1–64 lowercase letters, digits, and hyphens, not starting or ending with a hyphen and without `--`. Descriptions are required and at most 1024 characters.

Options:

```typescript
await runConformanceChecks(mcp, {
  // defaults: SKILL.md only, 25 skills, 64 pages of skills/list
  skills: { verifyFiles: 'all', maxSkills: 50, maxPages: 10 },
});
await runConformanceChecks(mcp, { skills: false }); // turn the skills checks off
```

`runCrossEraChecks()` also checks that skill entries are identical in every era.

## Checking skills methods in a test

`mcp.skills` covers the skills methods, and `mcp.request()` sends one raw, for asserting on its result or its JSON-RPC error:

```typescript
import { z } from 'zod';
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { validateSkillEntry } from '@gleanwork/mcp-server-tester';

test('skills are valid SEP-2640 entries', async ({ mcp }) => {
  const skills = await mcp.skills.list();
  expect(skills.map((entry) => entry.frontmatter.name)).toContain(
    'weather-report'
  );
  for (const entry of skills)
    expect(
      validateSkillEntry(entry).filter((p) => p.severity === 'must')
    ).toEqual([]);
});

test('an unknown skill is an invalid-params error', async ({ mcp }) => {
  await expect(
    mcp.request(
      'skills/get',
      { uri: 'skill://nope/SKILL.md' },
      z.looseObject({})
    )
  ).rejects.toMatchObject({ code: -32602 });
});
```

## Skills in evals

Set the `mst` client's `skills` option (`clientOptions.skills`) to let it offer the server's skills to the model:

| `skills`          | What the model gets                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'off'` (default) | No skills, the same as before                                                                                                                                          |
| `'catalog'`       | A system-prompt list of each skill's name, description, server, and URI, plus `read_skill(server, uri)` to load a skill and `read_resource(server, uri)` for its files |
| `'preload'`       | Every `SKILL.md` placed in the system prompt, plus `read_resource`                                                                                                     |

`catalog` follows the client guidelines in SEP-2640:

- Nothing is fetched until the model asks, and skill content is marked as untrusted server input.
- Reads go to the skill's own server. A file under a listed skill is checked against that skill's entry, whether or not the skill is loaded; files of a `"dynamic"` skill are accepted. URIs outside any skill are read as plain resources.
- `read_skill` accepts a skill URI that is not in the catalog (for example one named in another skill) and confirms it with `skills/get`.
- Relative paths resolve against the most recently loaded skill's directory.
- A file that fails verification is returned to the model as an error instead of its content.

Loading a skill is not an MCP tool call. Loads are reported in `skillLoads`, and each `SKILL.md` the model loads (and that passes verification) becomes a `skill` event in order with tool calls, so `toolsTriggered` can assert it. Preloaded skills are in context without the model choosing them, so they produce no events: a `kind: 'skill'` assertion cannot pass in `'preload'` mode. The same assertion works for external clients that report skill use, such as Claude Code:

```json
{
  "id": "weather-uses-skill",
  "input": "Write me a short weather report for London",
  "client": "mst",
  "model": "claude-haiku-4-5",
  "clientOptions": { "skills": "catalog" },
  "trials": 5,
  "passThreshold": 0.8,
  "assertions": {
    "toolsTriggered": {
      "calls": [
        { "name": "weather-report", "kind": "skill" },
        { "name": "get_weather" }
      ],
      "order": "strict"
    }
  }
}
```

`toolCallCount` and tool precision/recall still count only MCP tool calls.

Metrics: `skill_loaded`, `skill_before_tool`, and `skill_verification_failed`. Each case's value is the fraction of its trials where it held, and `<metric>_rate` averages those over cases where skills were enabled. Loads that fail verification are not counted as loads, and attempts where every load was a preload are left out of `skill_loaded` and `skill_before_tool`.

## Measuring whether skills help

Models often skip skills they could use, and a matching tool can win over the skill written for it. To measure it, run the same dataset as eval variants that differ only in the `mst` client's `skills` mode:

```json
{
  "name": "skills-help",
  "datasets": ["./evals/weather.json"],
  "servers": {
    "server-1": {
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"]
    }
  },
  "client": "mst",
  "clientOptions": {
    "provider": "anthropic"
  },
  "metrics": ["skill_loaded", "skill_before_tool", "skill_verification_failed"],
  "variants": [
    {
      "name": "off"
    },
    {
      "name": "catalog",
      "clientOptions": {
        "skills": "catalog"
      }
    },
    {
      "name": "preload",
      "clientOptions": {
        "skills": "preload"
      }
    }
  ]
}
```

`mst run` reports each variant's pass and trial pass rates and the skill metrics, and `variantDeltas` compares each mode with `off`. Leave `clientOptions.skills` off the cases: a case's own setting replaces the variant's, so every variant would run the case's mode. Skills come from the first of a variant's servers. Use `trials` for stable rates, and try more than one model: skill adherence varies a lot between models.
