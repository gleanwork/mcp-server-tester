---
name: write-mcp-eval
description: Write evals for MCP servers with @gleanwork/mcp-server-tester (MST). An eval gives a client and model the cases of a dataset (an input, what is expected, and assertions) and grades each trial's trace. Run the cases in a Playwright test with runEvalDataset on the mst client, or with `mst run` and an eval config that compares variants (servers, client, model, system prompt, tool metadata). Use when asked to write evals, eval datasets or eval configs, to test whether a model picks the right tools, or to compare MCP server setups.
metadata:
  author: gleanwork
  version: '2.0.0'
---

# Write MCP evals

An eval has a client act on cases and grades what it did. Each case gives the client an `input` (the user's request). The client runs it with a model and returns a trace: the tools it called and its final answer. Assertions and judges grade each trial, and MST decides whether the case passed.

A check that calls a tool with fixed arguments has no client, so it is a test, not an eval. Write those with the `write-mcp-test` skill. Datasets hold only cases for a client.

## Before you start

1. Decide what the eval measures: which tool the model picks, the arguments it passes, the quality of its answer, or cost and latency.
2. Read the server's tools: names, descriptions and input schemas (`await mcp.listTools()` in a test, or the server source). Every tool name in an assertion must exist.
3. Choose where the cases run:

|          | Playwright test with `runEvalDataset`    | `mst run` with an eval config                                   |
| -------- | ---------------------------------------- | --------------------------------------------------------------- |
| Client   | `mst` only, on the test's MCP connection | `mst`, `claude-code`, `cowork`, `chatgpt`, or a plugin's client |
| Compares | one setup per call                       | several variants in one run, each compared with the baseline    |
| Results  | the MCP Playwright reporter              | `results.json` and a table per variant                          |

Start with a Playwright test on `mst` while you write cases. Use an eval config to run them on another client or to compare variants.

## Step 1: Write the dataset

A dataset is a JSON file with a `name` and a list of `cases`:

```json
{
  "name": "search-evals",
  "cases": [
    {
      "id": "find-planning-doc",
      "input": "Find the Q3 planning document",
      "assertions": {
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }]
        }
      }
    }
  ]
}
```

Case fields:

| Field                              | Required | Meaning                                                                                 |
| ---------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `id`                               | yes      | Unique within the dataset                                                               |
| `input`                            | yes      | The user's request, sent to the client as its prompt                                    |
| `description`                      | no       | What the case is for                                                                    |
| `expected`                         | no       | Ground truth for graders: `answer`, `criteria` (rubric criteria by name), any other key |
| `assertions`                       | no       | Code graders: `toolsTriggered`, `toolCallCount`, `containsText`, `matchesPattern`       |
| `judges`                           | no       | LLM graders: the built-in `rubric` judge or a plugin's judges, beside `assertions`      |
| `tags`                             | no       | Labels for filtering (`filterTags`) and grouping (`regression`, `held-out`)             |
| `trials`                           | no       | Trials of this case (default 1)                                                         |
| `passThreshold`                    | no       | Share of trials that must pass, 0 to 1 (default 1)                                      |
| `judgeReps`                        | no       | Times each judge scores a trial; the mean is compared with its threshold                |
| `client`, `model`, `clientOptions` | no       | This case's own client, model or client options, over what it inherits                  |
| `metadata`                         | no       | Free-form data kept with the case                                                       |

A key MST doesn't define fails validation, so a misspelt assertion never silently skips. Keys from 1.x fail with a message that names the replacement:

| 1.x                                                         | 2.0                                    |
| ----------------------------------------------------------- | -------------------------------------- |
| `scenario`                                                  | `input`                                |
| `expect`                                                    | `assertions`                           |
| `iterations`                                                | `trials`                               |
| `accuracyThreshold`                                         | `passThreshold`                        |
| `canonicalAnswer`                                           | `expected.answer`                      |
| `mode`                                                      | remove it: every case runs on a client |
| `mcpHostConfig`                                             | `client`, `model`, `clientOptions`     |
| `toolName` + `args`, `request`                              | a Playwright test (`write-mcp-test`)   |
| `response`, `schema`, `snapshot`, `isError`, `responseSize` | matchers in a Playwright test          |

## Step 2: Write good inputs

One phrasing tells you that phrasing works, not that the tool description works.

- **Write the inputs before reading the tool descriptions.** Otherwise you copy their vocabulary and the model gets an easy match a real user wouldn't give it.
- **Write two or three phrasings per tool.** Vary vocabulary, directness and the user's goal: "Who leads the platform team?", "Find the VP of engineering", "Who should I ask about API access?".
- **Ask for the intent, not the tool.** "Find recent docs about the launch" should trigger `search` without saying "search".
- **Test selectivity.** For tools that overlap, write inputs that should trigger one and not the other, and use `exclusive: true`.
- **Add negative cases.** An input that needs no tool should make no call: `"toolCallCount": { "exact": 0 }`.
- **Decide ambiguous cases.** If an input could go two ways, choose the right behaviour and assert it.

## Step 3: Add assertions and judges

Every assertion in a case's `assertions` must pass for a trial to pass.

| Assertion        | Passes when                                                          |
| ---------------- | -------------------------------------------------------------------- |
| `toolsTriggered` | The client called the listed tools (optionally in order, only those) |
| `toolCallCount`  | The number of tool calls is within `min`/`max`, or equals `exact`    |
| `containsText`   | The final answer contains every listed substring                     |
| `matchesPattern` | The final answer matches every listed regular expression             |

### `toolsTriggered`

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

- `required` defaults to `true`. A call with `required: false` may happen; with `exclusive: true` it is also allowed.
- `order: "strict"` requires the listed calls in that order (an optional call may be missing). The default is `"any"`.
- `exclusive: true` fails the trial if the client calls any tool not in `calls`.
- `arguments` matches part of the call's arguments: listed keys must match, extra keys are allowed. A value can be a regular expression:

  ```json
  {
    "name": "search",
    "arguments": {
      "query": { "$pattern": "onboarding.*engineer", "$flags": "i" },
      "limit": 10
    }
  }
  ```

- With several servers, name the server: `"server": "docs"`, or `"name": "docs.search"` (the server's label, a dot, the tool).
- `kind` (`tool_call`, `skill`, `command`, `subagent`, `tool_search`) and `source` (`mcp` or `builtin`) match other events in the trace, such as a skill the client loaded.

Tool assertions need a client whose trace is `structured` evidence. All built-in clients are. A plugin client that doesn't declare `structured` evidence can only pass text and judge assertions.

### `containsText` and `matchesPattern`

They check the client's final answer, not a tool's output:

```json
"containsText": ["Q3", "planning"],
"matchesPattern": ["\\d+ results"]
```

Escape backslashes in JSON (`\\d`).

### Judges

A judge is an LLM that scores the trial from 0 to 1. A case lists its judges in `judges`, beside `assertions`. Use the built-in `rubric` judge with a built-in rubric (`correctness`, `completeness`, `groundedness`, `instruction-following`, `conciseness`) or your own text:

```json
{
  "id": "pto-policy",
  "input": "How many days of PTO do new employees get?",
  "expected": { "answer": "New employees get 20 days of PTO a year." },
  "judges": [
    { "type": "rubric", "rubric": "correctness", "threshold": 0.75 },
    {
      "type": "rubric",
      "rubric": {
        "text": "Score 1 if the answer cites the policy document, 0.5 if it gives the number without a source, 0 otherwise."
      }
    }
  ]
}
```

- A judge passes when its mean score reaches its `threshold` (default 0.7), and every listed judge must pass.
- `expected.answer` is what the judge compares the answer with, unless the judge sets `reference`.
- An eval config's `judges` apply to every case, on top of the case's own.
- The rubric judge's LLM settings sit next to it: `provider` (`anthropic` by default, `vertex-anthropic`, `anthropic-agent-sdk`, `openai`, `google`), `model`, `temperature`, `maxTokens`. The default `anthropic` judge needs `@anthropic-ai/sdk` and `ANTHROPIC_API_KEY`.
- A plugin's judge is named `<namespace>/judge/<name>`: `"acme/judge/completeness"`, or `{ "type": "acme/judge/completeness", "threshold": 0.8 }` with options. Load the plugin where the cases run (Step 5).

Judges cost a model call per trial (times `reps`). Prefer `toolsTriggered` when the question is which tool was called.

## Step 4: Set trials and a pass threshold

Models are non-deterministic. One trial can't tell a good tool description from a lucky one.

```json
{
  "id": "search-reliability",
  "input": "Find documents about MCP testing",
  "trials": 10,
  "passThreshold": 0.8,
  "assertions": {
    "toolsTriggered": { "calls": [{ "name": "search" }] }
  }
}
```

This case passes when at least 8 of its 10 trials pass. Its result has `passRate` (the share of trials that passed, with `passRateCI`) and `trialResults`. Trials that failed on infrastructure (a network error, a client that didn't start) aren't counted.

- Use 10 trials while developing and 20 or more before a decision. With 3, a tool that works 40% of the time can't be told apart from one that works 90% of the time.
- Set trials for every case with `defaultTrials` (Playwright) or `trials` (eval config) rather than on each case.
- Keep `passThreshold: 1` for critical tools. Use 0.8 to 0.9 for most cases, so normal variation doesn't fail the run.

## Step 5a: Run the cases in a Playwright test

The `mst` client gives the model the server's tools and nothing else. In a Playwright test it uses the test's MCP connection (`mcpConfig` in `playwright.config.ts`; see `write-mcp-test`).

```bash
npm install --save-dev ai @ai-sdk/anthropic   # usually installed already, as optional dependencies
export ANTHROPIC_API_KEY=...
```

```typescript
// tests/search-evals.spec.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test('search evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./evals/search-evals.json');
  const result = await runEvalDataset(
    {
      dataset,
      client: 'mst',
      model: 'claude-haiku-4-5',
      clientOptions: { maxToolCalls: 8, temperature: 0 },
      defaultTrials: 10,
    },
    { mcp, testInfo }
  );
  expect(result.failed).toBe(0);
});
```

`runEvalDataset(options, context)` takes two objects: what to run, then the Playwright context. Pass `testInfo` so the reporter shows the results.

| Option                                  | Meaning                                                             |
| --------------------------------------- | ------------------------------------------------------------------- |
| `dataset`                               | From `loadEvalDataset(path)` or `loadEvalDatasetFromObject(object)` |
| `client`, `model`, `clientOptions`      | The client (only `mst` here), its model, and its options            |
| `defaultTrials`, `defaultPassThreshold` | For cases that don't set `trials` or `passThreshold`                |
| `defaultJudgeReps`                      | For cases that don't set `judgeReps`                                |
| `filterTags`                            | Run only cases with one of these tags                               |
| `concurrency`                           | Cases run at once (mind the provider's rate limits)                 |
| `plugins`                               | Plugin objects whose judges the cases name                          |
| `saveResultsTo`, `baselineResultsFrom`  | Save this run, or compare with a saved earlier run                  |

The `mst` client infers the API from the model id (`claude-*` is Anthropic, `claude-*@date` Vertex, `gpt-*` OpenAI, `gemini-*` Google). Its `clientOptions`: `provider` (to override that), `maxToolCalls` (default 5), `temperature`, `maxTokens`, `timeout` (ms), `apiKeyEnvVar`, `systemPrompt`, and `skills` (`off`, `catalog`, `preload`, for servers that serve Agent Skills).

The result has `total`, `passed`, `failed`, and `caseResults`. Each case result has `pass`, `scores` (one per grader), `toolCallTrace` (calls marked `expected` or `unexpected`, and `missed` tools), `toolPrecision` and `toolRecall`, and for several trials `passRate` and `trialResults`.

To see whether a change broke cases that passed before, save one run and compare the next with it:

```typescript
const result = await runEvalDataset(
  {
    dataset,
    client: 'mst',
    model: 'claude-haiku-4-5',
    defaultTrials: 10,
    baselineResultsFrom: '.mcp-test-results/search-baseline.json',
  },
  { mcp, testInfo }
);
expect(result.regressions ?? 0).toBe(0);
```

Write the file first with `saveResultsTo: '.mcp-test-results/search-baseline.json'` on a known-good run.

## Step 5b: Run the cases with `mst run`

An eval config is a JSON file that names the datasets, the servers, the client and model, and the graders. `mst run` runs it on any client.

```json
{
  "name": "search-evals",
  "datasets": ["./search-evals.json"],
  "servers": {
    "docs": {
      "transport": "stdio",
      "command": "node",
      "args": ["./dist/server.js"]
    }
  },
  "client": "claude-code",
  "model": "claude-sonnet-4-6",
  "trials": 10,
  "passThreshold": 0.8,
  "metrics": ["passed", "tool_count", "input_tokens", "duration_s"]
}
```

- `servers` is a map: the key is the server's label in traces and the report.
- Without `client`, an eval config runs on `claude-code`. Name the client every time.
- Dataset paths are relative to the eval config's directory.
- Credentials don't go in the file. Use `auth.accessTokenEnv` on an HTTP server and pass values with `--secrets-file` or the environment.

```bash
npx mst run --config evals/eval.json --dry-run     # validate config, plugins and datasets
npx mst run --config evals/eval.json --case find-planning-doc --trials 1
npx mst run --config evals/eval.json
```

`mst run` prints a row per variant (cases passed, trial pass rate, MCP calls, tokens, cost, time) and the change since the previous run of the same eval config. It writes `results.json` under `.mcp-test-results/<name>/` and exits 1 if any case failed.

Every key, the clients, and what variants inherit: [references/eval-configs.md](references/eval-configs.md).

## Step 6: Compare variants

A variant is one setup the eval tests. Every variant runs the same cases, and each is compared with the baseline, the first variant unless `baseline` names another.

```json
{
  "name": "search-servers",
  "datasets": ["./search-evals.json"],
  "servers": {
    "prod": { "transport": "http", "serverUrl": "https://mcp.example.com/mcp" },
    "next": {
      "transport": "http",
      "serverUrl": "https://staging.example.com/mcp"
    }
  },
  "client": "mst",
  "model": "claude-sonnet-4-6",
  "trials": 10,
  "variants": [
    { "name": "prod", "servers": ["prod"] },
    { "name": "next", "servers": ["next"] },
    {
      "name": "next-with-prompt",
      "servers": ["next"],
      "clientOptions": {
        "systemPrompt": "Search internal documents before answering."
      }
    }
  ]
}
```

A variant can change its servers (by label), `client`, `model`, `clientOptions`, `tools` (tool metadata), `toolMap`, `inputTemplate`, `metrics` or `judges`. A variant that lists no servers uses all of them. To try tool descriptions without changing the server, give a variant `tools`; the `optimize-mcp-tool-metadata` skill covers that.

Change one thing per variant, so a difference has one cause.

## Complete example

`evals/search-evals.json`:

```json
{
  "name": "search-evals",
  "description": "Does the model use search and get_document for document questions?",
  "cases": [
    {
      "id": "find-planning-doc",
      "input": "Find the Q3 planning document",
      "tags": ["regression"],
      "assertions": {
        "toolsTriggered": { "calls": [{ "name": "search" }] }
      }
    },
    {
      "id": "find-planning-doc-indirect",
      "input": "What did we decide about hiring in the Q3 plan?",
      "assertions": {
        "toolsTriggered": { "calls": [{ "name": "search" }] },
        "toolCallCount": { "min": 1, "max": 4 }
      }
    },
    {
      "id": "search-arguments",
      "input": "Look for onboarding guides for new engineers",
      "assertions": {
        "toolsTriggered": {
          "calls": [
            {
              "name": "search",
              "arguments": {
                "query": { "$pattern": "onboarding", "$flags": "i" }
              }
            }
          ]
        }
      }
    },
    {
      "id": "search-then-read",
      "input": "Open the latest onboarding guide and list its sections",
      "assertions": {
        "toolsTriggered": {
          "calls": [{ "name": "search" }, { "name": "get_document" }],
          "order": "strict"
        }
      }
    },
    {
      "id": "only-search",
      "input": "Which documents mention the API redesign?",
      "assertions": {
        "toolsTriggered": {
          "calls": [{ "name": "search" }],
          "exclusive": true
        }
      }
    },
    {
      "id": "no-tool-needed",
      "input": "What is 12 times 12?",
      "assertions": {
        "toolCallCount": { "exact": 0 },
        "containsText": "144"
      }
    },
    {
      "id": "pto-answer",
      "input": "How many days of PTO do new employees get?",
      "expected": { "answer": "New employees get 20 days of PTO a year." },
      "assertions": {
        "toolsTriggered": { "calls": [{ "name": "search" }] }
      },
      "judges": [
        { "type": "rubric", "rubric": "correctness", "threshold": 0.75 }
      ]
    }
  ]
}
```

`tests/search-evals.spec.ts`:

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

test.describe('search evals', () => {
  test('all cases', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset('./evals/search-evals.json');
    const result = await runEvalDataset(
      {
        dataset,
        client: 'mst',
        model: 'claude-haiku-4-5',
        defaultTrials: 10,
        defaultPassThreshold: 0.8,
      },
      { mcp, testInfo }
    );
    expect(result.failed).toBe(0);
  });
});
```

## Cost

Each trial is a full model conversation with every tool's definition in the prompt, and each judge adds a call. A dataset of 20 cases with 10 trials is 200 conversations per variant. Keep it down:

- Write and debug cases with `--trials 1` or `defaultTrials: 1`, then raise trials for the run that decides something.
- Narrow a run with `--case` (`mst run`) or `filterTags` (`runEvalDataset`).
- Use `toolsTriggered` and `toolCallCount` before judges.
- Price clients that report tokens but not cost with the eval config's `pricing` (see the reference).

## Checklist

- [ ] Every case has a unique `id` and an `input` written as a user would ask
- [ ] No 1.x keys (`scenario`, `expect`, `mode`, `toolName`, `iterations`, `accuracyThreshold`, `mcpHostConfig`)
- [ ] Tool names in `toolsTriggered` exist on the server; with several servers, calls name the server
- [ ] At least two phrasings per tool, plus selectivity and negative cases
- [ ] `trials` of 10 or more for any result you act on, with a `passThreshold` you chose on purpose
- [ ] `$pattern` strings are valid regular expressions, with backslashes escaped
- [ ] Playwright: `runEvalDataset(options, { mcp, testInfo })` with `client: 'mst'` and a `model`
- [ ] Eval config: `servers` is a map, variants list server labels, `client` is set, and `npx mst run --config <path> --dry-run` passes
- [ ] The API key for the model (and the judge) is in the environment, not in the file
