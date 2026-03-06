# Evals Guide

> A practical introduction to building and running evals for MCP servers using `@gleanwork/mcp-server-tester`.

---

## What Is an Eval, and Why Should You Care?

A **test** checks that your code does what you wrote it to do. Pass or fail, deterministic, milliseconds to run.

An **eval** checks that your _system_ does what a _user_ needs it to do. Probabilistic, needs multiple runs, takes seconds or minutes.

For MCP servers, this distinction matters enormously. Your tool definitions — the names, descriptions, and schemas you expose to AI clients — directly affect whether Claude Desktop, ChatGPT, or any other LLM host will actually _use_ your tools correctly. A unit test can verify that your `search` tool returns results. It cannot tell you whether a real user asking "find recent docs about planning" will cause Claude to call `search` in the first place.

That's the gap evals fill.

**The two things evals measure for MCP servers:**

1. **Does the tool work?** — Call it directly with known inputs and check the output. This is deterministic. Run it once.

2. **Will an LLM discover and use the tool correctly?** — Put a real LLM in front of your tools and give it a realistic scenario. Measure how often it triggers the right tool. This is probabilistic. Run it many times.

---

## The Mental Model: Three Ingredients

Every eval case has three parts:

```text
Scenario  →  Run  →  Assertion
```

**Scenario**: The input. In direct mode this is tool arguments (`{ query: "MCP server testing" }`). In LLM host mode this is a natural language prompt ("Find recent docs about MCP testing").

**Run**: Executing the scenario against your MCP server. In direct mode this is a single tool call. In LLM host mode this is an LLM receiving your tools and deciding which ones to call.

**Assertion**: The pass/fail check. Did the response contain expected text? Did the LLM call the right tool? Was the call count in the expected range?

The eval runner orchestrates Scenario → Run → Assertion, potentially dozens of times, and reports back accuracy — the fraction of runs where every assertion passed.

---

## Two Modes

### Direct Mode

You call a tool yourself with explicit arguments. The result is checked against your assertions.

```json
{
  "id": "search-returns-results",
  "mode": "direct",
  "toolName": "search",
  "args": { "query": "MCP server testing" },
  "expect": {
    "isError": false,
    "responseSize": { "minBytes": 100 }
  }
}
```

**When to use it:** Smoke tests. Verifying your tools are connected, responding, and returning the right shape of data. Regression detection when you change tool implementations.

**How many iterations:** 1. Tool responses are deterministic (or close enough). Running a search 10 times doesn't tell you more than running it once.

**What you're testing:** The tool itself, not how well it's described.

---

### LLM Host Mode

A real LLM receives your tools and a natural language scenario, then decides which tools to call. You assert that it made the right choices.

```json
{
  "id": "llm-triggers-search",
  "mode": "mcp_host",
  "scenario": "Find recent internal documents about the Glean MCP server",
  "mcpHostConfig": {
    "provider": "vertex-anthropic",
    "model": "claude-3-5-haiku@20241022"
  },
  "accuracyThreshold": 0.8,
  "expect": {
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }]
    }
  }
}
```

**When to use it:** Testing whether your tool descriptions actually communicate intent to an LLM. A/B testing tool name or description changes. Validating that tool selectivity works (people questions → `employee_search`, not `search`).

**How many iterations:** At least 10. LLMs are non-deterministic — the same scenario may trigger different tools on different runs. 3 iterations is almost meaningless statistically. 10 gives you a rough accuracy estimate. 20+ lets you make reliable decisions about whether a change helped.

**What you're testing:** Your tool _descriptions_ and the mental model they create in the LLM, not the tool implementation.

---

## Accuracy and Iterations: The Core Concept

The most important thing to understand about LLM host evals is that a single run tells you almost nothing.

Suppose you run your eval once and the LLM calls the right tool. Did you write a good tool description? Maybe. Did you get lucky? Also maybe. You can't tell from one sample.

**Accuracy** is the fraction of runs where every assertion passed:

```
accuracy = passing_iterations / total_iterations
```

If your eval runs 10 times and the LLM picks the right tool 8 times, your accuracy is 0.8 (80%).

**AccuracyThreshold** is the minimum accuracy needed to consider the eval "passed":

```json
"accuracyThreshold": 0.8
```

This says: "I'll accept this eval as passing if the LLM gets it right at least 80% of the time." Below that threshold, the eval fails — which tells you the tool description needs work.

### Why You Need More Than 3 Iterations

Here's the uncomfortable math. With 3 iterations, a tool that works 40% of the time is statistically indistinguishable from one that works 94% of the time. The confidence interval is just too wide to make decisions.

| Iterations | Margin of error (95% CI) | Useful for                  |
| ---------- | ------------------------ | --------------------------- |
| 3          | ±27 percentage points    | Almost nothing              |
| 10         | ±16 percentage points    | Detecting large regressions |
| 20         | ±10 percentage points    | Making real decisions       |
| 50         | ±6 percentage points     | Release gates               |

**Practical recommendation:** 10 iterations for development/CI, 20 for release gates. The `defaultLlmIterations` option in `runEvalDataset` sets this globally so you don't have to repeat it on every case:

```typescript
await runEvalDataset({ dataset, defaultLlmIterations: 10 }, { mcp, testInfo });
```

Individual cases can override this with their own `iterations` field.

---

## Designing Good Scenarios

This is where most eval efforts fall short. A single scenario phrasing tests whether your tool works for that exact phrasing, not whether the description is generally good.

### The Diversity Problem

If your only scenario for `employee_search` is "Who leads the developer platform team?", and the LLM gets it right 10/10 times, you've learned that _that exact phrasing_ works. You haven't learned whether it works for "find the VP of engineering" or "who should I talk to about API access?" Those might fail.

**Rule of thumb:** Write at least 2-3 scenario phrasings per tool. Vary the vocabulary, the level of directness, and the implied user goal.

```json
{ "scenario": "Who leads the developer platform team at Glean?" },
{ "scenario": "Find engineers who work on the MCP server at Glean" },
{ "scenario": "Who should I contact about developer API integrations?" }
```

### Scenario Design Checklist

1. **Use natural phrasing** — Write scenarios the way a real user would ask the question, not the way an engineer would phrase a function call. "Search for recent documents about the Q4 planning process" not "Call search with query 'Q4 planning'."

2. **Test the _intent_, not the keyword** — Good tool descriptions work even when the user doesn't use the tool's name. "Find recent documents" should trigger `search` without the user saying "search".

3. **Test selectivity** — For each tool, write a scenario that should trigger it and NOT other tools. This catches over-triggering (using `search` when `employee_search` would be better).

4. **Include ambiguous cases** — Real users write ambiguous queries. "Tell me about the planning process" could be a search OR a chat question. Decide what the right behavior is and assert it.

5. **Match the user population** — Your tool descriptions need to work for the range of users who will actually use the system, not just for you. If your users are non-technical, test non-technical phrasings.

### Negative Cases

Not every scenario should expect a tool call. Some scenarios should result in the LLM answering from context without calling any tools:

```json
{
  "id": "llm-no-tool-needed",
  "scenario": "What's 2 + 2?",
  "expect": {
    "toolCallCount": { "exact": 0 }
  }
}
```

This tests that your tools don't _over-trigger_ for questions that don't need them.

---

## The Assertion Types

### `isError`

Does the response indicate failure?

```json
{ "isError": false }
```

Use this in direct mode to verify tool calls succeed.

### `containsText`

Does the response text include expected substrings?

```json
{ "containsText": ["Steve", "Calvert"] }
```

### `responseSize`

Is the response within expected size bounds?

```json
{ "responseSize": { "minBytes": 100 } }
```

Useful for smoke tests — a 0-byte response means something went wrong.

### `toolsTriggered`

Did the LLM call the right tools? This is the core assertion for LLM host mode.

```json
{
  "toolsTriggered": {
    "calls": [{ "name": "search", "required": true }],
    "order": "any",
    "exclusive": false
  }
}
```

- `required: true` — the LLM _must_ call this tool
- `required: false` — it _may_ call this tool, but not required
- `order: "strict"` — calls must appear in the listed order
- `exclusive: true` — only the listed tools may be called (no unexpected tools)

### `toolCallCount`

How many tools did the LLM call?

```json
{ "toolCallCount": { "min": 1, "max": 3 } }
```

Useful for detecting runaway tool use (the LLM calling tools in a loop) or for confirming it found the answer in one shot.

### `passesJudge`

Did an LLM evaluator (judge) say the response was good? This is for quality, not just correctness.

```json
{
  "passesJudge": {
    "rubric": {
      "text": "The response should cite specific documents, not generic advice"
    },
    "threshold": 0.7
  }
}
```

This is the most expensive assertion (requires a second LLM call) and the most powerful. Use it when you care not just that the right tool was called, but that the final answer was actually useful.

---

## Stacking Assertions

Assertions compose. A case passes only if _all_ assertions pass. This lets you be precise about what "correct behavior" means:

```json
{
  "expect": {
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }]
    },
    "toolCallCount": { "min": 1, "max": 5 },
    "passesJudge": {
      "rubric": "completeness",
      "threshold": 0.7
    }
  }
}
```

This case only passes if: the LLM called `search`, made between 1 and 5 tool calls total, AND a judge rated the final response as a good synthesis of results.

---

## How to Think About Accuracy Thresholds

`accuracyThreshold` is not a number to pick arbitrarily. It's a decision about acceptable failure rates.

**Think of it as:** "In what fraction of real user interactions am I OK with the wrong tool being called?"

| Threshold | What it means                     | When to use                    |
| --------- | --------------------------------- | ------------------------------ |
| 1.0       | Zero tolerance — must always work | Critical paths, primary tools  |
| 0.9       | 1 in 10 interactions may fail     | Important secondary tools      |
| 0.8       | 1 in 5 interactions may fail      | Useful but not essential tools |
| 0.7       | 3 in 10 interactions may fail     | Experimental features          |

A threshold of 0.8 with 10 iterations means: "This eval passes if 8 or more of 10 runs trigger the right tool."

If your description is genuinely good, you should comfortably exceed this threshold. If you're regularly sitting at exactly 8/10, your description may be borderline and worth revisiting.

---

## Interpreting Results

When your eval runs, the reporter shows:

```
✅ llm-search-phrasing-a  (accuracy: 90%)  — 9/10 iterations passed
✅ llm-employee-search     (accuracy: 100%) — 10/10 iterations passed
❌ llm-meeting-lookup       (accuracy: 60%)  — 6/10 iterations passed  ← needs work
```

**100% accuracy:** Your tool description is crystal clear for this scenario phrasing. The LLM always knows exactly what to do.

**80–90% accuracy:** The description works well. Small wording improvements might push it higher, but it's production-ready.

**60–79% accuracy:** The description is ambiguous or competing with other tool descriptions. Worth investigating — look at which iterations failed and what tools the LLM called instead.

**Below 60%:** The LLM is guessing. Something is fundamentally unclear about the tool's purpose, or a competing tool is attracting these queries.

**How to debug low accuracy:** Look at the iteration-level breakdown in the detail view. If the LLM consistently picks `search` when you wanted `employee_search`, the distinction between the two tools isn't clear enough in their descriptions.

---

## A/B Testing Tool Descriptions

The killer use case for LLM host evals is testing whether a description change actually helps. The framework supports this through Playwright projects.

Create two projects in `playwright.config.ts`, each pointing at the same MCP server but with different system prompt additions:

```typescript
projects: [
  {
    name: 'baseline',
    use: {
      mcpConfig: { transport: 'http', serverUrl: '...' },
    },
  },
  {
    name: 'with-skill',
    use: {
      mcpConfig: {
        transport: 'http',
        serverUrl: '...',
        // After adding a Glean skill to the LLM host config
      },
      mcpHostConfig: {
        systemPromptAdditions: [
          'You have access to Glean enterprise search. Use the search tool to find internal documents, and employee_search to find people.',
        ],
      },
    },
  },
];
```

Run both and compare accuracy per tool. The reporter groups results by project, making the comparison straightforward.

---

## Common Mistakes

**Running too few iterations.** 3 iterations is noise. If you can't afford 10, you're better off with 0 and accepting that you don't have data yet.

**Testing the scenario, not the description.** If you write the scenario after looking at the tool description, you're likely to use the same vocabulary the description uses. The LLM will get it right, but a real user might not. Write scenarios first.

**Ignoring selectivity.** "Will `search` be called for this scenario?" is only half the question. "Will `employee_search` be called _instead of_ `search` when it should be?" is equally important.

**Setting threshold to 1.0 everywhere.** If your CI requires 100% accuracy, any LLM non-determinism will cause flaky failures. Reserve 1.0 for cases you're confident are genuinely always correct. Use 0.8–0.9 for most cases.

**Not varying phrasings.** One scenario per tool gives you one data point. If that scenario happens to use a keyword from the tool description, you may be measuring nothing.

**Forgetting that accuracy reflects your description, not the LLM.** When accuracy is low, the instinct is to blame the model. Usually the issue is the tool description. Try rewriting the description before switching models.

---

## Quick Reference: Eval Dataset Structure

```json
{
  "name": "my-server-evals",
  "description": "Optional description",
  "cases": [
    {
      "id": "unique-case-id",
      "description": "Human-readable description",

      "mode": "direct", // or "mcp_host"
      "toolName": "search", // required for direct mode
      "args": { "query": "hello" }, // required for direct mode

      // For mcp_host mode instead:
      "scenario": "Find recent documents about X",
      "mcpHostConfig": {
        "provider": "vertex-anthropic", // or "openai", "anthropic", etc.
        "model": "claude-3-5-haiku@20241022",
        "maxToolCalls": 5
      },

      // Multi-iteration (mainly for mcp_host):
      "iterations": 10, // or use defaultLlmIterations in the runner
      "accuracyThreshold": 0.8, // fraction that must pass (0–1)

      "expect": {
        "isError": false,
        "containsText": ["expected", "text"],
        "responseSize": { "minBytes": 100 },
        "toolsTriggered": {
          "calls": [{ "name": "search", "required": true }],
          "order": "any",
          "exclusive": false
        },
        "toolCallCount": { "min": 1, "max": 5 },
        "passesJudge": {
          "rubric": { "text": "Response must cite specific documents" },
          "threshold": 0.7
        }
      }
    }
  ]
}
```

---

## Quick Reference: Running Evals

```typescript
import { runEvalDataset, loadEvalDataset } from '@gleanwork/mcp-server-tester';

test('my evals', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/my-evals.json');

  const result = await runEvalDataset(
    {
      dataset,

      // Apply 10 iterations to all mcp_host cases
      // that don't specify iterations explicitly
      defaultLlmIterations: 10,

      // Run up to 3 cases at once (careful with rate limits)
      concurrency: 3,
    },
    { mcp, testInfo }
  );

  // result.passed / result.total gives overall pass rate
  // result.caseResults[i].accuracy gives per-case accuracy
  // result.caseResults[i].iterationResults gives per-run breakdown
});
```

---

## Where to Go From Here

1. **Start with direct mode** — Build smoke tests for every tool before adding LLM host cases. You need to know the tools work before testing whether they're discoverable.

2. **Add 2–3 LLM host cases per tool** — Focus on the scenarios most representative of how real users actually ask questions.

3. **Set `defaultLlmIterations: 10`** — This is the minimum for meaningful accuracy numbers.

4. **Review failing cases first** — Low accuracy on a tool is a signal to rewrite its description, not to lower the threshold.

5. **Run before and after description changes** — Evals earn their keep as a diff tool. The output of a single run is interesting. The delta between two runs is actionable.
