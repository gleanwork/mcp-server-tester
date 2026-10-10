# The mst client

The `mst` client tests your MCP server through a real LLM (OpenAI, Anthropic, etc.), exactly as a user would interact with Claude Desktop or ChatGPT. The LLM decides which tools to call based only on their descriptions and schemas — making this the highest-fidelity test of tool discoverability, parameter clarity, and description quality.

## When to Use

Use client simulation when you need to verify:

- **Tool discoverability**: Does the LLM know which tool to call for a given task?
- **Parameter clarity**: Does the LLM fill in parameters correctly without hints?
- **Description quality**: Does the tool description accurately represent what the tool does?
- **End-to-end behavior**: Does the full chain of LLM → tools → response work?

For most regression testing, use tool tests (`mcp.callTool()` with the matchers). Reserve client simulation for:

- New tool description development and tuning
- Measuring how reliably the model picks the right tools across inputs
- Pre-release validation of tool schemas

## Supported Providers

All providers use the Vercel AI SDK. Install `ai` plus the provider-specific package:

| Provider           | Env Variable                   | Install                                      |
| ------------------ | ------------------------------ | -------------------------------------------- |
| `anthropic`        | `ANTHROPIC_API_KEY`            | `npm install ai @ai-sdk/anthropic`           |
| `openai`           | `OPENAI_API_KEY`               | `npm install ai @ai-sdk/openai`              |
| `google`           | `GOOGLE_GENERATIVE_AI_API_KEY` | `npm install ai @ai-sdk/google`              |
| `vertex-anthropic` | `GOOGLE_VERTEX_PROJECT`        | `npm install ai @ai-sdk/google-vertex`       |
| `mistral`          | `MISTRAL_API_KEY`              | `npm install ai @ai-sdk/mistral`             |
| `azure`            | `AZURE_API_KEY`                | `npm install ai @ai-sdk/azure`               |
| `deepseek`         | `DEEPSEEK_API_KEY`             | `npm install ai @ai-sdk/deepseek`            |
| `openrouter`       | `OPENROUTER_API_KEY`           | `npm install ai @openrouter/ai-sdk-provider` |
| `xai`              | `XAI_API_KEY`                  | `npm install ai @ai-sdk/xai`                 |

To send `anthropic` or `openai` calls through an LLM gateway, set `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` and a gateway credential (`MST_LLM_AUTH_COMMAND` for either, or a static `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY`). See [LLM Gateways](./llm-gateways.md). The `anthropic` provider streams its responses.

## Basic Usage

```typescript snippet=snippets/mst-client-basic-test.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { runEvalDataset, loadEvalDataset } from '@gleanwork/mcp-server-tester';

test('LLM triggers the right tool', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset(
    { dataset, client: 'mst', model: 'claude-haiku-4-5' },
    { mcp, testInfo }
  );
  expect(result.passed).toBe(result.total);
});
```

**Eval dataset with client simulation:**

```json snippet=snippets/mst-client-tools-triggered.json
{
  "name": "tool-discovery-evals",
  "cases": [
    {
      "id": "search-trigger",
      "input": "Find recent documents about quarterly planning",
      "assertions": {
        "toolsTriggered": {
          "calls": [
            {
              "name": "search",
              "required": true
            }
          ]
        }
      }
    }
  ]
}
```

## Trials and Pass Rate

LLM responses are non-deterministic. Run several trials of each case and measure the pass rate:

```json snippet=snippets/mst-client-trials.json
{
  "id": "search-reliability",
  "input": "Find documents about MCP testing",
  "trials": 5,
  "passThreshold": 0.8,
  "assertions": {
    "toolsTriggered": {
      "calls": [
        {
          "name": "search",
          "required": true
        }
      ]
    }
  }
}
```

The case passes if `search` was triggered in at least 4 of 5 runs (a pass rate of 80%).

## Tool Call Assertions

### `toolsTriggered` — Assert which tools the LLM called

```json
"toolsTriggered": {
  "calls": [
    { "name": "search", "required": true },
    { "name": "get_document", "required": false }
  ],
  "order": "any",
  "exclusive": false
}
```

- `required: true` — this tool MUST have been called
- `order: "strict"` — calls must appear in the listed order
- `exclusive: true` — no other tools may be called

### `toolCallCount` — Assert number of tool calls

```json
"toolCallCount": { "min": 1, "max": 3 }
```

## mst client options

The `mst` client takes its options in `clientOptions`, on the run (`runEvalDataset`), an eval config, or a case:

| Option         | Meaning                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`        | The model (set at the top level, next to `client`). The API is inferred from the id                                                              |
| `provider`     | The API, when the model id doesn't say: `openai`, `anthropic`, `google`, `vertex-anthropic`, `mistral`, `azure`, `deepseek`, `openrouter`, `xai` |
| `maxToolCalls` | Most tool-call steps (default 5)                                                                                                                 |
| `temperature`  | Sampling temperature (0–1)                                                                                                                       |
| `maxTokens`    | Most response tokens                                                                                                                             |
| `timeout`      | Deadline in milliseconds                                                                                                                         |
| `apiKeyEnvVar` | The environment variable that holds the API key, instead of the provider's default                                                               |
| `skills`       | Offer the server's Agent Skills: `'off'` (default), `'catalog'` or `'preload'`                                                                   |
| `systemPrompt` | Added to the model's system prompt (organisation instructions, say)                                                                              |
| `env`          | Environment for the run (never written to `process.env`)                                                                                         |

```typescript
await runEvalDataset(
  {
    dataset,
    client: 'mst',
    model: 'claude-haiku-4-5',
    clientOptions: { maxToolCalls: 8, temperature: 0 },
  },
  { mcp, testInfo }
);
```

**Skills:** with `skills: 'catalog'` the SDK client lists the server's [Agent Skills](./skills.md) in the system prompt and gives the model `read_skill` and `read_resource` tools; `'preload'` puts every `SKILL.md` in the prompt. Skills the model loads (and that pass verification) appear as `kind: 'skill'` entries for `toolsTriggered`, not as tool calls; preloaded skills do not. To measure whether skills help, compare eval variants that differ in the `mst` client's `skills` mode; see [Agent Skills](./skills.md#measuring-whether-skills-help).

**Protocol:** in a Playwright test the `mst` client uses the test's MCP connection, so it follows `mcpConfig.protocol`. Claude Code, Cowork and ChatGPT open their own connections. See [Protocol Versions](./protocol-versions.md).

## Claude Code isolation

Claude Code loads skills, plugins and settings from its config directory (`~/.claude` by default), so a run would otherwise depend on whoever runs it: their skills, plugins and settings shape what the model does and add to its input tokens. The built-in `claude-code` client gives each run an empty `CLAUDE_CONFIG_DIR`, removed afterwards, even when your shell exports one. The MCP servers under test come from the eval config as before.

That also leaves out your `settings.json`: its `env` block (a region, a base URL, a gateway) and `apiKeyHelper` don't apply. Authentication comes from the environment instead: `provider: 'vertex'` (Google Application Default Credentials) or an Anthropic API key. To run with your own configuration, for example to sign in with a claude.ai account, set `isolate: false` on the client; a `CLAUDE_CONFIG_DIR` in the client's or case's `env` is used as given.

Claude Code saves a large tool result to a file in its config directory and leaves a `<persisted-output>` placeholder in the transcript. With the empty config directory MST makes (`mst-claude-*`), MST reads the file back so the trace has the full result, up to 1 MB. With `isolate: false` or your own `CLAUDE_CONFIG_DIR`, it doesn't: the trace keeps the placeholder and its 2 KB preview.

## Claude Code startup and failure evidence

The built-in `claude-code` client uses blocking MCP initialization
(`MCP_CONNECTION_NONBLOCKING=false`). Its connection wait defaults to 30 seconds
(`MCP_CONNECT_TIMEOUT_MS`); an explicit environment value is preserved. The
configured overall client deadline still includes startup and is not extended.

Before accepting a run, MST checks Claude's `system/init` event for every
configured MCP server. Missing, pending, failed, or unauthenticated servers cause
a client infrastructure failure. The actual tool catalog is recorded; a connected
resource-only server may legitimately expose no tools. Tool assertions remain
the responsibility of the eval assertions. MST does not alter the input,
model, tool search, tool exposure, or assertions.

`clientDiagnostics.claudeStartup` records server names/statuses, tool names,
model/version, and startup timing. `clientDiagnostics.failureKind` distinguishes
startup, timeout, process, and output failures. Each `trialResults` entry
retains its own diagnostics, and infrastructure failures keep the framework's
existing separate pass-rate accounting. Credentials, MCP config bodies, and raw
stderr are not included in diagnostics. Existing result redaction still applies
to retained conversation/tool traces.

On timeout or nonzero exit, Claude's partial trace is retained instead of being
replaced by an empty tool-call list. Missing usage remains unknown. On POSIX,
Claude runs in an invocation-owned process group so cancellation also stops its
MCP servers and subprocesses without affecting other runs. Windows retains
direct-child cancellation.

These controls apply to the `claude-code` client, which supplies the server
names from its generated MCP config.

## MstClientSimulationResult

The response for a case on the `mst` client is an `MstClientSimulationResult`:

```typescript
interface MstClientSimulationResult {
  success: boolean;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  response?: string; // Final LLM response text
  error?: string; // Error message if success=false
  llmDurationMs?: number; // Time in LLM calls (excludes tool execution)
  mcpDurationMs?: number; // Time in MCP tool execution
  conversationHistory?: Array<{ role: string; content: string }>;
  skillLoads?: SkillLoad[]; // Skills the client loaded (when skills are enabled)
  events?: TraceEvent[]; // Ordered tool calls and skill loads (when skills are enabled)
}
```

## Cost Considerations

LLM client simulation calls a real LLM API. Approximate costs:

- Anthropic Claude 3.5 Sonnet: ~$0.003–0.01 per test (varies by tool count)
- OpenAI GPT-4o: ~$0.005–0.02 per test

**Recommendation:** Use direct tool calls for regression testing. Use client cases selectively for tool description quality validation.

## Tool optimization

Use `toolOverrides` to compare tool metadata variants without changing your eval dataset or MCP server source. The dataset remains the behavioral contract; the override is runtime-only data passed to `runEvalDataset`.

```typescript
import { compareEvalRuns } from '@gleanwork/mcp-server-tester/evals';

const variant = {
  id: 'search-description-v2',
  description: 'Clarify that search is for internal docs and policies.',
  tools: {
    search: {
      description:
        'Search internal company documents, policies, wiki pages, and announcements. Use this when the user asks to find company information by topic.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language document or policy query.',
          },
        },
        required: ['query'],
      },
    },
  },
};

const baseline = await runEvalDataset(
  { dataset, defaultTrials: 10 },
  { mcp, testInfo }
);

const candidate = await runEvalDataset(
  {
    dataset,
    defaultTrials: 10,
    toolOverrides: variant,
  },
  { mcp, testInfo }
);

const comparison = compareEvalRuns({
  baseline,
  candidate,
  labels: {
    baseline: 'baseline',
    candidate: variant.id,
  },
});

console.log(`Pass-rate delta: ${comparison.deltaPassRate}`);
console.log(`Tool F1 delta: ${comparison.deltaToolF1 ?? 'n/a'}`);
console.log(`Improved cases: ${comparison.improvedCases.length}`);
```

`toolOverrides.tools` (in an eval config, a variant's `tools`) is keyed by a tool's name on its server; with several servers, `server.tool` picks one (a qualified key wins over a bare one). An override can replace a tool's `name`, `description` and `inputSchema`. A key that matches no tool or several is an error, and so is a rename that isn't a valid tool name or takes a name another tool on the same server has.

A renamed tool's calls reach the original tool and are recorded under its original name, so a dataset's assertions read the same in every variant; the trace's `rawName` keeps the name the model used:

```json
{
  "id": "renamed",
  "tools": { "find_skills": { "name": "find_more_skills_and_tools" } }
}
```

In an eval, a variant's tool metadata (`tools`) reach every client, including plugin clients and `claude-code`, through a local MCP proxy; see [Tool metadata on every client](./evaluation-framework.md#tool-metadata-on-every-client). Mocked responses and dataset rewriting are out of scope.

For a complete runnable harness — including building a structured next-variant proposal from the comparison — see [`snippets/tool-optimization-loop.ts`](../snippets/tool-optimization-loop.ts).

### Driving it from an agent: `runToolOptimization`

The manual loop above — run baseline, inject a variant, `compareEvalRuns`, build a proposal — is the low-level path. `runToolOptimization` wraps that whole loop into a single call so an AI or skill can optimize tool metadata autonomously:

- Pass a static `variants` list for an A/B comparison, **or** a `proposeVariants` callback that returns the next candidate(s) from the previous round's evidence (`history`, `bestSoFar`).
- Candidates are ranked by `metric` (`passRate` by default, or `toolF1` / `toolPrecision` / `toolRecall`) and always compared against the original baseline, so the resulting proposal is directly applicable.
- A variant that breaks cases that work today is disqualified (unless `allowRegressions: true`), so the loop never crowns a description that fixes one case while breaking another. A single flaky trial doesn't count as breaking a case, and a variant must be clearly better to be recommended (see [How variants are judged](#how-variants-are-judged)).
- The result carries a structured `proposal` with an `apply` / `reject` / `inconclusive` recommendation, the per-tool `toolChanges`, and the improved/regressed case ids.

The library owns the optimization mechanics; your `proposeVariants` callback owns the judgment of which variant to try next. `runToolOptimization` never edits your MCP server source or dataset — it returns a proposal for you (or an agent) to act on.

To run the optimization on a real client instead of the SDK client, give it an eval config: `runToolOptimization({ evalConfig: { configPath }, variants })`. See the [API reference](./api-reference.md#runtooloptimizationoptions-context--runtooloptimizationevaloptions).

```typescript snippet=snippets/tool-optimization.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  type ToolOverrideVariant,
} from '@gleanwork/mcp-server-tester';
import { runToolOptimization } from '@gleanwork/mcp-server-tester/evals';

// Static A/B: try a fixed set of tool-description variants and keep the winner.
test('optimize search description (static variants)', async ({
  mcp,
}, testInfo) => {
  const dataset = await loadEvalDataset('./data/client-evals.json');

  const variants: ToolOverrideVariant[] = [
    {
      id: 'search-v2-internal-docs',
      description: 'Clarify that search is for internal knowledge.',
      tools: {
        search: {
          description:
            'Search internal company documents, policies, wiki pages, and announcements. Use this when the user asks to find company information by topic.',
        },
      },
    },
    {
      id: 'search-v3-with-examples',
      description: 'Add example triggers to the search description.',
      tools: {
        search: {
          description:
            'Find internal company knowledge — docs, policies, wikis, announcements. Examples: "find the Q3 planning doc", "what is our PTO policy".',
        },
      },
    },
  ];

  const result = await runToolOptimization(
    { dataset, variants, metric: 'passRate', defaultTrials: 10 },
    { mcp, testInfo }
  );

  if (result.proposal?.recommendation === 'apply') {
    const pct = (result.proposal.delta * 100).toFixed(1);
    console.log(
      `Apply ${result.winner?.variant.id}: +${pct}% ${result.metric}`
    );
    console.log(
      `Improved cases: ${result.proposal.improvedCaseIds.join(', ')}`
    );
  }

  // The default guard never crowns a variant that clearly broke a
  // regression case (tag those cases "regression").
  expect(result.winner?.measurement.brokenCaseIds ?? []).toHaveLength(0);
});

// Agent loop: propose the next variant from the previous round's evidence.
test('optimize search description (agent loop)', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/client-evals.json');

  const result = await runToolOptimization(
    {
      dataset,
      metric: 'passRate',
      maxRounds: 4,
      minImprovement: 0.05,
      defaultTrials: 10,
      async proposeVariants({ round, history, bestSoFar }) {
        // An agent inspects bestSoFar / history to decide the next rewrite.
        // Stop early once the best candidate has no remaining failures.
        const stillFailing =
          history.at(-1)?.best?.comparison.unchangedFailures.map((c) => c.id) ??
          [];
        if (round > 0 && stillFailing.length === 0) {
          return [];
        }

        return [
          {
            id: `search-round-${round}`,
            description: `Round ${round} refinement of ${
              bestSoFar?.variant.id ?? 'baseline'
            }.`,
            tools: {
              search: {
                description:
                  'Use search ONLY to find internal company knowledge (docs, policies, wikis, announcements). Convert the request into a concise topic query.',
              },
            },
          },
        ];
      },
    },
    { mcp, testInfo }
  );

  console.log(
    `Stopped after ${result.rounds.length} round(s): ${result.reason}`
  );
  console.log(JSON.stringify(result.proposal, null, 2));
});
```

| Option             | Default         | Purpose                                                                                         |
| ------------------ | --------------- | ----------------------------------------------------------------------------------------------- |
| `variants`         | —               | Static candidates tried in round 0.                                                             |
| `proposeVariants`  | —               | Async callback returning the next candidates — the AI hook.                                     |
| `metric`           | `'passRate'`    | Ranking metric: `passRate` / `toolF1` / `toolPrecision` / `toolRecall`, without held-out cases. |
| `maxRounds`        | `1`             | Maximum optimization rounds.                                                                    |
| `minImprovement`   | `0`             | Stop when a round's best gain falls below this.                                                 |
| `allowRegressions` | `false`         | Allow a winner that breaks cases.                                                               |
| `regressionCheck`  | `'significant'` | How breakage is judged: `'significant'` or `'any-case'` (see below).                            |
| `regressionTag`    | `'regression'`  | Tag that marks regression cases (see below).                                                    |
| `heldOutTag`       | `'held-out'`    | Tag that marks cases left out of ranking and hidden from `proposeVariants`.                     |

`passRate` is the mean per-case share of trials that passed (pass@1, each case weighted equally). With one trial per case it's the share of cases that passed.

#### How variants are judged

A recommendation should mean the evidence supports it, so `runToolOptimization` follows standard practice for comparing two systems on the same test cases. Every number the report shows comes from these steps.

**Groups.** Cases tagged `regression` are regression cases; every other case is a capability case. This is the split between regression and capability evals in Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). If no case has the tag, the baseline runs once more, only to sort cases: those that pass every trial of that run must keep working. Groups never come from the baseline run the variants are compared with. A flaky case that happened to pass that run tends to do worse on any re-run, and one that happened to fail tends to do better, so grouping by it makes unchanged variants look broken or fixed (regression to the mean). Tag your regression cases to choose the groups yourself and skip the extra run.

**Clearly better.** Each case scores the share of its trials that passed, and each variant is compared with the baseline case by case, as recommended in Miller's [Adding Error Bars to Evals](https://arxiv.org/abs/2411.00640). The verdict comes from an exact paired sign-flip test, which stays valid with few cases; with one trial per case it's McNemar's exact test. A variant is clearly better on should-now-work cases when that test gives p below 0.025 / N, where N is the number of variants tried across all rounds (a Bonferroni correction, so trying many variants can't promote a lucky one). With a tool metric, the same test runs on per-case precision, recall or F1.

**Breakage.** With `regressionCheck: 'significant'` (the default), a variant is disqualified when the regression cases got worse as a group (p below 0.025), or any one of them did on its own. The single-case check uses Fisher's exact test on that case's trials, Holm-corrected so the chance of wrongly calling any case broken stays below 5%. One flaky trial is not breakage. `'any-case'` disqualifies a variant when any case that passed the baseline fails with it, however small the drop, so with flaky cases it rejects good variants for noise.

**Held-out cases.** Cases tagged `held-out` don't count toward ranking, and `proposeVariants` never sees them: every run in its context has them removed. They still count toward the checks above, and the report also tests the change on them alone, a check the selection couldn't have tuned to.

**What these checks can't tell you:**

- "No clear breakage" means the tests found none, not that none happened. With 5 trials per case, one case breaking outright can be caught on its own only when there are at most 12 regression cases; the report says when your run is too small. Breakage spread across cases is caught by the group test.
- With one trial per case, only large changes show up as clear. In simulation, a variant that fixed most failing cases was recommended 30% of the time with 1 trial per case, 87% with 5 and 97% with 10. Use `defaultLlmIterations` or per-case `trials` of 5 or more.
- Cases are treated as independent. Near-duplicate prompts count as separate evidence and make results look surer than they are. Miller recommends clustered standard errors for grouped questions; they aren't supported yet.

Seeded simulations in `src/evals/variantComparison.test.ts` pin these error rates. A variant identical to the baseline is called clearly better less than 5% of the time and broken less than 7.5% of the time, while a real improvement is still found more than 75% of the time.

Each candidate's `measurement` holds the per-group pass rates, each `change` with its interval, p-values and `assessment`, and `brokenCaseIds`. `improvement` is the change behind the "clearly better" call, and `fixes` is that call.

With `testInfo`, the optimization also attaches a case-by-case comparison of every variant, and the MCP reporter's [run report](./ui-reporter.md#what-it-shows) opens on it: the recommendation, each variant against the baseline, what changed, every case and trial, and why trials failed.

## Project-Based A/B Testing

Run two Playwright projects with different MCP server configurations when the variant is not limited to runtime metadata. This is useful for comparing different server builds, tool behavior, auth scopes, response shapes, transports, or any change that should be exercised through a real MCP server process.

```typescript
// playwright.config.ts
projects: [
  {
    name: 'baseline',
    use: {
      mcpConfig: {
        transport: 'stdio',
        command: 'node',
        args: ['./dist/server-v1.js'],
      },
    },
  },
  {
    name: 'server-v2',
    use: {
      mcpConfig: {
        transport: 'stdio',
        command: 'node',
        args: ['./dist/server-v2.js'],
      },
    },
  },
];
```

The MCP reporter groups results by project, letting you compare pass rates side-by-side. Prefer `toolOverrides` for description and input schema optimizations; use project-based A/B testing when the real server surface or implementation changes.
