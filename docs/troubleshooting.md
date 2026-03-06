# Troubleshooting

Common issues and how to fix them.

---

## "Raw mode is not supported"

**Symptom:** Running `mcp-server-tester init` or `mcp-server-tester generate` fails immediately with an error like `Error: Raw mode is not supported on the current process.stdin`.

**Cause:** The CLI uses [Ink](https://github.com/vadimdemedes/ink) for interactive prompts. Ink requires a real TTY (interactive terminal). CI environments, piped shells, and non-interactive shells do not provide a TTY.

**Fix:** Run the command in an interactive terminal on your local machine, commit the generated files, and let CI consume them as static configuration. Do not invoke `init` or `generate` as part of a CI pipeline step.

---

## OAuth token refresh failing silently

**Symptom:** Tests pass the auth setup phase but subsequent MCP tool calls fail with HTTP 401 errors or access-denied responses.

**Cause:** The cached OAuth access token has expired. `hasValidOAuthState` returns `false`, which causes `performOAuthSetupIfNeeded` to attempt re-authorization. In CI, no browser is available to complete the OAuth flow, so the re-auth silently fails or is skipped, and the expired token is used for calls.

**Fix:**

1. **Use `performOAuthSetup` in `globalSetup`** — run the full browser-based OAuth flow once before tests start. The auth state file is written to disk and reused for all tests in the run.

2. **Cache the auth state file between CI runs** — persist the file written by `performOAuthSetup` (typically `~/.mcp-server-tester/auth/<server>.json` or the path you configured) in your CI cache. This avoids re-auth on every run.

3. **Switch to a static API token** — if your MCP server supports API tokens, use `tokenAuth` instead of `oauth`. Static tokens do not expire on a short cycle and do not require browser interaction. See [docs/authentication.md](./authentication.md) for configuration details.

---

## HTTP MCP server not reachable (connection refused)

**Symptom:** Tests fail immediately with `ECONNREFUSED` or a network timeout error pointing at the configured `serverUrl`.

**Cause:** One of the following:

- The MCP server process is not running when the test starts
- The `serverUrl` in your `MCPConfig` has the wrong host or port
- A proxy or firewall is intercepting the connection

**Fix:**

1. Verify the server is running and listening on the expected port before tests execute. Use a `globalSetup` script to start the server and wait for it to become ready.

2. Double-check the `serverUrl` value in your `playwright.config.ts`. A common mistake is using `localhost` when the server binds to `127.0.0.1` only, or vice versa.

3. Add `retryAttempts` to your `MCPConfig` to tolerate brief startup delays:

   ```typescript
   mcpConfig: {
     transport: 'http',
     serverUrl: 'http://localhost:3000/mcp',
     retryAttempts: 3,
   }
   ```

4. If you are behind a corporate proxy, ensure the proxy is configured to pass through requests to `localhost` / `127.0.0.1`, or set `NO_PROXY=localhost,127.0.0.1` in your environment.

---

## Eval accuracy much lower in CI than locally

**Symptom:** The `infrastructureErrorRate` field in eval run results is high when running in CI, but the same evals pass consistently on a developer machine. `assertionPassRate` appears low as a result.

**Cause:** CI environments often have stricter rate limits, slower network paths, and no retry tolerance. MCP tool calls that succeed quickly locally may time out or hit provider rate limits in CI.

**Fix:**

1. **Reduce concurrency.** Lower the `concurrency` option in `runEvalDataset` to avoid saturating rate limits:

   ```typescript
   await runEvalDataset({ dataset, concurrency: 2 }, { mcp, testInfo });
   ```

2. **Add retry attempts.** Configure `retryAttempts` on your `MCPConfig` so transient network errors are retried automatically:

   ```typescript
   mcpConfig: {
     transport: 'http',
     serverUrl: 'https://your-server/mcp',
     retryAttempts: 3,
   }
   ```

3. **Increase the call timeout.** If your MCP server is slow to respond in CI (cold starts, shared infrastructure), raise `callTimeoutMs`:

   ```typescript
   mcpConfig: {
     transport: 'http',
     serverUrl: 'https://your-server/mcp',
     callTimeoutMs: 30_000,
   }
   ```

4. **Inspect `infrastructureErrorRate` separately from `assertionPassRate`.** Infrastructure errors (timeouts, connection resets) are distinct from assertion failures. A high infrastructure error rate signals a connectivity or capacity problem, not a quality problem with your MCP server.

---

## Windows: token files not secure

**Symptom:** OAuth token files are written successfully, but on Windows the `0o600` POSIX permission mode applied by Node's `fs.writeFile` is silently ignored. Any local user account can read the file.

**Cause:** Windows does not enforce POSIX file permission bits. The `0o600` mode has no effect on NTFS.

**Fix:** Manually verify that the folder containing token files (`%LOCALAPPDATA%\mcp-server-tester\` or the path you configured) has Access Control List (ACL) entries that restrict read access to your user account only.

To inspect and tighten ACLs from PowerShell:

```powershell
$path = "$env:LOCALAPPDATA\mcp-server-tester"
icacls $path
# Remove inherited permissions and restrict to current user:
icacls $path /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
```

In shared or multi-user environments, consider storing tokens in a secrets manager rather than on the local filesystem.

---

## "Unsupported Vercel AI SDK provider" error

**Symptom:** Running an eval in `mcp_host` mode fails with an error such as `Unsupported provider: google` or `Cannot find module '@ai-sdk/google'`.

**Cause:** LLM host providers are optional peer dependencies. The package declares them in `optionalDependencies`, but npm does not guarantee they are installed in all environments. The specific Vercel AI SDK adapter for the provider you selected is missing.

**Fix:** Install the `ai` package and the adapter for your chosen provider:

| Provider     | Install command                              |
| ------------ | -------------------------------------------- |
| `openai`     | `npm install ai @ai-sdk/openai`              |
| `anthropic`  | `npm install ai @ai-sdk/anthropic`           |
| `google`     | `npm install ai @ai-sdk/google`              |
| `azure`      | `npm install ai @ai-sdk/azure`               |
| `mistral`    | `npm install ai @ai-sdk/mistral`             |
| `deepseek`   | `npm install ai @ai-sdk/deepseek`            |
| `openrouter` | `npm install ai @openrouter/ai-sdk-provider` |
| `xai`        | `npm install ai @ai-sdk/xai`                 |

See [docs/mcp-host.md](./mcp-host.md) for the full provider table and required environment variables.
