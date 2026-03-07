# CLI Commands

The `@gleanwork/mcp-server-tester` CLI provides interactive commands to help you get started quickly and generate eval datasets.

## Table of Contents

- [init - Initialize Project](#init---initialize-project)
- [generate - Generate Eval Dataset](#generate---generate-eval-dataset)
- [login - OAuth Authentication](#login---oauth-authentication)
- [token - Export Tokens for CI/CD](#token---export-tokens-for-cicd)

## `init` - Initialize Project

Create a complete project structure with configuration, tests, and example datasets.

### Usage

```bash
npx mcp-server-tester init [options]
```

### Options

- `-n, --name <name>` - Project name
- `-d, --dir <directory>` - Target directory (default: ".")
- `-h, --help` - Display help

### Interactive Mode

Running `init` without options starts an interactive setup:

```bash
npx mcp-server-tester init

? Project name: my-mcp-tests
? MCP transport type: stdio (local server process)
? Server command (for stdio): node server.js
? Install dependencies now? Yes

✓ Project initialized successfully!

Next steps:
  cd my-mcp-tests
  npm test
```

### What Gets Created

The `init` command creates:

```
my-mcp-tests/
├── playwright.config.ts    # Playwright config with MCP setup
├── tests/
│   └── mcp.spec.ts        # Example test file
├── data/
│   └── example-dataset.json  # Sample eval dataset
├── package.json           # Dependencies and scripts
└── tsconfig.json          # TypeScript configuration
```

### Example Files

**playwright.config.ts:**

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  projects: [
    {
      name: 'mcp-local',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      },
    },
  ],
});
```

**tests/mcp.spec.ts:**

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('lists tools', async ({ mcp }) => {
  const tools = await mcp.listTools();
  expect(tools.length).toBeGreaterThan(0);
});
```

**data/example-dataset.json:**

```json
{
  "name": "example-evals",
  "cases": [
    {
      "id": "example-1",
      "toolName": "example_tool",
      "args": { "input": "test" }
    }
  ]
}
```

## `generate` - Generate Eval Dataset

Interactively create eval datasets by connecting to your MCP server and generating test cases.

### Usage

```bash
npx mcp-server-tester generate [options]
```

### Options

- `-c, --config <path>` - Path to MCP config JSON file
- `-o, --output <path>` - Output dataset path (default: "data/dataset.json")
- `-s, --snapshot` - Use Playwright snapshot testing for all cases
- `-h, --help` - Display help

### Snapshot Mode

Use `--snapshot` to create datasets that use Playwright's built-in snapshot testing:

```bash
npx mcp-server-tester generate --snapshot -o data/snapshot-tests.json
```

This sets `expect.snapshot: "<case-id>"` for each case. When you run tests:

1. **First run**: Playwright captures snapshots to `__snapshots__/` folder
2. **Subsequent runs**: Compares responses against captured snapshots
3. **Update snapshots**: Run `npx playwright test --update-snapshots` when server behavior changes

This is ideal for regression testing - capture known-good responses once, then verify they don't change unexpectedly.

### Interactive Workflow

The `generate` command guides you through creating test cases:

```bash
npx mcp-server-tester generate

# Step 1: Connect to MCP server
? MCP transport type: stdio
? Server command: node server.js
✓ Connected to MCP server
✓ Found 3 tools

# Step 2: Select tool and provide arguments
? Select tool to test: get_weather
? Tool arguments (JSON): { "city": "London" }
✓ Tool called successfully

# Step 3: Preview response
Response preview:
{
  "city": "London",
  "temperature": 20,
  "conditions": "Sunny"
}

# Step 4: Auto-suggested expectations
Suggested expectations:
  Text contains:
    - "London"
    - "temperature"
  Regex patterns:
    - \d+

# Step 5: Configure test case
? Test case ID: weather-london
? Add text contains expectations? Yes
? Add regex expectations? Yes
✓ Added test case "weather-london"

# Step 6: Continue or finish
? Add another test case? No
✓ Dataset saved to data/dataset.json
```

### Features

#### 1. Live MCP Connection

The generator connects to your actual MCP server to:

- List available tools
- Call tools with your arguments
- Show real responses

#### 2. Smart Expectation Suggestions

Based on the response format, the generator suggests:

- **Text Contains** - Key phrases and values from the response
- **Regex Patterns** - Format patterns (dates, numbers, etc.)

#### 3. Response Preview

See the actual tool response before creating expectations:

```
Response preview:
## Weather Report

**City:** London
**Temperature:** 20°C
**Conditions:** Sunny
**Updated:** 2025-01-22
```

#### 4. Append to Existing Datasets

The generator can append to existing dataset files:

```bash
npx mcp-server-tester generate -o data/existing.json

✓ Found existing dataset with 5 cases
? Add new test cases? Yes
```

### Using a Config File

For complex MCP configurations, use a JSON config file:

**mcp-config.json:**

```json
{
  "transport": "stdio",
  "command": "node",
  "args": ["server.js"],
  "env": {
    "NODE_ENV": "test"
  }
}
```

Then generate with:

```bash
npx mcp-server-tester generate -c mcp-config.json
```

### Output Format

The generated dataset is a JSON file:

```json
{
  "name": "generated-dataset",
  "cases": [
    {
      "id": "weather-london",
      "toolName": "get_weather",
      "args": { "city": "London" },
      "expect": {
        "containsText": ["London", "temperature"],
        "matchesPattern": ["\\d+"]
      }
    }
  ]
}
```

### Best Practices

1. **Descriptive IDs** - Use clear, unique test case IDs (e.g., `weather-london`, `search-auth`)
2. **Representative Cases** - Generate cases that cover different scenarios
3. **Review Suggestions** - The auto-suggested expectations are starting points; review and refine them
4. **Version Control** - Commit generated datasets to track test evolution
5. **Organize by Feature** - Create separate datasets for different tool categories

### Example Session

```bash
# Generate dataset for a weather service
npx mcp-server-tester generate -o data/weather-tests.json

# Test case 1: Sunny day
? Tool: get_weather
? Args: { "city": "London" }
? ID: weather-sunny
✓ Added

# Test case 2: Rainy day
? Add another? Yes
? Tool: get_weather
? Args: { "city": "Seattle" }
? ID: weather-rainy
✓ Added

# Test case 3: Invalid city
? Add another? Yes
? Tool: get_weather
? Args: { "city": "InvalidCity123" }
? ID: weather-invalid
✓ Added

✓ Dataset saved with 3 cases
```

### Troubleshooting

#### Connection Errors

If the generator can't connect to your MCP server:

```
✗ Failed to connect to MCP server
Error: Command not found: node server.js
```

Solutions:

- Verify the command is correct
- Check that the server script exists
- Ensure all dependencies are installed
- Try using absolute paths

#### Tool Call Failures

If a tool call fails:

```
✗ Tool call failed
Error: Required parameter 'city' missing
```

Solutions:

- Check the tool's expected argument schema
- Use valid JSON for arguments
- Review tool documentation
- Test with simpler arguments first

## `login` - OAuth Authentication

Authenticate with MCP servers that require OAuth. Tokens are cached locally and automatically refreshed when expired.

### Usage

```bash
npx mcp-server-tester login <server-url> [options]
```

### Arguments

- `<server-url>` - (required) The MCP server URL to authenticate with

### Options

- `--force` - Force re-authentication even if a valid token exists
- `--state-dir <dir>` - Custom directory for token storage
- `--scopes <scopes>` - Comma-separated list of scopes to request (default: all from server metadata)
- `-h, --help` - Display help

### Basic Workflow

```bash
# Authenticate with an MCP server (opens browser for OAuth flow)
npx mcp-server-tester login https://api.example.com/mcp

# Output:
# Authenticating with https://api.example.com/mcp...
# Authentication successful!
# Token expires: 1/15/2025, 3:30:00 PM
# Tokens stored in: ~/.local/state/mcp-tests/api-example-com-mcp/
```

### Force Re-authentication

If you need fresh credentials or your tokens are corrupted:

```bash
npx mcp-server-tester login https://api.example.com/mcp --force

# Output:
# Clearing existing credentials...
# Authenticating with https://api.example.com/mcp...
# Authentication successful!
```

### Requesting Specific Scopes

By default, the CLI requests all scopes advertised by the server's OAuth metadata. To request specific scopes:

```bash
npx mcp-server-tester login https://api.example.com/mcp --scopes read,write

# Output:
# Authenticating with https://api.example.com/mcp...
# Authentication successful!
# Scopes: read, write
# Token expires: 1/15/2025, 3:30:00 PM
```

This is useful when:

- You only need a subset of available scopes
- The server requires explicit scope selection
- You want to test with minimal permissions

### Token Storage

Tokens are stored locally in a secure directory:

| Platform | Default Location                                                                      |
| -------- | ------------------------------------------------------------------------------------- |
| Linux    | `$XDG_STATE_HOME/mcp-tests/<server-key>/` or `~/.local/state/mcp-tests/<server-key>/` |
| macOS    | `~/.local/state/mcp-tests/<server-key>/`                                              |
| Windows  | `%LOCALAPPDATA%\mcp-tests\<server-key>\`                                              |

**Security:**

- Directory permissions: `0700` (owner only)
- File permissions: `0600` (owner read/write only)
- Files stored: `tokens.json`, `client.json`, `server.json`

Use `--state-dir` to override the storage location:

```bash
npx mcp-server-tester login https://api.example.com/mcp --state-dir ./my-tokens
```

### CI/CD Setup

For automated testing in CI, tokens can be provided via environment variables instead of running the interactive login flow.

#### Step 1: Obtain Tokens Locally

```bash
# Run login locally
npx mcp-server-tester login https://api.example.com/mcp

# Find your tokens
cat ~/.local/state/mcp-tests/<server-key>/tokens.json
```

#### Step 2: Add Tokens to CI Secrets

Copy the `access_token` and `refresh_token` values to your CI provider's secrets.

**GitHub Actions:**

```yaml
# .github/workflows/mcp-tests.yml
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      MCP_ACCESS_TOKEN: ${{ secrets.MCP_ACCESS_TOKEN }}
      MCP_REFRESH_TOKEN: ${{ secrets.MCP_REFRESH_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright test
```

#### Step 3: Programmatic Token Injection (Alternative)

Instead of environment variables, you can inject tokens in your test setup:

```typescript snippet=snippets/auth-inject-tokens.ts
// globalSetup.ts
import { injectTokens } from '@gleanwork/mcp-server-tester';

export default async function globalSetup() {
  await injectTokens('https://api.example.com/mcp', {
    accessToken: process.env.MCP_ACCESS_TOKEN!,
    tokenType: 'Bearer',
  });
}
```

### Programmatic Usage

You can also use the OAuth client directly in code:

```typescript snippet=snippets/auth-cli-oauth-client.ts
import { CLIOAuthClient } from '@gleanwork/mcp-server-tester';

const client = new CLIOAuthClient({
  mcpServerUrl: 'https://api.example.com/mcp',
});

// Get a valid access token (cached, refreshed, or new)
const result = await client.getAccessToken();
console.log(`Token: ${result.accessToken}`);
console.log(`Expires: ${new Date(result.expiresAt!).toLocaleString()}`);
```

### Troubleshooting

#### Browser Doesn't Open

If the OAuth browser window doesn't open automatically:

1. Check the terminal for a URL to open manually
2. Ensure you have a default browser configured
3. Try running with `--force` to clear any stale state

#### Token Expired / Invalid

```bash
# Clear and re-authenticate
npx mcp-server-tester login https://api.example.com/mcp --force
```

#### CI Environment Variables Not Working

Ensure the environment variables are named correctly:

- `MCP_ACCESS_TOKEN` - The access token
- `MCP_REFRESH_TOKEN` - The refresh token (optional, for token refresh)

## `token` - Export Tokens for CI/CD

Export stored OAuth tokens in formats suitable for CI/CD environments like GitHub Actions.

### Usage

```bash
npx mcp-server-tester token <server-url> [options]
```

### Arguments

- `<server-url>` - (required) The MCP server URL to get tokens for

### Options

- `-f, --format <format>` - Output format: `env`, `json`, or `gh` (default: `env`)
- `--state-dir <dir>` - Custom directory for token storage
- `-h, --help` - Display help

### Output Formats

#### `env` (default)

Outputs tokens as shell-compatible environment variable assignments:

```bash
npx mcp-server-tester token https://api.example.com/mcp

# Output:
MCP_ACCESS_TOKEN=eyJhbGciOiJSUzI1NiIs...
MCP_REFRESH_TOKEN=dGhpcyBpcyBhIHJlZnJl...
MCP_TOKEN_TYPE=Bearer
MCP_TOKEN_EXPIRES_AT=1736956200000
```

Use with `eval` to set environment variables:

```bash
eval $(npx mcp-server-tester token https://api.example.com/mcp)
```

#### `json`

Outputs tokens as a JSON object:

```bash
npx mcp-server-tester token https://api.example.com/mcp --format json

# Output:
{
  "MCP_ACCESS_TOKEN": "eyJhbGciOiJSUzI1NiIs...",
  "MCP_REFRESH_TOKEN": "dGhpcyBpcyBhIHJlZnJl...",
  "MCP_TOKEN_TYPE": "Bearer",
  "MCP_TOKEN_EXPIRES_AT": 1736956200000
}
```

#### `gh`

Outputs ready-to-paste GitHub CLI commands for setting repository secrets:

```bash
npx mcp-server-tester token https://api.example.com/mcp --format gh

# Output:
# Run these commands to set GitHub Actions secrets:
gh secret set MCP_ACCESS_TOKEN --body "eyJhbGciOiJSUzI1NiIs..."
gh secret set MCP_REFRESH_TOKEN --body "dGhpcyBpcyBhIHJlZnJl..."
gh secret set MCP_TOKEN_TYPE --body "Bearer"
gh secret set MCP_TOKEN_EXPIRES_AT --body "1736956200000"
```

### Workflow: Setting Up GitHub Actions

1. **Authenticate locally:**

   ```bash
   npx mcp-server-tester login https://api.example.com/mcp
   ```

2. **Export tokens for GitHub:**

   ```bash
   npx mcp-server-tester token https://api.example.com/mcp --format gh
   ```

3. **Run the output commands** (or copy/paste each secret manually):

   ```bash
   gh secret set MCP_ACCESS_TOKEN --body "..."
   gh secret set MCP_REFRESH_TOKEN --body "..."
   gh secret set MCP_TOKEN_TYPE --body "Bearer"
   gh secret set MCP_TOKEN_EXPIRES_AT --body "..."
   ```

4. **Configure your workflow:**

   ```yaml
   # .github/workflows/mcp-tests.yml
   jobs:
     test:
       runs-on: ubuntu-latest
       env:
         MCP_ACCESS_TOKEN: ${{ secrets.MCP_ACCESS_TOKEN }}
         MCP_REFRESH_TOKEN: ${{ secrets.MCP_REFRESH_TOKEN }}
         MCP_TOKEN_TYPE: ${{ secrets.MCP_TOKEN_TYPE }}
         MCP_TOKEN_EXPIRES_AT: ${{ secrets.MCP_TOKEN_EXPIRES_AT }}
       steps:
         - uses: actions/checkout@v4
         - run: npm ci
         - run: npx playwright test
   ```

### Error Handling

If no tokens are found for the specified server:

```bash
npx mcp-server-tester token https://api.example.com/mcp

# Output (to stderr):
# No tokens found for https://api.example.com/mcp
#
# Expected location: ~/.local/state/mcp-tests/api.example.com_mcp/tokens.json
#
# Run 'mcp-server-tester login https://api.example.com/mcp' to authenticate first.
```

## Next Steps

- See the [Quick Start Guide](./quickstart.md) for using generated datasets
- Check the [Expectations Guide](./expectations.md) for customizing validations
- Explore [Examples](../examples) for real-world dataset patterns
