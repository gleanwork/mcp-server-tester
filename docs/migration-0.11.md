# Migration Guide: v0.10.x to v0.11.0

This guide helps you migrate from the factory-based expectations API to the unified assertion architecture in v0.11.0.

## Overview

**What changed:**

- Factory expectations (`createTextContainsExpectation`, etc.) are **deprecated**
- New **Playwright matchers** (`expect(result).toContainToolText(...)`) are the primary API
- New **validators** for programmatic use (`validateText`, `validateSchema`, etc.)
- Eval datasets use a new unified **`expect` block** format

**Why:**

- Single API for both inline tests and data-driven evals
- Follows Playwright/Jest conventions
- Better TypeScript support and IDE autocomplete

## Quick Reference

| Old (Deprecated)                   | New (Matchers)                                    |
| ---------------------------------- | ------------------------------------------------- |
| `createExactExpectation()`         | `expect(result).toMatchToolResponse(expected)`    |
| `createTextContainsExpectation()`  | `expect(result).toContainToolText(substrings)`    |
| `createRegexExpectation()`         | `expect(result).toMatchToolPattern(patterns)`     |
| `createSchemaExpectation(dataset)` | `expect(result).toMatchToolSchema(schema)`        |
| `createSnapshotExpectation()`      | `expect(result).toMatchToolSnapshot(name)`        |
| `createJudgeExpectation(configs)`  | `expect(result).toPassToolJudge(rubric, options)` |
| N/A                                | `expect(result).toBeToolError()`                  |
| N/A                                | `expect(result).toHaveToolResponseSize(options)`  |
| N/A                                | `expect(result).toSatisfyToolPredicate(fn)`       |

## Migrating Inline Tests

### Before (v0.10.x)

```typescript
import { test } from '@gleanwork/mcp-server-tester';

test('weather tool returns data', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });

  // Manual assertions on raw response
  const text = result.content[0].text;
  expect(text).toContain('temperature');
  expect(text).toContain('London');
});
```

### After (v0.11.0)

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester';

test('weather tool returns data', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });

  // Use matchers directly on the result
  expect(result).toContainToolText(['temperature', 'London']);
  expect(result).not.toBeToolError();
});
```

### More Examples

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

const WeatherSchema = z.object({
  city: z.string(),
  temperature: z.number(),
  conditions: z.string(),
});

test('comprehensive weather validation', async ({ mcp }) => {
  const result = await mcp.callTool('get_weather', { city: 'London' });

  // Schema validation
  expect(result).toMatchToolSchema(WeatherSchema);

  // Text contains
  expect(result).toContainToolText(['temperature', 'conditions']);

  // Pattern matching
  expect(result).toMatchToolPattern([/\d+°[CF]/, /London/i]);

  // Error checking
  expect(result).not.toBeToolError();

  // Response size
  expect(result).toHaveToolResponseSize({ maxBytes: 10000 });
});

test('LLM judge evaluation', async ({ mcp }) => {
  const result = await mcp.callTool('summarize', { text: 'Long article...' });

  // LLM-as-judge (requires ANTHROPIC_API_KEY)
  await expect(result).toPassToolJudge(
    'The summary should capture the main points concisely',
    { passingThreshold: 0.8 }
  );
});
```

## Migrating Eval Datasets

### Before (v0.10.x Dataset Format)

```json
{
  "cases": [
    {
      "id": "weather-london",
      "toolName": "get_weather",
      "args": { "city": "London" },
      "expectedTextContains": ["temperature", "conditions"],
      "expectedSchemaName": "WeatherResponse",
      "expectedRegex": ["\\d+°[CF]"]
    }
  ]
}
```

### After (v0.11.0 Dataset Format)

```json
{
  "cases": [
    {
      "id": "weather-london",
      "toolName": "get_weather",
      "args": { "city": "London" },
      "expect": {
        "containsText": ["temperature", "conditions"],
        "schema": "WeatherResponse",
        "matchesPattern": ["\\d+°[CF]"],
        "isError": false
      }
    }
  ]
}
```

### Dataset Field Mapping

| Old Field              | New Field (inside `expect`) |
| ---------------------- | --------------------------- |
| `expectedExact`        | `expect.response`           |
| `expectedTextContains` | `expect.containsText`       |
| `expectedRegex`        | `expect.matchesPattern`     |
| `expectedSchemaName`   | `expect.schema`             |
| `expectedSnapshot`     | `expect.snapshot`           |
| `judgeConfigId`        | `expect.passesJudge`        |
| N/A                    | `expect.isError`            |
| N/A                    | `expect.responseSize`       |

### New `expect.passesJudge` Format

```json
{
  "id": "search-quality",
  "toolName": "search",
  "args": { "query": "MCP protocol" },
  "expect": {
    "passesJudge": {
      "rubric": {
        "text": "Results should be relevant to MCP protocol documentation"
      },
      "threshold": 0.8
    }
  }
}
```

## Migrating Eval Runner Code

### Before (v0.10.x)

```typescript
import {
  loadEvalDataset,
  runEvalDataset,
  createTextContainsExpectation,
  createSchemaExpectation,
  createRegexExpectation,
  createJudgeExpectation,
  createLLMJudgeClient,
} from '@gleanwork/mcp-server-tester';

test('run evals', async ({ mcp, testInfo, expect }) => {
  const dataset = await loadEvalDataset('./evals.json', {
    schemas: { WeatherResponse: WeatherSchema },
  });

  const judgeClient = createLLMJudgeClient({
    provider: 'openai',
    model: 'gpt-4',
  });

  const result = await runEvalDataset(
    {
      dataset,
      expectations: {
        textContains: createTextContainsExpectation(),
        schema: createSchemaExpectation(dataset),
        regex: createRegexExpectation(),
        judge: createJudgeExpectation(judgeConfigs),
      },
      judgeClient,
    },
    { mcp, testInfo, expect }
  );

  expect(result.passed).toBe(result.total);
});
```

### After (v0.11.0)

```typescript
import {
  loadEvalDataset,
  runEvalDataset,
  createJudge,
} from '@gleanwork/mcp-server-tester';

test('run evals', async ({ mcp }) => {
  const dataset = await loadEvalDataset('./evals.json', {
    schemas: { WeatherResponse: WeatherSchema },
  });

  // Optional: Configure judge for LLM evaluations
  const judge = createJudge({
    provider: 'claude',
    model: 'claude-sonnet-4-20250514',
  });

  const result = await runEvalDataset(
    { dataset, schemas: { WeatherResponse: WeatherSchema }, judge },
    { mcp }
  );

  expect(result.passed).toBe(result.total);
});
```

## Using Validators Programmatically

For cases where you need validation without Playwright matchers:

```typescript
import {
  validateText,
  validateSchema,
  validatePattern,
  validateError,
  validateSize,
  validateResponse,
} from '@gleanwork/mcp-server-tester';

// Each validator returns { pass: boolean, message: string }

const textResult = validateText(response, ['temperature', 'London']);
if (!textResult.pass) {
  console.log('Text validation failed:', textResult.message);
}

const schemaResult = validateSchema(response, WeatherSchema);
if (!schemaResult.pass) {
  console.log('Schema validation failed:', schemaResult.message);
}

const patternResult = validatePattern(response, [/\d+°[CF]/]);
if (!patternResult.pass) {
  console.log('Pattern validation failed:', patternResult.message);
}
```

## Backwards Compatibility

The old dataset fields (`expectedTextContains`, `expectedSchemaName`, etc.) still work in v0.11.0 but are deprecated. The eval runner automatically migrates old fields to the new format internally.

**Recommended:** Update your datasets to the new `expect` block format to:

- Get better IDE support
- Use new features like `isError` and `responseSize`
- Prepare for v1.0 when deprecated fields will be removed

## Common Migration Patterns

### Pattern 1: Simple Text Validation

```typescript
// Before
const text = result.content[0].text;
expect(text).toContain('hello');

// After
expect(result).toContainToolText('hello');
```

### Pattern 2: Multiple Substrings

```typescript
// Before
const text = result.content[0].text;
expect(text).toContain('hello');
expect(text).toContain('world');

// After
expect(result).toContainToolText(['hello', 'world']);
```

### Pattern 3: Schema Validation

```typescript
// Before (manual extraction + zod)
const data = JSON.parse(result.content[0].text);
const parsed = MySchema.safeParse(data);
expect(parsed.success).toBe(true);

// After
expect(result).toMatchToolSchema(MySchema);
```

### Pattern 4: Error Checking

```typescript
// Before
expect(result.isError).not.toBe(true);

// After
expect(result).not.toBeToolError();

// Or check for specific error
expect(result).toBeToolError('Invalid parameter');
```

### Pattern 5: Combining Assertions

```typescript
// All matchers can be chained on the same result
const result = await mcp.callTool('get_user', { id: '123' });

expect(result).not.toBeToolError();
expect(result).toMatchToolSchema(UserSchema);
expect(result).toContainToolText(['email', 'name']);
expect(result).toHaveToolResponseSize({ maxBytes: 5000 });
```

## Type Imports

### Before

```typescript
import type {
  EvalExpectation,
  ExpectationResult,
} from '@gleanwork/mcp-server-tester';
```

### After

```typescript
import type {
  ValidationResult,
  TextValidatorOptions,
  SchemaValidatorOptions,
  JudgeMatcherOptions,
} from '@gleanwork/mcp-server-tester';
```

## Need Help?

- See the [Expectations Guide](./assertions.md) for complete matcher documentation
- Check [API Reference](./api-reference.md) for function signatures
- File issues at [GitHub](https://github.com/gleanwork/mcp-server-tester/issues)
