# LLM Gateways

MST's own LLM calls (the `mst` client and LLM judges) can go through an LLM gateway: a proxy that serves the Anthropic Messages or OpenAI APIs at its own URL, usually with its own short-lived tokens. Point MST at it with environment variables; no config changes are needed.

## Configuration

| Variable                      | Purpose                                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_BASE_URL`          | The gateway's Anthropic API root; requests go to `<root>/v1/messages`. A trailing `/v1` is accepted too.                                  |
| `OPENAI_BASE_URL`             | The gateway's OpenAI API base, normally ending in `/v1` (requests go to `<base>/responses`).                                              |
| `MST_LLM_AUTH_COMMAND`        | A shell command that prints a token. MST runs it when it needs a credential and caches the output. Used only with a base URL override.    |
| `MST_LLM_AUTH_COMMAND_TTL_MS` | How long a command token is reused: a non-negative integer of milliseconds (default `300000`, 5 minutes). Keep it below the token's life. |
| `ANTHROPIC_AUTH_TOKEN`        | A static gateway token sent as `Authorization: Bearer`, only with `ANTHROPIC_BASE_URL` set. Gateways often reject the `x-api-key` header. |

A gateway with a token helper, for runs that outlast one token:

```bash
export ANTHROPIC_BASE_URL=https://llm-gateway.example.com/anthropic
export OPENAI_BASE_URL=https://llm-gateway.example.com/openai/v1
export MST_LLM_AUTH_COMMAND=/usr/local/bin/my-gateway-token
npx playwright test
```

A gateway with a static token:

```bash
export ANTHROPIC_BASE_URL=https://llm-gateway.example.com/anthropic
export ANTHROPIC_AUTH_TOKEN=...
npx playwright test
```

`ANTHROPIC_BASE_URL` means the same as it does for the official Anthropic SDKs and Claude Code, so a value set for those works here. The AI SDK on its own expects the `/v1` form; MST accepts either and sends each SDK the form it needs.

The command runs through the shell with MST's environment, and must print only the token on stdout. Its token is cached per command and environment for `MST_LLM_AUTH_COMMAND_TTL_MS`, so a case with its own `clientOptions.env` runs the command again. If it fails, the LLM call fails with its exit status; neither its stdout nor its stderr is included in the error (either could contain the token), so run it in a terminal to see what went wrong.

### Gateways configured for Claude Code

MST doesn't read Claude Code's settings files. If your gateway is set up for Claude Code (for example in managed settings, with `env.ANTHROPIC_BASE_URL` and an `apiKeyHelper`), export the same two values for MST:

```bash
export ANTHROPIC_BASE_URL=<the env.ANTHROPIC_BASE_URL value>
export MST_LLM_AUTH_COMMAND=<the apiKeyHelper value>
```

## Which credential is used

For Anthropic-shaped calls, the first that applies wins:

1. `apiKeyEnvVar` from the `mst` client's options or the judge config. When set, no other credential is read; the key still goes to `ANTHROPIC_BASE_URL` if that is set.
2. `MST_LLM_AUTH_COMMAND`, sent as `Authorization: Bearer`, **only when `ANTHROPIC_BASE_URL` is set**.
3. `ANTHROPIC_AUTH_TOKEN`, sent as `Authorization: Bearer`, **only when `ANTHROPIC_BASE_URL` is set**.
4. `ANTHROPIC_API_KEY`, sent as `x-api-key`.

OpenAI-shaped calls use `apiKeyEnvVar`, then `MST_LLM_AUTH_COMMAND` (only when `OPENAI_BASE_URL` is set), then `OPENAI_API_KEY`. OpenAI SDKs always send the key as a bearer token.

The auth command is MST's own setting, so it wins over keys that happen to be in the environment. Gateway credentials (the auth command and `ANTHROPIC_AUTH_TOKEN`) are only sent to a base URL override, so a gateway token can't reach a provider's public API by accident. They go to every overridden base URL, though: if `OPENAI_BASE_URL` points at a different proxy than your gateway, give that provider its own key with `apiKeyEnvVar`. Without an override, calls go to the provider's public API (`https://api.anthropic.com`, `https://api.openai.com/v1`).

A case's `clientOptions.env` takes part in this too, so a dataset can set `MST_LLM_AUTH_COMMAND`, which MST runs through a shell. Treat datasets from elsewhere like code.

## What reads these settings

| Consumer                                     | Anthropic | OpenAI | Notes                                                                                                  |
| -------------------------------------------- | --------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `mst` client, `provider: 'anthropic'`        | Yes       |        | Streams its responses (see below).                                                                     |
| `mst` client, `provider: 'openai'`           |           | Yes    | Uses the Responses API; sends `store: false` behind a base URL override (see below).                   |
| `anthropic` judge                            | Yes       |        |                                                                                                        |
| `openai` judge                               |           | Yes    | Uses non-streaming Chat Completions, which some gateways don't serve. Use the `anthropic` judge there. |
| Computer Use planner (Cowork, ChatGPT macOS) | Yes       |        | The gateway must accept the Computer Use beta tool.                                                    |

The Computer Use planner gets one credential for exactly one endpoint: MST resolves both with the rules above, and the driver ignores `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from its own environment.

Cowork's own inference is configured in Claude Desktop, not by these settings. MST stages `ANTHROPIC_API_KEY` for it, unless managed preferences already set the inference provider (for example, a gateway); see [Cowork inference](./cowork.md#inference).

The `anthropic-agent-sdk` judge and CLI hosts run their own processes, which read their own configuration.

## Why the Anthropic SDK host streams

The `anthropic` SDK host runs its agent loop with streaming (`streamText`) rather than `generateText`. Gateways usually pass streamed Messages responses through unchanged, but some rebuild non-streaming responses with empty fields (`"citations": null`, an empty `caller` object) that the AI SDK's response schema rejects. Streaming avoids that, and is how interactive clients call the API anyway. A provider error part in the middle of a stream fails the case, the same as a thrown error.

## Why the OpenAI SDK host sends `store: false` to a gateway

In a tool loop, the AI SDK refers back to the previous turn's Responses items by id, which only works if OpenAI stored them. Gateways and proxies usually don't (`Item with id 'rs_…' not found. Items are not persisted when store is set to false`). Behind an `OPENAI_BASE_URL` override the SDK host sends `store: false`, so the items are sent inline. Calls to the public API keep OpenAI's default.

## Troubleshooting

- **`authentication error (...)`** from a gateway, with `ANTHROPIC_API_KEY` set: the gateway wants a bearer token, and `ANTHROPIC_API_KEY` sent `x-api-key`. Set `MST_LLM_AUTH_COMMAND` or `ANTHROPIC_AUTH_TOKEN`; either wins over `ANTHROPIC_API_KEY`.
- **401 partway through a long run**: a static token expired. Use `MST_LLM_AUTH_COMMAND`, with a TTL below the token's lifetime.
- **404 or an empty answer**: the gateway may not serve that model on that API. Check the model id against the gateway's model list.
- **The judge says it needs an API key** with only `MST_LLM_AUTH_COMMAND` or `ANTHROPIC_AUTH_TOKEN` set: gateway credentials are only used with a base URL override. Set `ANTHROPIC_BASE_URL` (or `OPENAI_BASE_URL`).
- **`MST_LLM_AUTH_COMMAND failed (exit N)`**: run the command in a terminal; it may need you to sign in first.
