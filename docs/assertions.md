# Assertions Guide

MST's matchers assert on an MCP tool's response in a Playwright test: call the tool with `mcp.callTool()`, then `expect(result).toContainToolText(...)` and so on. This guide covers each matcher.

Eval cases assert on what the client under test did, not on a tool response. Their `assertions` take a subset: `containsText` and `matchesPattern` (on the client's answer), `toolsTriggered` and `toolCallCount`. Judges sit beside them, in the case's `judges` list. The [Evals Guide](./evals-guide.md) covers them. Sections below show the case form where one exists.

## Table of Contents

- [Exact Match](#exact-match)
- [Text Contains](#text-contains)
- [Regex Pattern Matching](#regex-pattern-matching)
- [Schema Validation](#schema-validation)
- [Snapshot Testing](#snapshot-testing)
- [LLM-as-a-Judge](#llm-as-a-judge)
- [Response Size](#response-size)
- [Custom Predicate](#custom-predicate)
- [Combining Multiple Assertions](#combining-multiple-assertions)
- [Examples](#examples)

## Exact Match

Validates exact equality of structured data (JSON). Best for predictable, structured responses.

### Inline Test Usage

```typescript
import { expect } from '@gleanwork/mcp-server-tester';

test('exact response', async ({ mcp }) => {
  const result = await mcp.callTool('calculate', { a: 2, b: 3 });
  expect(result).toMatchToolResponse({ result: 5 });
});
```

## Text Contains

Validates that response text contains expected substrings. Ideal for markdown or unstructured text responses.

### Eval Case Format

In an eval case, `assertions.containsText` checks the client's answer:

```json snippet=snippets/assertions-contains-text.json
{
  "id": "london-summary",
  "input": "Give me a short summary of London",
  "assertions": {
    "containsText": ["London", "population"]
  }
}
```

### Inline Test Usage

```typescript
import { expect } from '@gleanwork/mcp-server-tester';

test('text contains', async ({ mcp }) => {
  const result = await mcp.callTool('get_city_info', { city: 'London' });
  expect(result).toContainToolText(['## City Information', '**City:** London']);
});
```

### Options

- `caseSensitive` (default: `true`) - Whether to perform case-sensitive matching

### Best Practices

- Use for markdown responses where exact formatting may vary
- Include distinctive strings that confirm key information is present
- Order-independent (substrings can appear in any order)
- Great for validating headings, bullet points, and key phrases

## Regex Pattern Matching

Validates that response text matches regex patterns. Powerful for format validation and flexible pattern matching.

### Eval Case Format

In an eval case, `assertions.matchesPattern` checks the client's answer:

```json snippet=snippets/assertions-regex-patterns.json
{
  "id": "weather-format",
  "input": "What's the weather in London? Give the temperature in °C.",
  "assertions": {
    "matchesPattern": ["\\d+\\s?°C", "(Sunny|Cloudy|Rainy|Snowy)"]
  }
}
```

### Inline Test Usage

```typescript
import { expect } from '@gleanwork/mcp-server-tester';

test('pattern match', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });
  expect(result).toMatchToolPattern(['^## Weather', 'Temperature: \\d+°[CF]']);
});
```

### Pattern Features

- **Multiline matching** - `^` and `$` match line starts/ends
- **Escape special characters** - Use `\\` for literal characters (e.g., `\\d+` for digits)
- **Capture groups** - Use `(pattern1|pattern2)` for alternatives
- **Character classes** - Use `[a-z]`, `\\d`, `\\w`, etc.

### Best Practices

- Use `^` and `$` anchors to validate line structure
- Escape regex special characters in JSON (`\` becomes `\\`)
- Test patterns for both valid and invalid cases
- Combine with text contains for comprehensive validation

## Schema Validation

Validates response structure and types using Zod schemas. Best for structured data with specific type requirements.

### Inline Test Usage

```typescript snippet=snippets/assertions-schema-validation.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { z } from 'zod';

const UserSchema = z.object({ id: z.string(), name: z.string() });

test('schema validation', async ({ mcp }) => {
  const result = await mcp.callTool('get_user', { userId: '123' });
  expect(result).toMatchToolSchema(UserSchema);
});
```

### Schema Capabilities

Zod schemas support:

- Type validation (`string`, `number`, `boolean`, etc.)
- Format validation (`email`, `url`, `uuid`, etc.)
- Nested objects and arrays
- Optional and nullable fields
- Custom validation logic

### Example Schemas

```typescript
// Basic schema
const WeatherSchema = z.object({
  city: z.string(),
  temperature: z.number(),
  conditions: z.string(),
});

// Complex schema with nested data
const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
  age: z.number().int().min(0).optional(),
  address: z.object({
    street: z.string(),
    city: z.string(),
    zip: z.string().regex(/^\d{5}$/),
  }),
  tags: z.array(z.string()),
});
```

## Snapshot Testing

Captures and compares tool responses against stored snapshots using Playwright's built-in snapshot functionality. Best for deterministic responses where you want to detect any changes.

> **Requires Playwright test context.** `toMatchToolSnapshot()` calls Playwright's native
> snapshot infrastructure internally and only works inside a Playwright test function.
> If you call it outside a test or in a programmatic validator, you will get a cryptic
> context error.

> **Important:** Snapshot testing works best with deterministic, stable responses. For responses containing timestamps, IDs, or live data, use [sanitizers](#snapshot-sanitizers) or consider [Schema Validation](#schema-validation) instead.

### When to Use Snapshots

| Good Use Cases                          | Poor Use Cases                    |
| --------------------------------------- | --------------------------------- |
| Help text and documentation             | Live data (weather, stock prices) |
| Configuration and schema discovery      | Responses with timestamps         |
| Mocked/stubbed servers in CI            | Random IDs, session tokens        |
| Static content tools                    | Non-deterministic ordering        |
| Regression testing with controlled data | Pagination cursors                |

### Inline Test Usage

```typescript
import { expect } from '@gleanwork/mcp-server-tester';

test('snapshot', async ({ mcp }, testInfo) => {
  const result = await mcp.callTool('help', {});
  expect(result).toMatchToolSnapshot('help-output');
});
```

### Workflow

1. **First run**: Playwright captures snapshots to `__snapshots__/` folder
2. **Subsequent runs**: Compares responses against captured snapshots
3. **Update snapshots**: Run `npx playwright test --update-snapshots` when responses change intentionally

### Snapshot Sanitizers

When responses contain variable data that would cause snapshot mismatches, use sanitizers to normalize the content before comparison.

#### Built-in Sanitizers

| Sanitizer   | Matches                          | Replacement   |
| ----------- | -------------------------------- | ------------- |
| `timestamp` | Unix timestamps (10-13 digits)   | `[TIMESTAMP]` |
| `uuid`      | UUIDs v1-v5                      | `[UUID]`      |
| `iso-date`  | ISO 8601 dates                   | `[ISO_DATE]`  |
| `objectId`  | MongoDB ObjectIds (24 hex chars) | `[OBJECT_ID]` |
| `jwt`       | JWT tokens                       | `[JWT]`       |

#### Sanitizer Types

**Built-in (string)**: Use predefined patterns for common variable data.

```json
"snapshotSanitizers": ["uuid", "timestamp", "iso-date"]
```

**Custom regex**: Define your own patterns.

```json
"snapshotSanitizers": [
  { "pattern": "token_[a-zA-Z0-9]+", "replacement": "[TOKEN]" },
  { "pattern": "v\\d+\\.\\d+\\.\\d+", "replacement": "[VERSION]" }
]
```

**Field removal**: Remove specific fields from objects (supports dot notation).

```json
"snapshotSanitizers": [
  { "remove": ["createdAt", "updatedAt", "session.id", "metrics.timing"] }
]
```

### Example: API Response with Variable Data

```json
// Original response from MCP tool
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Alice",
    "email": "alice@example.com",
    "lastLogin": "2025-01-15T10:30:00Z",
    "sessionToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}

// After sanitizers: ["uuid", "iso-date", "jwt"]
{
  "user": {
    "id": "[UUID]",
    "name": "Alice",
    "email": "alice@example.com",
    "lastLogin": "[ISO_DATE]",
    "sessionToken": "[JWT]"
  }
}
```

### Programmatic Sanitizer Use

Sanitizers are applied automatically by `toMatchToolSnapshot()`. The sanitizer names (`'uuid'`, `'timestamp'`, etc.) and custom regex patterns are specified inline on the assertion as shown above.

### Best Practices

- **Start without sanitizers** for truly deterministic tools
- **Add sanitizers incrementally** as you discover variable fields
- **Prefer field removal** when entire fields are unpredictable
- **Use schema validation** when structure matters more than exact values
- **Document why** each sanitizer is needed in your test case description

## LLM-as-a-Judge

A judge scores a response from 0 to 1, and the assertion passes when the score reaches its `threshold` (default `0.7`). Use one for subjective criteria such as relevance, quality or tone.

Every judge runs the same way. The built-in `rubric` judge asks an LLM to score the response against a rubric. A plugin can add judges of its own, referenced as `<namespace>/judge/<name>` (see [Plugins](./evaluation-framework.md#plugins)).

### Eval Case Format

In an eval case, the `judges` list (beside `assertions`) judges the client's answer. Each entry is written like an eval config's `judges`: a reference, or `{ "type": <reference>, ...options }`.

```json snippet=snippets/assertions-passes-judge.json
{
  "id": "auth-docs",
  "input": "Find our documentation on authentication",
  "judges": [
    {
      "type": "rubric",
      "rubric": {
        "text": "Evaluate if the answer points to relevant authentication docs. Score 0-1."
      },
      "threshold": 0.7
    }
  ]
}
```

`"type": "rubric"` is the built-in `rubric` judge, and its LLM settings go next to the rubric:

```json
{
  "judges": [
    {
      "type": "rubric",
      "rubric": "correctness",
      "provider": "openai",
      "model": "gpt-4o",
      "threshold": 0.75
    }
  ]
}
```

To use a plugin's judge, name it: `"acme/judge/completeness"`, or `{ "type": "acme/judge/completeness", "threshold": 0.8 }` with settings. Its other fields, or `options`, are the judge's own options, checked by its schema. Every judge in the list must pass. A case also runs the eval config's `judges` (see [Judges](./evaluation-framework.md#judges)); a case judge that names one of them overrides its settings.

```typescript snippet=snippets/judge-config.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';

// Each case lists its judges, with their LLM settings, in `judges`.
test('search relevance eval with judge', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/evals.json');
  const result = await runEvalDataset(
    { dataset, client: 'mst', model: 'claude-haiku-4-5' },
    { mcp, testInfo }
  );
  expect(result.passed).toBe(result.total);
});
```

### Inline Test Usage

```typescript
import { expect } from '@gleanwork/mcp-server-tester';

test('search relevance', async ({ mcp }) => {
  const result = await mcp.callTool('search_docs', { query: 'authentication' });
  await expect(result).toPassToolJudge(
    {
      text: 'Evaluate if the search results are relevant to the query. Score 0-1.',
    },
    { passingThreshold: 0.7 }
  );
});
```

The matcher takes `passingThreshold` where datasets use `threshold`, plus `reference`, `reps`, `provider`, `model`, `judge` and `options`. `toPassToolJudge({ judge: 'acme/judge/completeness' })` runs a plugin judge, and a list of judges must all pass.

### Supported Providers

- **OpenAI** - Requires `OPENAI_API_KEY` environment variable, or a gateway credential (see [LLM Gateways](./llm-gateways.md))

  ```typescript
  createJudge({
    provider: 'openai',
    model: 'gpt-4',
    temperature: 0.0,
  });
  ```

- **Anthropic** - Requires `ANTHROPIC_API_KEY` environment variable, or a gateway credential (see [LLM Gateways](./llm-gateways.md))
  ```typescript
  createJudge({
    provider: 'anthropic',
    model: 'claude-3-opus-20240229',
    temperature: 0.0,
  });
  ```

`createJudge` is the LLM client the `rubric` judge uses; call it directly to score outside an assertion.

### Judge Configuration

| Field        | Default                        | Description                                                                                                                   |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `judge`      | `rubric`                       | The judge: the built-in `rubric`, or `<namespace>/judge/<name>` from a plugin.                                                |
| `rubric`     | —                              | A built-in rubric name or `{ "text": "..." }`. Shorthand for the `rubric` judge.                                              |
| `threshold`  | `0.7`                          | Minimum mean score (0–1) to pass.                                                                                             |
| `reference`  | the case's `expected.answer`   | What the judge compares the response with.                                                                                    |
| `reps`       | the case's `judgeReps`, or `1` | Times the judge scores the same response; the mean is compared with `threshold`.                                              |
| `options`    | —                              | The judge's own options. Without `options`, a named judge gets its other flat fields.                                         |
| LLM settings | `provider`: `anthropic`        | The `rubric` judge's `provider`, `model`, `apiKeyEnvVar`, `maxTokens`, `temperature`, `maxBudgetUsd` and `maxToolOutputSize`. |

`reps` repeats only the judge, not the case: `trials: 3` with `judgeReps: 2` is 6 calls per judge.

### Built-in Rubrics and Scoring Scale

All built-in rubrics use a **5-point scale**: `0.0` / `0.25` / `0.5` / `0.75` / `1.0`. Each level has a concrete description to guide the judge model toward consistent scores.

| Score  | Meaning                                                  |
| ------ | -------------------------------------------------------- |
| `1.0`  | Fully meets the criterion with no deficiencies           |
| `0.75` | Mostly meets the criterion with one minor issue          |
| `0.5`  | Partially meets the criterion — notable gaps present     |
| `0.25` | Minimally meets the criterion — substantial deficiencies |
| `0.0`  | Does not meet the criterion                              |

Available built-in rubrics: `correctness`, `completeness`, `groundedness`, `instruction-following`, `conciseness`.

Use a built-in rubric by name in your eval case:

```json
{
  "judges": [{ "type": "rubric", "rubric": "correctness", "threshold": 0.75 }]
}
```

For custom criteria, provide `{ "text": "..." }` with explicit score-level descriptions to get comparable consistency.

### Best Practices

- Use low temperature (0.0) for consistency
- Prefer built-in rubrics when they fit — they have calibrated 5-point descriptions
- When writing custom rubrics, include score-level descriptions (e.g., "Score 0.75 for...")
- Test rubrics with known good/bad examples
- Set appropriate passing thresholds based on your quality standards
- Consider cost implications (LLM API calls per evaluation, times `reps`)

## Response Size

Validates that the response text falls within expected byte bounds. Use this when you need to catch responses that are suspiciously short (missing data) or unexpectedly large (truncation risk, runaway output).

Size is measured in UTF-8 bytes of the extracted text content across all content items in the MCP `CallToolResult`.

### Inline Test Usage

```typescript
import { expect } from '@gleanwork/mcp-server-tester';

test('response is within expected size', async ({ mcp }) => {
  const result = await mcp.callTool('search_docs', { query: 'authentication' });

  // Ensure we have a non-trivial response but not an enormous dump
  expect(result).toHaveToolResponseSize({ minBytes: 100, maxBytes: 50_000 });
});

test('brief summary stays compact', async ({ mcp }) => {
  const result = await mcp.callTool('summarize', { text: 'Short article.' });
  expect(result).toHaveToolResponseSize({ maxBytes: 2_000 });
});
```

### Options

| Option     | Type     | Description                           |
| ---------- | -------- | ------------------------------------- |
| `minBytes` | `number` | Minimum allowed response size (bytes) |
| `maxBytes` | `number` | Maximum allowed response size (bytes) |

At least one of `minBytes` or `maxBytes` must be provided. Both can be combined to assert a range.

### Best Practices

- Use `minBytes` to catch tools that silently return empty or near-empty responses
- Use `maxBytes` to detect runaway responses or streaming failures that dump excessive data
- Size is UTF-8 bytes of text content; binary or non-text content items do not contribute to the count
- Combine with `toContainToolText` or `toMatchToolSchema` — size bounds alone do not verify correctness

## Custom Predicate

Validates that a response satisfies an arbitrary predicate function. Use this as an escape hatch when none of the built-in matchers fit your validation logic.

The predicate receives the raw MCP `CallToolResult` object as the first argument and the extracted text content as the second argument. Return a boolean for simple pass/fail, or return an object with `pass` and `message` fields for a custom error message. Async predicates are also supported.

### Inline Test Usage

```typescript snippet=snippets/assertions-custom-predicate.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('response contains at least three results', async ({ mcp }) => {
  const result = await mcp.callTool('search_docs', { query: 'setup' });

  await expect(result).toSatisfyToolPredicate((response, text) => {
    const matches = text.match(/^##\s/gm);
    return {
      pass: matches !== null && matches.length >= 3,
      message: `Expected at least 3 result sections, found ${matches?.length ?? 0}`,
    };
  }, 'minimum result count');
});
```

```typescript snippet=snippets/assertions-json-predicate.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('JSON content is parseable', async ({ mcp }) => {
  const result = await mcp.callTool('get_config', {});

  await expect(result).toSatisfyToolPredicate((response, text) => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return { pass: false, message: 'Response text is not valid JSON' };
    }
  });
});
```

```typescript
import { expect } from '@gleanwork/mcp-server-tester';

test('async external validation', async ({ mcp }) => {
  const result = await mcp.callTool('generate_token', {});

  await expect(result).toSatisfyToolPredicate(async (response, text) => {
    const valid = await myTokenValidationService.verify(text.trim());
    return { pass: valid, message: 'Token failed external validation' };
  });
});
```

### Options

| Parameter     | Type     | Required | Description                                                                            |
| ------------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `predicate`   | function | Yes      | Receives `(response: unknown, text: string)` — return `boolean` or `{ pass, message }` |
| `description` | string   | No       | Label used in failure messages (default: `"custom predicate"`)                         |

The predicate may be synchronous or `async`. Errors thrown inside the predicate are caught and reported as failures.

### Best Practices

- Provide a `description` argument — it appears in Playwright's failure output and makes failures readable
- Return `{ pass, message }` instead of a bare boolean when the failure reason is not obvious
- Prefer a built-in matcher when one fits — predicates are harder to read at a glance
- The `response` argument is the raw `CallToolResult`; use `text` (second argument) for extracted string content

## Matcher Naming Convention

The custom Playwright matchers follow standard Playwright/Jest prefix conventions. All matchers include `Tool` in the name to distinguish them from built-in matchers.

| Prefix       | Meaning                  | Matchers                                                                                |
| ------------ | ------------------------ | --------------------------------------------------------------------------------------- |
| `toMatch*`   | Structural/content match | `toMatchToolResponse`, `toMatchToolSchema`, `toMatchToolPattern`, `toMatchToolSnapshot` |
| `toContain*` | Substring presence       | `toContainToolText`                                                                     |
| `toBe*`      | Identity/boolean check   | `toBeToolError`                                                                         |
| `toHave*`    | Property/count assertion | `toHaveToolResponseSize`, `toHaveToolCalls`, `toHaveToolCallCount`                      |
| `toPass*`    | External evaluation      | `toPassToolJudge`                                                                       |
| `toSatisfy*` | Custom predicate         | `toSatisfyToolPredicate`                                                                |

## Combining Multiple Assertions

A test can apply several matchers to one response:

```typescript
test('city info', async ({ mcp }) => {
  const result = await mcp.callTool('get_city_info', { city: 'London' });
  expect(result).toMatchToolSchema(CityInfoSchema);
  expect(result).toContainToolText(['London', 'Population']);
  expect(result).toMatchToolPattern([
    /^## City Information/m,
    /Population: [\d.]+M/,
  ]);
  await expect(result).toPassToolJudge('correctness');
});
```

An eval case can declare several assertions and judges too. Each is graded on its own and reported per grader:

```json snippet=snippets/assertions-combined.json
{
  "id": "london-city-info",
  "input": "Tell me about London: its population and main features",
  "expected": {
    "answer": "London has about 8.9M people and is known for its museums and transport."
  },
  "assertions": {
    "containsText": ["London"],
    "matchesPattern": ["[\\d.]+\\s?M"],
    "toolsTriggered": {
      "calls": [
        {
          "name": "get_city_info",
          "required": true
        }
      ]
    }
  },
  "judges": [{ "type": "rubric", "rubric": "correctness", "threshold": 0.7 }]
}
```

## Examples

### Choosing the Right Assertion

| Response Type                       | Recommended Assertion | Why                                        |
| ----------------------------------- | --------------------- | ------------------------------------------ |
| JSON with fixed structure           | Exact Match           | Predictable, structured data               |
| JSON with variable values           | Schema                | Type-safe validation with flexibility      |
| Markdown/formatted text             | Text Contains         | Order-independent content validation       |
| Text with specific format           | Regex                 | Pattern-based validation                   |
| Deterministic output (help, config) | Snapshot              | Detect any changes to known-good output    |
| Variable data with stable structure | Snapshot + Sanitizers | Normalize timestamps/IDs before comparison |
| Subjective quality                  | LLM Judge             | Semantic understanding required            |

### Next Steps

- Check out the [Quick Start Guide](./quickstart.md) for getting started
- See the [API Reference](./api-reference.md) for detailed function signatures
- Explore [Examples](../examples) for real-world usage patterns
