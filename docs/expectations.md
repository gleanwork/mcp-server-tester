# Expectations Guide

The framework supports multiple types of expectations to validate MCP tool responses. This guide covers all available expectation types and how to use them.

## Table of Contents

- [Exact Match](#exact-match)
- [Text Contains](#text-contains)
- [Regex Pattern Matching](#regex-pattern-matching)
- [Schema Validation](#schema-validation)
- [Snapshot Testing](#snapshot-testing)
- [LLM-as-a-Judge](#llm-as-a-judge)
- [Combining Multiple Expectations](#combining-multiple-expectations)
- [Examples](#examples)

## Exact Match

Validates exact equality of structured data (JSON). Best for predictable, structured responses.

### Dataset Format

Use the `expect.response` field in the eval dataset JSON:

```json
{
  "id": "calc-test",
  "toolName": "calculate",
  "args": { "a": 2, "b": 3 },
  "expect": {
    "response": { "result": 5 }
  }
}
```

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

### Dataset Format

Use the `expect.containsText` field in the eval dataset JSON:

```json
{
  "id": "markdown-response",
  "toolName": "get_city_info",
  "args": { "city": "London" },
  "expect": {
    "containsText": [
      "## City Information",
      "**City:** London",
      "### Features",
      "- Public Transportation"
    ]
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

### Dataset Format

Use the `expect.matchesPattern` field in the eval dataset JSON:

```json
{
  "id": "weather-format",
  "toolName": "get_weather",
  "args": { "city": "London" },
  "expect": {
    "matchesPattern": [
      "^## Weather",
      "Temperature: \\d+°[CF]",
      "Conditions?: (Sunny|Cloudy|Rainy|Snowy)",
      "\\d{4}-\\d{2}-\\d{2}"
    ]
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

### Usage

Load the dataset with schemas attached, then reference them by name in each case:

```typescript
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const dataset = await loadEvalDataset('./evals.json', {
  schemas: {
    'user-response': z.object({
      id: z.string(),
      name: z.string(),
      email: z.string().email(),
    }),
  },
});

const result = await runEvalDataset({ dataset }, { mcp, testInfo });
```

### Inline Test Usage

```typescript
import { expect } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const UserSchema = z.object({ id: z.string(), name: z.string() });

test('schema validation', async ({ mcp }) => {
  const result = await mcp.callTool('get_user', { userId: '123' });
  expect(result).toMatchToolSchema(UserSchema);
});
```

### Dataset Format

Use the `expect.schema` field to reference a named Zod schema loaded with `loadEvalDataset`:

```json
{
  "id": "get-user",
  "toolName": "get_user",
  "args": { "userId": "123" },
  "expect": {
    "schema": "user-response"
  }
}
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

> **Important:** Snapshot testing works best with deterministic, stable responses. For responses containing timestamps, IDs, or live data, use [sanitizers](#snapshot-sanitizers) or consider [Schema Validation](#schema-validation) instead.

### When to Use Snapshots

| Good Use Cases                          | Poor Use Cases                    |
| --------------------------------------- | --------------------------------- |
| Help text and documentation             | Live data (weather, stock prices) |
| Configuration and schema discovery      | Responses with timestamps         |
| Mocked/stubbed servers in CI            | Random IDs, session tokens        |
| Static content tools                    | Non-deterministic ordering        |
| Regression testing with controlled data | Pagination cursors                |

### Dataset Format

Use the `expect.snapshot` field in the eval dataset JSON. Pass `testInfo` to `runEvalDataset` to enable Playwright snapshot infrastructure:

```json
{
  "id": "help-command",
  "toolName": "help",
  "args": {},
  "expect": {
    "snapshot": "help-output"
  }
}
```

```typescript
const result = await runEvalDataset({ dataset }, { mcp, testInfo });
```

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

#### Dataset Format with Sanitizers

```json
{
  "id": "get-user-profile",
  "toolName": "get_user",
  "args": { "id": "123" },
  "expect": {
    "snapshot": "user-profile",
    "snapshotSanitizers": [
      "uuid",
      "iso-date",
      { "pattern": "session_[a-zA-Z0-9]+", "replacement": "[SESSION]" },
      { "remove": ["lastLoginAt", "metrics.requestId"] }
    ]
  }
}
```

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

For advanced use cases, you can apply sanitizers directly:

```typescript
import {
  applySanitizers,
  BUILT_IN_PATTERNS,
} from '@gleanwork/mcp-server-tester';

const sanitized = applySanitizers(response, [
  'uuid',
  'timestamp',
  { pattern: 'custom_\\d+', replacement: '[CUSTOM]' },
]);
```

### Best Practices

- **Start without sanitizers** for truly deterministic tools
- **Add sanitizers incrementally** as you discover variable fields
- **Prefer field removal** when entire fields are unpredictable
- **Use schema validation** when structure matters more than exact values
- **Document why** each sanitizer is needed in your test case description

## LLM-as-a-Judge

Semantic evaluation using LLMs (OpenAI or Anthropic). Best for subjective criteria like relevance, quality, or tone.

### Dataset Format

Use the `expect.passesJudge` field in the eval dataset JSON. Supply a `judgeClient` to `runEvalDataset`:

```json
{
  "id": "search-test",
  "toolName": "search_docs",
  "args": { "query": "authentication" },
  "expect": {
    "passesJudge": {
      "rubric": {
        "text": "Evaluate if the search results are relevant to the query. Score 0-1."
      },
      "threshold": 0.7
    }
  }
}
```

```typescript
import {
  createLLMJudgeClient,
  runEvalDataset,
} from '@gleanwork/mcp-server-tester';

const judgeClient = createLLMJudgeClient({
  provider: 'openai',
  model: 'gpt-4',
  temperature: 0.0,
});

const result = await runEvalDataset(
  { dataset, judgeClient },
  { mcp, testInfo }
);
```

### Inline Test Usage

```typescript
import { expect } from '@gleanwork/mcp-server-tester';

test('search relevance', async ({ mcp }) => {
  const result = await mcp.callTool('search_docs', { query: 'authentication' });
  expect(result).toPassToolJudge(
    {
      text: 'Evaluate if the search results are relevant to the query. Score 0-1.',
    },
    { threshold: 0.7 }
  );
});
```

### Supported Providers

- **OpenAI** - Requires `OPENAI_API_KEY` environment variable

  ```typescript
  createLLMJudgeClient({
    provider: 'openai',
    model: 'gpt-4',
    temperature: 0.0,
  });
  ```

- **Anthropic** - Requires `ANTHROPIC_API_KEY` environment variable
  ```typescript
  createLLMJudgeClient({
    provider: 'anthropic',
    model: 'claude-3-opus-20240229',
    temperature: 0.0,
  });
  ```

### Judge Configuration

- `rubric` - Evaluation criteria for the LLM judge
- `threshold` - Minimum score (0-1) to pass the evaluation (default: `1.0`)

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
  "passesJudge": {
    "rubric": "correctness",
    "threshold": 0.75
  }
}
```

For custom criteria, provide `{ "text": "..." }` with explicit score-level descriptions to get comparable consistency.

### Best Practices

- Use low temperature (0.0) for consistency
- Prefer built-in rubrics when they fit — they have calibrated 5-point descriptions
- When writing custom rubrics, include score-level descriptions (e.g., "Score 0.75 for...")
- Test rubrics with known good/bad examples
- Set appropriate passing thresholds based on your quality standards
- Consider cost implications (LLM API calls per evaluation)

## Combining Multiple Expectations

A single eval case can declare multiple expectation types at once. The runner evaluates each defined field independently and reports results per expectation:

```typescript
const result = await runEvalDataset(
  { dataset, judgeClient },
  { mcp, testInfo }
);
```

Each eval case uses whichever `expect` fields are defined:

- `expect.response` → Exact match validation
- `expect.schema` → Schema validation
- `expect.containsText` → Text contains validation
- `expect.matchesPattern` → Regex pattern validation
- `expect.passesJudge` → LLM judge evaluation

You can combine multiple expectations for a single test case:

```json
{
  "id": "comprehensive-test",
  "toolName": "get_city_info",
  "args": { "city": "London" },
  "expect": {
    "schema": "city-info",
    "containsText": ["London", "Population"],
    "matchesPattern": ["^## City Information", "Population: [\\d.]+M"],
    "passesJudge": {
      "rubric": "correctness",
      "threshold": 0.7
    }
  }
}
```

## Examples

### Testing Markdown Responses

Many MCP servers return markdown-formatted responses. Here's a complete example:

Dataset JSON (using current field names):

```json
{
  "name": "city-info",
  "cases": [
    {
      "id": "city-info-text",
      "toolName": "get_city_info",
      "args": { "city": "London" },
      "expect": {
        "containsText": [
          "## City Information",
          "**City:** London",
          "### Features"
        ]
      }
    },
    {
      "id": "city-info-format",
      "toolName": "get_city_info",
      "args": { "city": "London" },
      "expect": {
        "matchesPattern": [
          "^## City Information",
          "\\*\\*City:\\*\\* \\w+",
          "\\*\\*Population:\\*\\* [\\d.]+M",
          "Temperature: \\d+°C",
          "\\d{4}-\\d{2}-\\d{2}"
        ]
      }
    }
  ]
}
```

In your test:

```typescript
const dataset = await loadEvalDataset('./data/city-info.json');
const result = await runEvalDataset({ dataset }, { mcp, testInfo });
```

### Choosing the Right Expectation

| Response Type                       | Recommended Expectation | Why                                        |
| ----------------------------------- | ----------------------- | ------------------------------------------ |
| JSON with fixed structure           | Exact Match             | Predictable, structured data               |
| JSON with variable values           | Schema                  | Type-safe validation with flexibility      |
| Markdown/formatted text             | Text Contains           | Order-independent content validation       |
| Text with specific format           | Regex                   | Pattern-based validation                   |
| Deterministic output (help, config) | Snapshot                | Detect any changes to known-good output    |
| Variable data with stable structure | Snapshot + Sanitizers   | Normalize timestamps/IDs before comparison |
| Subjective quality                  | LLM Judge               | Semantic understanding required            |

### Next Steps

- Check out the [Quick Start Guide](./quickstart.md) for getting started
- See the [API Reference](./api-reference.md) for detailed function signatures
- Explore [Examples](../examples) for real-world usage patterns
