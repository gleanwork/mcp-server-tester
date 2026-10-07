# CLI Commands

The `@gleanwork/mcp-server-tester` CLI provides interactive commands to help you get started quickly and generate eval datasets.

The package installs the CLI under two names: `mst` (short for MCP Server Tester) and `mcp-server-tester`. They are the same binary. Once the package is installed in your project, use `npx mst <command>`.

Before the package is installed (for example, running `init` in a new directory), use the scoped package name: `npx @gleanwork/mcp-server-tester@beta init` for 2.0, which these docs describe (without `@beta`, npx fetches 1.x). A bare `npx mst` or `npx mcp-server-tester` with nothing installed fetches unrelated, unscoped npm packages of those names.

## Table of Contents

- [init - Initialize Project](#init---initialize-project)
- [generate - Generate Eval Dataset](#generate---generate-playwright-tests)
- [login - OAuth Authentication](#login---oauth-authentication)
- [token - Export Tokens for CI/CD](#token---export-tokens-for-cicd)
- [run - Run an Eval Config](#run---run-an-eval-config)
- [batch - Run Several Eval Configs](#batch---run-several-eval-configs)
- [open - Open the Reporter](#open---open-the-reporter)
- [cowork setup - Prepare Cowork](#cowork-setup---prepare-cowork)

## `init` - Initialize Project

Create a complete project structure with configuration, tests, and example datasets.

### Usage

```bash
npx @gleanwork/mcp-server-tester init [options]
```

### Options

- `-n, --name <name>` - Project name
- `-d, --dir <directory>` - Target directory (default: ".")
- `-h, --help` - Display help

### Interactive Mode

Running `init` without options starts an interactive setup:

```bash
npx @gleanwork/mcp-server-tester init

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
│   └── example-dataset.json  # Sample eval cases, run on a model
├── package.json           # Dependencies and scripts
└── tsconfig.json          # TypeScript configuration
```

### Example Files

**playwright.config.ts:**

```typescript snippet=snippets/cli-generated-playwright-config.ts
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

```typescript snippet=snippets/cli-generated-test.ts
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

test('lists tools', async ({ mcp }) => {
  const tools = await mcp.listTools();
  expect(tools.length).toBeGreaterThan(0);
});
```

**data/example-dataset.json:**

```json snippet=snippets/cli-generated-dataset.json
{
  "name": "example-eval-dataset",
  "cases": [
    {
      "id": "example-case-1",
      "input": "Replace with something a user would ask",
      "assertions": {
        "toolsTriggered": {
          "calls": [
            {
              "name": "your_tool_name",
              "required": true
            }
          ]
        }
      }
    }
  ]
}
```

## `generate` - Generate Playwright Tests

Interactively record Playwright tests by connecting to your MCP server and calling its tools. Each call becomes a `test()` that calls the tool and asserts on its response with MST's matchers.

### Usage

```bash
npx mst generate [options]
```

### Options

- `-c, --config <path>` - Path to MCP config JSON file
- `-o, --output <path>` - Spec file to write or add to (default: "tests/generated.spec.ts")
- `-s, --snapshot` - Compare every response with a saved snapshot
- `-h, --help` - Display help

### Snapshot Mode

Use `--snapshot` to have every test compare its response with a saved snapshot:

```bash
npx mst generate --snapshot -o tests/snapshot.spec.ts
```

Each test ends with `await expect(result).toMatchToolSnapshot('<test name>')`. When you run tests:

1. **First run**: Playwright writes each missing snapshot and fails that test; run again to compare
2. **Subsequent runs**: Compares responses against captured snapshots
3. **Update snapshots**: Run `npx playwright test --update-snapshots` when server behavior changes

This is ideal for regression testing - capture known-good responses once, then verify they don't change unexpectedly.

### Interactive Workflow

The `generate` command guides you through creating test cases:

```bash
npx mst generate

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

# Step 5: Configure the test
? Test name: weather-london
? Add text contains expectations? Yes
? Add regex expectations? Yes
✓ Added test "weather-london"

# Step 6: Continue or finish
? Add another test? No
✓ Spec saved to tests/generated.spec.ts
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

#### 4. Add to an Existing Spec

The generator can add tests to a spec it wrote earlier, above its `// mst generate adds new tests above this line.` marker. Edits you made to the file stay:

```bash
npx mst generate -o tests/weather.spec.ts

Spec file exists at tests/weather.spec.ts. Add tests to it? Yes
```

A spec without the marker (one you wrote by hand) is left alone: choose a new `--output` file.

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
npx mst generate -c mcp-config.json
```

### Output Format

The generated spec is an ordinary Playwright test file:

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';

// Generated by `mst generate`: each test calls one tool and asserts on its
// response. Edit the tests freely; keep the marker line to add more.
test.describe('MCP tools', () => {
  test('weather-london', async ({ mcp }) => {
    const result = await mcp.callTool('get_weather', { city: 'London' });
    expect(result).not.toBeToolError();
    expect(result).toContainToolText(['London', 'temperature']);
    expect(result).toMatchToolPattern(new RegExp('\\d+'));
  });

  // mst generate adds new tests above this line.
});
```

### Best Practices

1. **Descriptive names** - Use clear, unique test names (e.g., `weather-london`, `search-auth`)
2. **Representative calls** - Record calls that cover different inputs
3. **Review suggestions** - The suggested assertions are starting points; review and refine them in the spec
4. **Version control** - Commit generated specs to track test evolution
5. **Organize by feature** - Write separate specs for different tool categories

### Example Session

```bash
# Generate tests for a weather service
npx mst generate -o tests/weather.spec.ts

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

✓ Spec saved with 3 tests
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
npx mst login <server-url> [options]
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
npx mst login https://api.example.com/mcp

# Output:
# Authenticating with https://api.example.com/mcp...
# Authentication successful!
# Token expires: 1/15/2025, 3:30:00 PM
# Tokens stored in: ~/.local/state/mcp-tests/api-example-com-mcp/
```

### Force Re-authentication

If you need fresh credentials or your tokens are corrupted:

```bash
npx mst login https://api.example.com/mcp --force

# Output:
# Clearing existing credentials...
# Authenticating with https://api.example.com/mcp...
# Authentication successful!
```

### Requesting Specific Scopes

By default, the CLI requests all scopes advertised by the server's OAuth metadata. To request specific scopes:

```bash
npx mst login https://api.example.com/mcp --scopes read,write

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
npx mst login https://api.example.com/mcp --state-dir ./my-tokens
```

### CI/CD Setup

For automated testing in CI, tokens can be provided via environment variables instead of running the interactive login flow.

#### Step 1: Obtain Tokens Locally

```bash
# Run login locally
npx mst login https://api.example.com/mcp

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
npx mst login https://api.example.com/mcp --force
```

#### CI Environment Variables Not Working

Ensure the environment variables are named correctly:

- `MCP_ACCESS_TOKEN` - The access token
- `MCP_REFRESH_TOKEN` - The refresh token (optional, for token refresh)

## `token` - Export Tokens for CI/CD

Export stored OAuth tokens in formats suitable for CI/CD environments like GitHub Actions.

### Usage

```bash
npx mst token <server-url> [options]
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
npx mst token https://api.example.com/mcp

# Output:
MCP_ACCESS_TOKEN=eyJhbGciOiJSUzI1NiIs...
MCP_REFRESH_TOKEN=dGhpcyBpcyBhIHJlZnJl...
MCP_TOKEN_TYPE=Bearer
MCP_TOKEN_EXPIRES_AT=1736956200000
```

Use with `eval` to set environment variables:

```bash
eval $(npx mst token https://api.example.com/mcp)
```

#### `json`

Outputs tokens as a JSON object:

```bash
npx mst token https://api.example.com/mcp --format json

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
npx mst token https://api.example.com/mcp --format gh

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
   npx mst login https://api.example.com/mcp
   ```

2. **Export tokens for GitHub:**

   ```bash
   npx mst token https://api.example.com/mcp --format gh
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
npx mst token https://api.example.com/mcp

# Output (to stderr):
# No tokens found for https://api.example.com/mcp
#
# Expected location: ~/.local/state/mcp-tests/api.example.com_mcp/tokens.json
#
# Run 'mst login https://api.example.com/mcp' to authenticate first.
```

## `run` - Run an Eval Config

Runs an eval config's variants and writes the run summary. See [Evaluation framework](./evaluation-framework.md) for the eval config format.

### Usage

```bash
npx mst run --config ./eval.json [options]
```

### Options

| Option                  | Description                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c, --config <path>`   | The eval config to run (required).                                                                                                                                                                                                              |
| `--variant <name>`      | Run one variant.                                                                                                                                                                                                                                |
| `--plugins <paths...>`  | Plugin modules to load before the run, as well as the eval config's own `plugins`.                                                                                                                                                              |
| `--output-dir <dir>`    | Where to write runs: each run goes in `<dir>/<run id>/`. Default: `.mcp-test-results/<config name>` under the root.                                                                                                                             |
| `--root-dir <dir>`      | Fallback for relative eval config paths, and the default results location. Default: `.`.                                                                                                                                                        |
| `--secrets-file <path>` | A JSON or dotenv-style file of environment values for the run (API keys, `auth.accessTokenEnv` tokens, stdio server environments), kept out of the eval config. A relative path resolves against the root; its values override the environment. |
| `--dry-run`             | Validate the eval config, its plugins and datasets without running anything.                                                                                                                                                                    |

`run` prints a row per variant (cases passed, trial pass rate, MCP calls, host events, tokens, cost, time) and, when there is one, the change since the previous run of the same eval config and variant. It writes `results.json` in the output directory and exits 1 when any case failed. `--dry-run` prints the eval config's name, output directory, datasets and variants as JSON.

## `batch` - Run Several Eval Configs

### Usage

```bash
npx mst batch --config-dir ./configs [options]
npx mst batch --configs a.json b.json [options]
```

### Options

| Option                  | Description                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--configs <paths...>`  | Eval config files to run.                                                                                                                                  |
| `--config-dir <dir>`    | Run every top-level `.json` eval config in a directory, in name order. `--configs` wins when both are given.                                               |
| `--workers <number>`    | How many eval configs run at once. Default: 1.                                                                                                             |
| `--skip-existing`       | Skip an eval config whose result store (`results.store`) already has a completed run of the same resolved eval config. Without a store nothing is skipped. |
| `--output-root <dir>`   | Put each eval config's runs under `<dir>/<file stem>-<hash>/`.                                                                                             |
| `--plugins <paths...>`  | Plugin modules to load before the batch.                                                                                                                   |
| `--root-dir <dir>`      | Fallback for relative eval config paths, and the default results location.                                                                                 |
| `--secrets-file <path>` | A JSON or dotenv-style file of environment values for the run, as for `run`.                                                                               |
| `--dry-run`             | Validate every eval config without running anything.                                                                                                       |

`batch` prints each eval config's outcome and a total, and exits 1 when any eval config failed.

## `open` - Open the Reporter

```bash
npx mst open [--dir .mcp-test-results]
```

Opens the [UI reporter](./ui-reporter.md) the Playwright reporter wrote in a results directory (`-d, --dir`, default `.mcp-test-results`; it opens `latest/index.html`). `mst run` writes `results.json`, not a report.

## `cowork setup` - Prepare Cowork

```bash
npx mst cowork setup
```

Initialises or validates the empty Claude third-party profile that the Cowork host runs in, on macOS. See [Cowork](./cowork.md).

## Next Steps

- See the [Quick Start Guide](./quickstart.md) for using generated datasets
- Check the [Expectations Guide](./expectations.md) for customizing validations
- Explore [Examples](../examples) for real-world dataset patterns
