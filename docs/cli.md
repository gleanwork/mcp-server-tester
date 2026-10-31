# CLI Commands

The `@gleanwork/mcp-server-tester` CLI provides interactive commands to help you get started quickly and generate eval datasets.

The package installs the CLI under two names: `mst` (short for MCP Server Tester) and `mcp-server-tester`. They are the same binary. Once the package is installed in your project, use `npx mst <command>`.

Before the package is installed (for example, running `init` in a new directory), use the scoped package name: `npx @gleanwork/mcp-server-tester@beta init` for 2.0, which these docs describe (without `@beta`, npx fetches 1.x). A bare `npx mst` or `npx mcp-server-tester` with nothing installed fetches unrelated, unscoped npm packages of those names.

## Table of Contents

- [init - Initialize Project](#init---initialize-project)
- [generate - Generate Eval Dataset](#generate---generate-playwright-tests)
- [login - OAuth Authentication](#login---oauth-authentication)
- [token - Export Tokens for CI/CD](#token---export-tokens-for-cicd)
- [datasets - Find Plugin Datasets](#datasets---find-plugin-datasets)
- [judges - Find Judges](#judges---find-judges)
- [label - Label Judge Verdicts](#label---label-judge-verdicts)
- [auth - Sign In to Connector Servers](#auth---sign-in-to-connector-servers)
- [run - Run an Eval Config](#run---run-an-eval-config)
- [grade - Grade a Stored Run Again](#grade---grade-a-stored-run-again)
- [optimize - Improve Tool Metadata](#optimize---improve-tool-metadata)
- [runs - Detached Runs](#runs---detached-runs)
- [batch - Run Several Eval Configs](#batch---run-several-eval-configs)
- [open - Open a Run's Report](#open---open-a-runs-report)
- [cowork setup - Prepare Cowork](#cowork-setup---prepare-cowork)
- [env setup - Prepare an Environment](#env-setup---prepare-an-environment)

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

# Step 4: Auto-suggested assertions
Suggested assertions:
  Text contains:
    - "London"
    - "temperature"
  Regex patterns:
    - \d+

# Step 5: Configure the test
? Test name: weather-london
? Add text contains assertions? Yes
? Add regex assertions? Yes
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

#### 2. Smart Assertion Suggestions

Based on the response format, the generator suggests:

- **Text Contains** - Key phrases and values from the response
- **Regex Patterns** - Format patterns (dates, numbers, etc.)

#### 3. Response Preview

See the actual tool response before creating assertions:

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

## `datasets` - Find Plugin Datasets

Lists the [datasets](./evaluation-framework.md#plugin-datasets-and-snapshots) plugins provide, shows what one holds, and pulls one into a dataset file to read, diff or freeze.

### Usage

```bash
npx mst datasets --plugins @acme/mst-plugin
npx mst datasets show acme/dataset/info-seeking --plugins @acme/mst-plugin
npx mst datasets pull acme/dataset/info-seeking --plugins @acme/mst-plugin --out datasets/info-seeking.json
npx mst datasets pull acme/dataset/info-seeking --plugins @acme/mst-plugin --source live
npx mst datasets pull acme/dataset/info-seeking --plugins @acme/mst-plugin --snapshot 2026-10-01
```

```text
acme/dataset/action-taking  32 cases   snapshot 2026-10-06
acme/dataset/info-seeking   50 cases   snapshot 2026-10-06  tags: source:correctness, tool:*  Questions with one right answer.
```

The list shows what each dataset's `describe()` reports, without loading cases; a dataset without one shows its description only. A plugin dataset source that takes options is listed too, marked as one to use in an eval config. `show` loads the cases and prints the snapshot read, the case count, the content hash of the cases (the one `run.json` records), tag and judge counts, and the case ids. `pull` writes the cases as the plugin returned them, a canonical dataset file an eval config can list as `./datasets/info-seeking.json`; it hashes the same as the plugin's dataset. Without `--out` it prints to stdout.

### Options

| Option                   | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `--plugins <modules...>` | Plugin modules to look in.                                           |
| `-c, --config <path>`    | Look in an eval config's plugins instead (plus any `--plugins`).     |
| `--snapshot <id>`        | `show`, `pull`: a snapshot. Default: the plugin's latest.            |
| `--source <source>`      | `show`, `pull`: `snapshot` (the default) or `live`.                  |
| `-o, --out <file>`       | `pull`: write here. Default: stdout.                                 |
| `--json`                 | `datasets`, `show`: print JSON.                                      |
| `--root-dir <dir>`       | Where relative plugin paths resolve. Default: the working directory. |

## `judges` - Find Judges

Lists the judges an eval config can use, built-in and from plugins, and shows what one requires and the options it takes.

### Usage

```bash
npx mst judges                                 # built-in judges
npx mst judges --plugins @acme/mst-plugin      # plus the plugin's
npx mst judges show acme/judge/completeness --plugins @acme/mst-plugin
npx mst judges show rubric --json
```

```text
acme/judge/completeness         judge     requires case.expected.answer  Did the answer cover every point of the expected answer?
rubric                          judge                                    An LLM grades the answer against a rubric: ...
acme/pairwise-judge/preference  pairwise                                 Which answer would the asker rather get?
```

A `judge` scores each trial; a `pairwise` judge compares each variant's trial with the baseline's. `show` prints the description, the case or trial fields the judge `requires` (a case without them is recorded as skipped), whether a pairwise judge also compares with the runs swapped, and its options as JSON Schema: what an eval config's `judges` entry may set besides `type`. Plugins add `description` to a judge or pairwise judge for these commands.

Options: `--plugins <modules...>`, `-c, --config <path>` (an eval config's plugins), `--json`, `--root-dir <dir>`, as for [`datasets`](#datasets---find-plugin-datasets).

### `judges check` - Measure a Judge Against Labels

Measures how well a judge agrees with people's [labels](#label---label-judge-verdicts), and says whether it is usable. See [ADR 0009](./adr/0009-users-calibrate-judges-against-their-own-labels.md). [Built-in judges](./judges.md) has the built-in judges' numbers on MST's calibration set.

```bash
npx mst judges check <run...> --judge correctness
npx mst judges check 7f3c2a 9b1d04 --judge acme/judge/completeness --json
npx mst judges check <run> --judge correctness --split dev   # while changing the judge; not recorded
```

```text
correctness  (identity 3f2a9c1be0d4, claude-sonnet-4-5)
  80 test labels from 2 runs
  people   42 fail, 38 pass
  TPR      0.95 (0.84 to 0.99)  the judge failed 40 of the 42 trials people failed
  TNR      1.00 (0.91 to 1.00)  the judge passed 38 of the 38 trials people passed
  kappa    0.95
  unknown  0 of 80 (0%)
  usable   yes
  recorded .mcp-test-results/my-eval/calibrations/correctness/3f2a9c1b….json
  disagreements (2):
    6ff33b baseline lookup-order #0: judge pass, label fail: The answer gives the order's status...
```

`--judge` is the judge's name as its labels have it: a `rubric` judge's rubric, else its reference. `<run...>` takes what [`label`](#label---label-judge-verdicts) does.

For a pointwise judge, a failing trial is the positive class. TPR is the share of the trials people failed that the judge also failed; TNR is the share of the trials people passed that it also passed. Each has a 95% Wilson interval. Kappa is Cohen's. `unknown` counts the labeled trials the judge couldn't decide: it answered unknown, or skipped them.

A judge is **usable** when it gave a verdict on at least 15 failing and 15 passing labels (`--min-labels`), the lower bound of both TPR and TNR is at least 0.8 (`--min-rate`), and it answered `unknown` on at most 10% of the labeled trials (`--max-unknown`). The output says which part fails.

For a pairwise judge, it reports the share of labels its preference matches, and how often the judge and people called a tie. A pairwise judge has no usable gate.

The check uses `test` labels unless `--split dev` or `--split all` says otherwise. Each judge identity in the runs is checked on its own, newest run first, because a changed judge must be measured again. A label counts once for each identity: a run given twice is read once, and when a run and its regrades gave the same identity's verdict for a label, only the newest one's counts. For a `test` check, it writes the calibration record `calibrations/<judge>/<identity>.json` in each eval's directory, replacing an earlier one (`--no-record` doesn't). A judge without a version MST can see change (one that declares none, in a plugin that has none) is marked **unversioned**: its calibration can't tell when it goes stale, so set the judge's `version`. Verdicts from before MST recorded judge identities can be checked but not recorded: grade the run again (`mst grade`).

A run's report shows each pointwise judge's pass rate per variant in its _Judges_ table, with the calibration of the identity that graded it: _calibrated_, _not usable_, _stale_ (the judge changed since it was checked), _not calibrated_, or _mixed versions_. With a usable calibration, it also shows the pass rate corrected for the judge's errors (Rogan-Gladen, with Lang and Reiczigel's 95% interval over both the run's trials and the calibration's labels, which stays wider than zero when the judge agreed with every label). The raw rate is always shown. `judges check` rebuilds the reports of the runs it read, and `mst open` rebuilds a report built before the eval's newest calibration.

Options: `--judge <name>` (required), `--split <test|dev|all>`, `--min-labels <n>`, `--min-rate <rate>`, `--max-unknown <rate>`, `--no-record`, `--json`, `-d, --dir <directory>`.

## `label` - Label Judge Verdicts

A label is a person's answer to a judge's question for one trial: `pass` or `fail`. For a pairwise judge, it is their preference for one case: `baseline`, `candidate` or `tie`. Labels are kept in the run, so that a judge can be measured against them. See [ADR 0009](./adr/0009-users-calibrate-judges-against-their-own-labels.md).

### Usage

```bash
npx mst label <run> --judge correctness      # label on a page, one trial at a time
npx mst label export <run> -o labels.csv     # a row for each judge verdict, to fill in
npx mst label import <run> labels.csv        # the filled-in labels, into the run
npx mst label export <run> --format judgekeeper --judge correctness > records.jsonl
```

`<run>` is a run directory, an eval directory (its latest run), or a run ID or its short form (`7f3c2a`) under `--dir` (default `.mcp-test-results`).

With a run and `--judge`, `mst label` (or `mst label page`) serves a page on this machine and opens it in a browser. The page shows one of the judge's trials at a time: the case's input, its reference answer when it has one, the calls the client made, and its answer. It doesn't show the judge's verdict or name the variant, and it mixes the variants' trials in a fixed order, so that neither sways you. The calls a trial made can still show which variant ran it, when the variants use different servers.

Above the trials, the page shows the judge's question: a built-in rubric's text, or a custom rubric's. For another judge, MST doesn't know the question, and the page says so: give it with `--question`, so that your labels answer the question the judge answers. Press `P` or `F` to label a trial `pass` or `fail`, and add a note if you like. For a pairwise judge, the page shows each variant's side of a case as A and B, in an order fixed for the case, and you press `A`, `B` or `T` (tie). Each side shows the trial the judge compared: the last trial the variant ran. Each label is stored as soon as you give it, checked as `import` checks one. The page starts at the first trial without a label and shows the labels you gave before, which you can change. Press Ctrl+C in the terminal when you're done.

The page binds to 127.0.0.1 on a random path, so other pages in your browser can't read the run or store labels. A run stored with `redactStoredResponses` has no answers to show, so `mst label` refuses it. Page options: `--judge <name>` (required: the judge's name in results), `--split <test|dev>` (the split for a case that has no labels yet; a case's labels all share the split its first label got), `--labeler <name>`, `--question <text>`, `--port <n>`, `--no-open` (print the address only), `-d, --dir <directory>`.

`export` writes a row for each verdict the run's judges gave: a trial a judge failed on (an API error, say) has no verdict, so it has no row, unless the run keeps a label for it from before (a regrade the judge then failed on). Each row has the judge's name in results (a `rubric` judge's rubric, else its reference), the variant, the case, the trial (from 0) or, for a pairwise judge, the `baseline` variant, the `split`, the judge's `verdict`, and the case's input and the trial's answer. Rows that already have a label carry it, with its `labeler`, `labeledAt` and `note`. Fill in the `label` column and import the file back. A run stored with `redactStoredResponses` has no answers to export, and the command says so: to label from answers, collect with `"redactStoredResponses": false`.

`import` checks every label against the run before it writes any. Each label must name a verdict the run has (a judge that failed on a trial gave none, and a criterion must be one its judge reported), with a value its judge can give (`pass`/`fail`, or `true`/`false`, `yes`/`no`, `1`/`0`), and no two rows may label the same verdict. Rows without a label are skipped, and so is a row that gives a label the run keeps for a verdict it no longer has, unchanged, so an exported sheet imports back. A label replaces an earlier label for the same verdict and keeps its split, unless the row gives one. Labels are written to `labels/` in the run directory, and a regrade or resume of the run carries them over.

The split says what a label is for: `test` labels measure a judge, and `dev` labels are the ones to read while changing it. A label that gives no split gets its case's: half the cases, chosen by a hash of the case ID, are `test`. All of a case's trials and variants share its split, so a case read while changing a judge never measures it.

Formats (`--format`; the default comes from the file's name, else `csv`):

- `csv` and `jsonl`: the columns above. CSV cells that a spreadsheet would run as a formula start with `'`, which `import` removes.
- `judgekeeper`: [judgekeeper](https://github.com/judgekeeper/judgekeeper)'s records. Each pass or fail verdict is an `LLM` record, and each label a `HUMAN` record, with `target_id` `<variant>/<case-id>/<trial>`. `import` reads the `HUMAN` records. Pairwise verdicts are left out.

Options: `--judge <name...>` (export only these judges), `-o, --output <file>`, `--labeler <name>` (import: who gave labels that don't say; the default is your user name), `-d, --dir <directory>`.

## `auth` - Sign In to Connector Servers

Signs in once to every connector server an eval config uses. After that, each `mst run` refreshes the tokens itself and deletes them when it ends: no `.env`, no copied tokens.

A connector server names a plugin's connector instead of a transport:

```json
{
  "plugins": ["@acme/mst-plugin"],
  "variants": [
    {
      "name": "sonnet",
      "model": "claude-sonnet-4-5"
    },
    {
      "name": "opus",
      "model": "claude-opus-4-6"
    }
  ],
  "servers": {
    "acme": {
      "connector": "acme/connector/acme"
    },
    "slack": {
      "connector": "acme/connector/slack"
    },
    "gmail": {
      "connector": "acme/connector/gmail"
    }
  }
}
```

The plugin's connector says where the server is, how to sign in, and how the client reaches it (for example, through the [dry-run proxy](./cowork.md#dry-run-proxy), which blocks writes). See [docs/design/auth-and-connectors.md](./design/auth-and-connectors.md).

### Usage

```bash
npx mst auth --config ./eval.json [--server <labels...>] [--force]
npx mst auth status --config ./eval.json
npx mst auth revoke --config ./eval.json --server <labels...>
```

`auth` signs in to each grant that has none: it opens the browser (or prints a device code), stores the grant, then connects once and checks that the server lists at least the connector's `minTools`, so an under-scoped sign-in fails now and not halfway through a run. Connectors that share a grant (for example Gmail, Drive and Calendar) sign in once, with all their scopes. A valid grant is left alone unless you pass `--force`.

`auth status` changes nothing and exits 1 when a server is not signed in. `auth revoke` revokes the grant at the provider (when it has a revocation endpoint) and deletes it.

### Options

| Option                 | Description                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c, --config <path>`  | The eval config (required).                                                                                                                                                     |
| `--server <labels...>` | Only these servers.                                                                                                                                                             |
| `--force`              | Sign in again even if a valid grant exists.                                                                                                                                     |
| `--store <store>`      | Where grants are kept: a directory, or a plugin's credential store, `<namespace>/credential-store/<name>`. Default: `$MST_CREDENTIALS_DIR`, else `~/.mcp-server-tester/grants`. |
| `--plugins <paths...>` | Plugin modules to load, as well as the eval config's own `plugins`.                                                                                                             |

Grants are 0600 files in a 0700 directory. Refresh tokens stay there; access tokens reach a run only through private files it deletes when it ends (also on Ctrl-C, SIGTERM or SIGHUP; files left by a run that was killed outright are removed by the next run), or run-private environment variables. Neither appears in results, logs or the client's settings. If a run needs a server that is not signed in, it stops before any client starts and prints the `mst auth` command to run.

## `run` - Run an Eval Config

Runs an eval config's variants and writes the run summary. See [Evaluation framework](./evaluation-framework.md) for the eval config format.

### Usage

```bash
npx mst run --config ./eval.json [options]
```

### Options

| Option                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c, --config <path>`    | The eval config to run (required).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--variant <names...>`   | Run only these variants, in the config's order. A name the config doesn't have fails the run before anything starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--case <ids...>`        | Run only these case ids, instead of the config's `filterTags` and `maxCases`. An id in no dataset fails the run before anything starts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--filter-tag <tags...>` | Run the cases with any of these tags, instead of the config's `filterTags`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--max-cases <n>`        | Cases per dataset (after the tags), instead of the config's `maxCases`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--trials <n>`           | Trials per case, instead of the config's `trials` and each case's own.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `--plugins <paths...>`   | Plugin modules to load before the run, as well as the eval config's own `plugins`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--output-dir <dir>`     | The eval's directory: each run goes in `<dir>/runs/<run-id>/`, beside the eval's `latest.json`. Default: `.mcp-test-results/<config name>` under the root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--root-dir <dir>`       | Fallback for relative eval config paths, and the default results location. Default: `.`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--secrets-file <path>`  | A JSON or dotenv-style file of environment values for the run (API keys, `auth.accessTokenEnv` tokens, stdio server environments), kept out of the eval config. A relative path resolves against the root; its values override the environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--dry-run`              | Validate the eval config, its plugins and datasets without running anything.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `--no-grade`             | Collect the trials without grading them: no assertions, judges or pairwise judges run. Grade the run later with [`grade`](#grade---grade-a-stored-run-again). Requires `"redactStoredResponses": false`, so the traces keep what graders read. Exits 1 if a trial failed to collect, naming it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--results <store>`      | Also keep the run in this result store, instead of the eval config's `results.store`: `gs://<bucket>/<prefix>`, `file:<dir>` (relative to the working directory), or a plugin's store, `<namespace>/result-store/<name>`. With `--resume`, a run that isn't local is fetched from it. See [Result stores](./evaluation-framework.md#result-stores).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--no-report`            | Don't write the run's report. `mst open` writes it when it opens the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--store <store>`        | Where connector servers' grants are (see [`auth`](#auth---sign-in-to-connector-servers)): a directory, or a plugin's credential store, `<namespace>/credential-store/<name>`. Default: `$MST_CREDENTIALS_DIR`, else `~/.mcp-server-tester/grants`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--grade-env`            | After collecting, grade the run in its environment (as [`grade --env`](#grading-in-an-environment)), with the same `--env-option`s, instead of on this machine. Needs `--env`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--detach`               | Run the coordinator on a machine the environment creates, and return: this machine can go offline. Needs `--env`, a result store other machines reach, and, for connector servers, a shared `--store`. See [Detached runs](#runs---detached-runs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--env <name>`           | Where to collect the trials: `local` (the default, in the `mst run` process), `docker` (containers from MST's Linux Cowork or ChatGPT image, by the eval's client; see [Cowork in Docker](./cowork-docker.md) and [ChatGPT in Docker](./chatgpt-docker.md)), or a plugin environment, `<namespace>/env/<name>`, which runs the trials on `shards` machines, a case's variants and trials on one. A trial whose shard ended without it is missing: its case is incomplete, the run is partial, and `run` exits 1. Connector servers and variants with tool metadata run there too: each worker launches the connectors itself and gets their access tokens from this machine.                                                                                              |
| `--env-option <k=v>`     | An environment option; repeat the flag for more. MST owns `shards` (a positive integer, default 1; `local` runs one) and `keep` (`never`, `failed` or `always`); the environment's schema checks the rest. Options are recorded in `run.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `--resume <run>`         | Complete a run whose shards ended early, or whose client never submitted some trials (a batch blocked after a failed reset): collect only its missing trials, in the environment it ran in (its `shards`, `keep` and options, unless `--env` and `--env-option` say otherwise), then grade the whole run again into its own directory, every other trial from its stored trace; a run collected with `--no-grade` stays ungraded. Only an environment collects trials, so a run collected locally (a macOS Cowork batch, say) needs `--env`, or its cases run again with `--case`. Needs the run stored with `"redactStoredResponses": false`, as `grade` does. Can't take `--variant`, `--case`, `--filter-tag`, `--max-cases`, `--trials`, `--dry-run` or `--no-grade`. |

A run narrowed by any of `--variant`, `--case`, `--filter-tag`, `--max-cases` or `--trials` is a **partial run**. Its summary has `partial: true` and the `selection` that narrowed it, and the run prints `Partial run (--case e2e-0011, --trials 1): not compared with full runs`. A partial run is compared only with earlier partial runs narrowed the same way, never becomes the result store's `latest.json`, and is never resumed by `--skip-existing`. `--case` replaces the tags and the case cap; `--filter-tag` and `--max-cases` replace the config's. When `--variant` leaves out the baseline, the run says that no variant is compared with it.

`run` prints a row per variant (cases passed, the report's pass rate and its likely range at 95% confidence, MCP calls, client events, tokens, cost, time) and, when there is one, the change since the previous run of the same eval config and variant, from the report's paired test. A range wider than ±10 points is marked `!`, with the trials per case to run next. It writes the run's directory (`runs/<run-id>/` under the eval's output directory; see [What a run leaves behind](./evaluation-framework.md#what-a-run-leaves-behind)), prints its path, and exits 1 when any case failed. `--dry-run` prints the eval config's name, output directory, datasets, variants and environment (`env`: its name, shards, and any `keep` or options) as JSON.

## `grade` - Grade a Stored Run Again

Grades the traces a run stored with the eval config's graders as they are now (assertions, judges and pairwise judges), without running the client again, and writes the scores as a new run next to it: `<run-id>.g2`, then `.g3`, and so on.

### Usage

```bash
npx mst run --config ./eval.json --no-grade   # collect now
npx mst grade 7f3c2a --config ./eval.json     # grade later, as often as the graders change
```

`<run>` is a run directory (relative to `--root-dir`), a run ID, or its short form (the last six characters, with any `.g<n>`) among the eval's runs.

### Options

| Option                  | Description                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c, --config <path>`   | The eval config the run ran (required). Its graders and datasets are read again.                                                                                                                                                                                            |
| `--plugins <paths...>`  | Plugin modules to load, as well as the eval config's own `plugins`.                                                                                                                                                                                                         |
| `--output-dir <dir>`    | The eval's directory, if `run` was given one. Default: `.mcp-test-results/<config name>`.                                                                                                                                                                                   |
| `--root-dir <dir>`      | Fallback for relative eval config paths, and the default results location. Default: `.`.                                                                                                                                                                                    |
| `--secrets-file <path>` | A JSON or dotenv-style file of environment values, as for `run` (for example judge API keys).                                                                                                                                                                               |
| `--no-report`           | Don't write the regrade's report.                                                                                                                                                                                                                                           |
| `--results <store>`     | Also keep the regrade in this result store, instead of the eval config's, as for `run`. A run that isn't local is fetched from the store (`--results`, else the eval config's), checked against its manifest. See [Result stores](./evaluation-framework.md#result-stores). |
| `--env <name>`          | Grade in this environment: `local` (the default, in this process), `docker`, or a plugin environment (`<namespace>/env/<name>`). See [Grading in an environment](#grading-in-an-environment).                                                                               |
| `--env-option <k=v>`    | An environment option; repeat for more: `shards=N`, `keep=never\|failed\|always`, or the environment's own, as for `run`.                                                                                                                                                   |
| `--detach`              | Grade from a coordinator machine the environment creates, and return, as for `run`. The run must be in the result store.                                                                                                                                                    |
| `--resume`              | Finish a graded run's grading: keep every verdict it has, and run only the judges and pairwise judges that failed to run. See [Finishing a grading](#finishing-a-grading).                                                                                                  |

The datasets are loaded again, so each case's `expected` and judges are the dataset's current ones; `run.json` records their content hashes. Every variant and case the run stored must still be in the eval config and its datasets. A trial that failed when it ran stays failed and isn't judged. A trial a grader couldn't score (`phases.grade: partial`, `gradingError`) is graded again: finishing those is what a regrade is for. No client starts, so grading needs no connector tokens.

The regrade's `run.json` has `gradedFrom`, the run whose traces it graded, and the same `phases.collect` as that run: a regrade of a run that stopped early (`collect: failed` or `partial`) still covers only what it collected. Its summary has `collectedAt`, when those traces were collected, and compares with the same traces' last grading, or else with a graded run collected before them, never a newer one. A regrade becomes the eval's `latest.json` only when it is full, its run collected every variant, and no run collected later is the latest: regrading an older run leaves the newer run the latest. `grade` prints what `run` prints, and exits 1 when any case failed.

A `--no-grade` run's `run.json` has `phases.grade: skipped`, also in the copy saved while it runs. Its `summary.json` has no pass rate, only `total`, `collected` and `failedToCollect` cases, and its report says it isn't graded.

A run stored with redacted traces (the default, `redactStoredResponses`) can't be graded again: collect with `"redactStoredResponses": false`.

### Finishing a grading

A judge that times out, or a grade shard that's lost, leaves its trials or comparisons without a verdict, and the run `phases.grade: partial`. `mst grade --resume` grades just those, from the graded run (the regrade `<run-id>.g<n>`, or a run graded as it ran):

```bash
npx mst grade 3fa9c1.g2 --config ./eval.json --resume
```

- **Each verdict is kept, judge by judge.** A trial whose first judge passed and whose second timed out runs only the second. A case's pairwise judges are kept or run the same way. Assertions run again: they're cheap, and give the same result.
- **The result is a new regrade** (`.g4`), as a full `mst grade` writes it. Its `run.json` has `gradedFrom` (the run that collected the traces) and `resumedGrading`: the run whose verdicts it kept, and how many trials and comparisons it kept and graded. `grade` prints what `run` prints; when a judge still has no verdict, it prints the `--resume` command again.
- **With `--env`, only the cases with something to grade go to a shard**, and a worker grades only what has no verdict. When nothing is missing, no shard starts.
- **The judges and cases must be the ones the run was graded with.** `--resume` refuses when the eval config's judges or pairwise judges, or their options, changed (by `run.json`'s `judges`), when one of them grades differently with the same options (its identity: its `version`, its plugin's version or its options' defaults), or when a dataset's cases did (by its `contentHash`): verdicts from two versions of a judge would be mixed. Grade in full instead. A case's own judges aren't in `run.json`: when one's identity changed, `--resume` grades its trials again.
- A run collected with `--no-grade` has no grading to resume: grade it without `--resume`.

### Grading in an environment

With `--env`, the run is graded on the environment's machines instead of this one ([ADR 0005](./adr/0005-grading-runs-in-an-environment.md)): for an agentic judge that takes minutes a case, or a run too big to grade on a laptop.

```bash
npx mst run --config ./eval.json --env docker --no-grade --results gs://my-bucket/evals
npx mst grade 7f3c2a --config ./eval.json --env acme/env/cloud-vm --env-option shards=4 \
  --secrets-file ./judge-keys.env --results gs://my-bucket/evals
```

- **Shards hold whole cases**, split as `run --env` splits them, so each case's pairwise comparisons have both sides on one machine.
- **This machine loads the eval config, its plugins and its datasets, once.** Each shard gets the loaded cases and the stored run's files for its cases (`run.json`, traces, artifacts). A worker loads no dataset, so a dataset plugin's credentials stay here.
- **Workers grade with the code `mst grade` runs here**, and send back each trial's grading and each case's preferences. This machine then writes the regrade from them, as a local `mst grade` writes it: the run directory, its report, `latest.json` and the result store's copy. `run.json`'s `grading.environment` says where it was graded, with each shard's machine.
- **Judge keys must be in `--secrets-file`.** Its values go to each worker over its channel, never in a file on the machine. A worker keeps them in its process environment, where judges read them, and replaces them in what it sends back. This machine's own environment isn't sent.
- **The worker image needs the judges**: the plugins at this machine's versions, and the SDK or runtime each judge runs, which MST's image doesn't install: `openai` for an OpenAI `rubric` judge, `@openai/codex-sdk` or `@anthropic-ai/claude-agent-sdk` for an agentic judge. A worker's judge preflight names one that's missing. A judge that reads prompts or scripts from a checkout here can't run on a worker.
- **The container is a Codex judge's sandbox.** Codex's own OS sandbox (bubblewrap) can't start in a container, so an image sets `MST_JUDGE_SANDBOX=container` (MST's Linux Cowork image does): the judge's shell runs unsandboxed inside the disposable container. Without it, the worker's judge preflight fails: Codex's sandbox can't read a test file there, so the shard stops before judging, with bubblewrap's error, instead of recording verdicts made without the evidence.
- **A key must last the shard.** A worker gets the secrets file's values once, when its shard starts. A short-lived gateway token (one `MST_LLM_AUTH_COMMAND` makes, say) can expire during a long shard, and its judge calls then fail.
- **A shard that stops leaves its cases' grading missing.** Those trials and comparisons get a grading error (`Missing: grade shard 2 ended before …`), the regrade is `phases.grade: partial`, and `mst grade <regrade> --resume` grades only them ([Finishing a grading](#finishing-a-grading)).
- An environment must be able to run grade shards. One built with `machineEnvironment`, such as `docker`, can; `mst grade --env` refuses one that can't (`Environment.work`) before any shard runs.

## `optimize` - Improve Tool Metadata

Finds tool metadata (names, descriptions, input-schema text) that measurably helps a client use a server's tools, and recommends applying it or not. You, or an agent, write the candidates; MST checks them, runs them on the eval config's client, model and environment, compares each with the current metadata case by case, and keeps the cases that work today working. Each step is its own command, and the optimization is stored with the eval's runs, so it continues where it stopped ([ADR 0008](./adr/0008-a-tool-optimization-is-a-stored-experiment.md)).

### Usage

```bash
npx mst optimize start -c ./eval.json --tool search --max-variants 6   # measure the current metadata
npx mst optimize evidence -c ./eval.json                               # what the next candidates can learn from
npx mst optimize try ./round-0.json -c ./eval.json                     # run a round of candidates
npx mst optimize evidence -c ./eval.json                               # read the round, write the next
npx mst optimize try ./round-1.json -c ./eval.json
npx mst optimize finish -c ./eval.json                                 # write the recommendation
```

A candidates file is a JSON array, or an object whose `candidates` is that array (`-` reads it from stdin). Each candidate has a unique `id`, a `description` of the idea it tests, and `tools`, keyed by the tool's name on its server (`server.tool` when several servers serve it):

```json
[
  {
    "id": "search-scope",
    "description": "Say what search covers and when to use it",
    "tools": {
      "search": {
        "description": "Search every connected app: documents, tickets, chats and email. Use it first for any question about company information."
      }
    }
  }
]
```

### Commands

- **`start`** runs the base variant once (the baseline) and, when no case is tagged `regression`, once more to find the cases that work today. It lists the tools the servers serve and stores them, then writes the optimization to `<eval dir>/optimizations/<id>/optimization.json`.
- **`evidence`** prints the served tools (which are editable, with their parameters), the baseline and each round so far: every case's input, what its assertions expect, its trials passed, and each failed trial's tool calls, missed tools and failed graders. Cases tagged `held-out` are left out. `--json` prints the same as JSON, with each tool's full input schema to copy.
- **`try <file>`** checks the candidates, then runs them together as one round, and prints each one's metric, its change from the baseline and whether it is clearly better. `--retry` runs a round that didn't finish again. `--proposer <name>` records who wrote the candidates in the round (default: `agent`).
- **`finish`** judges every candidate against the number tried and writes `recommendation.md` next to the record: apply, reject or inconclusive, the metadata to apply, a row for capability, regression and held-out cases, every candidate, and the runs.

### What `try` refuses

A round that can't measure what it means to stops before anything runs, and says why:

- **A candidate that changes more than text.** It may change only a tool's `name`, its `description`, and `description` and `title` text inside its `inputSchema`. A changed parameter, type, enum or `required` list would measure rejected calls, since the server still gets every call under its own schema. A tool key that names no tool, or several, also fails, as does a tool outside `--tool`.
- **A repeated id.** Ids are unique across the optimization, and differ from the base variant's name.
- **More candidates than the budget has left.** `--max-variants` (default 6) caps the candidates across every round.
- **A server that changed.** Every round lists the servers' tools before any client starts. When a name, title, description or input schema differs from what the baseline was measured with, the round stops, and the optimization can't continue: start a new one.
- **A setup that changed.** The same holds for a round that differs from the baseline in what else it measures with: its datasets' content, the base variant's client, model or options, or the eval config's judges and their options.
- **Another process stepping it.** `try` and `finish` hold a `lock` file in the optimization's directory while they run. A second command fails, and names the process that holds the lock. A lock left by a process on the same machine that has ended is taken over; for any other stale lock, delete the file.

### Options

Every command takes `-c, --config` (required), `--plugins`, `--output-dir`, `--root-dir`, `--secrets-file`, `--store` and `--results`, as `run` does. The optimization doesn't store them, so give each command the same ones; the `Next:` line each command prints repeats them. `evidence`, `try` and `finish` take `--id <id>` (the optimization, or the end of its id; default: the latest).

| `start` option                                      | Description                                                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `--variant <name>`                                  | The config's variant the candidates build on. Each candidate runs as a copy of it with the candidate's `tools`. Default: the config's baseline. |
| `--tool <names...>`                                 | The tools candidates may change: names, or `server.tool`. Each must name one served tool. Default: every tool.                                  |
| `--metric <name>`                                   | What to improve: `passRate` (the default), `trialPassRate`, or a variant metric key such as `tool_search_hit_rate` or `input_tokens_mean`.      |
| `--better <direction>`                              | `higher` (the default) or `lower`, for tokens, cost or time.                                                                                    |
| `--max-variants <n>`                                | The most candidates to run, across every round. Default: 6.                                                                                     |
| `--regression-check <c>`                            | What breaks a regression case: `significant` (the default: a case or group clearly got worse) or `any-case` (one regressed case).               |
| `--allow-regressions`                               | Let a candidate that breaks regression cases win.                                                                                               |
| `--case`, `--filter-tag`, `--max-cases`, `--trials` | Narrow every run of the optimization, as for `run`.                                                                                             |
| `--env <name>`, `--env-option <k=v>`                | Where every run collects its trials, as for `run`: `local`, `docker`, or a plugin environment.                                                  |

### What it stores

Each run is an ordinary run in the eval's `runs/`, with `optimization` in its `run.json` (the optimization's id, and `baseline`, `grouping` or `round` with its number) and the tools the servers served. `mst open <run-id>` opens any of them. They never become the eval's `latest.json`, so `mst run` keeps comparing with your last ordinary run.

`optimization.json` (`mst.optimization/v1`) names those runs, the base variant, the metric, the budget, the rules and every round's candidates. Opening the optimization reads the runs and scores them again, so its numbers always come from the stored trials. The optimization's runs aren't resumed with `mst run --resume`, because resumed trials would run against tools nobody checked. A round whose run is missing trials (its shards ended early) runs again in full with `try --retry`. When a run is stored complete and then a step fails (a result store that rejects it, say), the optimization keeps the run.

### How "clearly better" is decided

A candidate is clearly better when its metric went up and a paired sign-flip test over the capability cases gives p < 0.025 divided by the number of candidates tried. Each candidate tried makes the threshold stricter, so a verdict `try` printed can turn inconclusive after later rounds, never the other way. With 6 candidates and every capability case improving, that takes at least 8 capability cases (p = 1/256); more trials per case help when cases improve only some of the time. Held-out cases never rank candidates, so their change is shown uncorrected. A variant metric with no per-case scores (`input_tokens_mean`) isn't tested: a gain counts unless it breaks regression cases.

## `runs` - Detached Runs

`mst run --detach` and `mst grade --detach` run the coordinator on a machine the environment creates, so the machine you typed them on can go offline ([ADR 0007](./adr/0007-detached-runs-move-the-coordinator.md)). The coordinator runs `mst run`, then `mst run --resume` once if the run is partial, then `mst grade --env` with `--grade-env`, and keeps the run in the result store.

```bash
npx mst run --config ./eval.json --env acme/env/cloud-vm --env-option shards=20 --grade-env \
  --results gs://my-bucket/evals --store acme/credential-store/secret-manager \
  --secrets-file ./run.env --detach
# Detached run d20261020T181638Z-e33763 is running on …. This machine can go offline.

npx mst runs list --config ./eval.json --results gs://my-bucket/evals
npx mst runs watch e33763 --config ./eval.json --results gs://my-bucket/evals
npx mst runs logs e33763 --config ./eval.json --results gs://my-bucket/evals
npx mst runs cancel e33763 --config ./eval.json --results gs://my-bucket/evals
```

- **This machine loads the eval config, its plugins and its datasets**, and sends the coordinator machine the config and the loaded datasets. A dataset plugin's credentials stay here, and a `file` dataset's path (`./cases.json`) needn't exist on the coordinator machine. `--detach` can't take `--plugins` or `--output-dir`: plugins come from the coordinator machine's installation, and the run goes to the result store.
- **The environment must support it**: its `coordinator` creates the machine, with this machine's MST and plugins and a cloud identity of its own. An environment without one refuses `--detach`.
- **Secrets go only in `--secrets-file`.** Its values reach the coordinator over its channel, and are kept in memory-backed storage there until the run ends. This machine's own environment isn't sent, so put what the run needs (a model key, judge keys) in the file.
- **Connector servers need a shared credential store** (`--store <namespace>/credential-store/<name>`, one whose definition is `shared`), since the coordinator machine refreshes the grants. Sign in to it with `mst auth --store`, and use it for local runs too, or a provider that rotates refresh tokens invalidates the local copy.
- **The run's status is in the result store**, at `<eval>/detached/<id>/`: `status.json` (rewritten every 30 seconds), `log.txt` and, after `cancel`, `cancel`. Each `mst runs` command takes the eval config and the `--results` the run was given, and an id or its last six characters.
- **`runs cancel`** asks the coordinator to stop: within a minute it interrupts the command under way as Ctrl-C does, deleting its machines and keeping what was collected. A coordinator that stops reporting for five minutes shows as `lost`; finish its run with `mst run --resume <run> --detach`.

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

## `open` - Open a Run's Report

```bash
npx mst open                                          # the newest run under .mcp-test-results
npx mst open .mcp-test-results/<eval name>            # that eval's latest run
npx mst open .mcp-test-results/<eval name>/runs/<run-id>
```

Opens a run's report (`<run>/report/index.html`), which `mst run` writes with every run. With no path it opens the newest complete run under `-d, --dir` (default `.mcp-test-results`), read from each eval's `latest.json`. A path names a run directory, or an eval's directory for its latest run. A run without a report, such as one copied without `report/`, gets one written from its files first. `--print` prints the report's path instead of opening it.

The MCP Playwright reporter writes its runs the same way, so `mst open` opens those too.

The report has the same sections for every eval: **Result** (each variant clearly better, clearly worse, or unclear against the baseline), **Variants compared** (pass rate, judge score, pairwise preference, cost, time, tools used; _Show statistics_ adds 95% ranges, p-values and pass^k), **What differs** (each variant's setup next to the baseline's), **Case by case** (every trial with its trace, each grader's score and the pairwise preference) and **Why trials failed**. Every pass rate has its likely range, and a run too thin to pin them down says so and what to run next. A run with one variant has the same sections, with one column, and opens on the cases that need attention, if any do. A run that stored responses redacted (the default, `redactStoredResponses`) shows no answers or tool outputs; set `redactStoredResponses: false` in the eval config to keep them.

## `cowork setup` - Prepare Cowork

```bash
npx mst cowork setup
```

Initialises or validates the empty Claude third-party profile that the Cowork client runs in, on macOS. See [Cowork](./cowork.md).

## `env setup` - Prepare an Environment

```bash
npx mst env setup docker --config eval.json --env-option contexts=colima-mst-kvm
```

Prepares what runs in an environment need, once. For `docker`, it builds MST's Linux Cowork image on each Docker context, or its ChatGPT image when `--config` names a ChatGPT eval (see [Cowork in Docker](./cowork-docker.md) and [ChatGPT in Docker](./chatgpt-docker.md)).

| Option                     | Meaning                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--env-option <key=value>` | The environment's options; repeat for more. `docker`: `image`, `contexts`, `claudeDesktopVersion`, `chatgptVersion`.                      |
| `--config <file>`          | An eval config whose plugins the environment's machines need. `docker` installs them in its image. Each plugin must be a package (below). |
| `--plugins <modules...>`   | Plugin modules, for an environment a plugin provides.                                                                                     |
| `--root-dir <dir>`         | Where relative plugin paths resolve. Default: the working directory.                                                                      |

A run's workers load the eval's plugins themselves, so a plugin must be installed on each worker machine, at the version this machine runs: a worker with another version of a plugin package refuses to run. With `--config`, each of the eval's plugins must be a package (a directory with a `package.json`, installed where the eval config resolves it), not a file.

## Next Steps

- See the [Quick Start Guide](./quickstart.md) for using generated datasets
- Check the [Assertions Guide](./assertions.md) for customizing validations
- Explore [Examples](../examples) for real-world dataset patterns
