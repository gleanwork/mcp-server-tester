# SQLite MCP Server Example

This example demonstrates testing the [SQLite MCP Server](https://github.com/johnnyoshika/mcp-server-sqlite-npx) using `@gleanwork/mcp-server-tester`.

## What This Example Demonstrates

- ✅ Testing a real, official MCP server (not a mock)
- ✅ Using `fixturify-project` + `better-sqlite3` for database fixtures
- ✅ Both **direct mode** (specific SQL queries) and **LLM host mode** (natural language)
- ✅ Database operations: queries, schema inspection, joins
- ✅ Schema validation with Zod
- ✅ Programmatic database creation and seeding
- ✅ Automatic test fixture cleanup

## Prerequisites

- Node.js 22+
- npm or pnpm

## Installation

```bash
npm install
```

This will install:

- `@playwright/test` - Test framework
- `@gleanwork/mcp-server-tester` - Evaluation framework
- `fixturify-project` - Test fixture management
- `better-sqlite3` - SQLite database for creating test databases
- `zod` - Schema validation

Note: The SQLite MCP server (`mcp-server-sqlite-npx`) is run via `npx -y` and doesn't need to be installed.

## Running Tests

### Run all tests (direct mode only)

```bash
npm test
```

### Run with LLM host mode tests (requires API key)

```bash
ANTHROPIC_API_KEY=your-key-here npm test
```

### Run in UI mode

```bash
npm run test:ui
```

### Debug mode

```bash
npm run test:debug
```

## How It Works

### Database Fixture Setup

The test uses `fixturify-project` + `better-sqlite3` to create temporary databases:

```typescript
import { Project } from 'fixturify-project';
import Database from 'better-sqlite3';
import path from 'node:path';

const project = new Project('sqlite-test', '1.0.0');
await project.write(); // Create the directory first

const dbPath = path.join(project.baseDir, 'app.db');

// Create database
const db = new Database(dbPath);

// Create schema
db.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE
  );
`);

// Seed data
const insert = db.prepare('INSERT INTO users VALUES (?, ?, ?)');
insert.run(1, 'Alice', 'alice@example.com');
insert.run(2, 'Bob', 'bob@example.com');

db.close();
```

### MCP Server Configuration

The SQLite MCP server is configured to operate on the temporary database:

```typescript
test.use({
  mcpConfig: ({ dbPath }) => ({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'mcp-server-sqlite-npx', dbPath],
  }),
});
```

### Automatic Cleanup

Fixtures handle cleanup automatically:

```typescript
test.extend({
  dbProject: async ({}, use) => {
    const project = new Project('sqlite-test', '1.0.0');
    await project.write();
    // setup database...
    await use(project);
    project.dispose(); // Removes temp directory + database
  },
});
```

## Test Cases

### Direct Mode Tests

Direct SQL queries to specific tools:

```json
{
  "id": "query-all-users",
  "mode": "direct",
  "toolName": "query",
  "args": {
    "sql": "SELECT * FROM users"
  },
  "expect": {
    "schema": "queryResult"
  }
}
```

### LLM Host Mode Tests

Natural language scenarios where the LLM chooses which tool and constructs the query:

```json
{
  "id": "llm-count-users",
  "mode": "mcp_host",
  "scenario": "How many users are in the database?",
  "mcpHostConfig": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514"
  },
  "expect": {
    "toolsTriggered": {
      "calls": [{ "name": "query", "required": true }]
    }
  }
}
```

## Available MCP Tools

The SQLite server provides these tools:

- `query` - Execute SELECT queries
- `execute` - Execute INSERT/UPDATE/DELETE statements
- `list_tables` - List all tables in database
- `describe_table` - Get table schema
- `append_insight` - Store query insights

## Database Schema

The test database includes:

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'user',
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  published BOOLEAN DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

Seeded with:

- 4 users (admin, moderator, regular users)
- 5 posts (mix of published and drafts)

## File Structure

```
sqlite-server/
├── README.md           # This file
├── package.json        # Dependencies and scripts
├── playwright.config.ts # Playwright configuration
├── eval-dataset.json   # Test cases (direct + LLM host)
├── schemas/
│   └── queryResultSchema.ts # Zod schemas for validation
└── tests/
    └── sqlite-eval.spec.ts # Test implementation
```

## Learn More

- [MCP SQLite Server (npx)](https://github.com/johnnyoshika/mcp-server-sqlite-npx)
- [@gleanwork/mcp-server-tester Documentation](../../README.md)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [fixturify-project](https://www.npmjs.com/package/fixturify-project)

## Troubleshooting

### "Server not found" error

Make sure dependencies are installed:

```bash
npm install
```

### "Database is locked" error

Make sure previous test runs completed properly. Clean temp directories:

```bash
# macOS/Linux
rm -rf /tmp/sqlite-test-*
```

### LLM tests skipped

LLM host mode tests require an Anthropic API key:

```bash
export ANTHROPIC_API_KEY="your-key"
```

### Build errors with better-sqlite3

better-sqlite3 is a native module. If you encounter build errors:

```bash
npm rebuild better-sqlite3
```

## Cost Considerations

- **Direct mode**: Free, no API costs
- **LLM host mode**: Incurs API costs per test run (Anthropic Claude: ~$0.003 per 1K tokens)

For cost-effective testing, use direct mode for most tests and LLM host mode for critical user journeys only.
