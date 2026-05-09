# RFC 02: Browser-Hosted External Host Evals

## Status

Draft.

## Scope

This RFC defines the second implementation phase for external host evals:

- Browser-driven hosts.
- Hosted-backend MCP execution.
- Public trace proxy as an optional high-fidelity collector.
- DOM/browser artifact capture as a lower-fidelity collector.
- Claude Cowork as the first concrete browser-hosted target.

This phase builds on the core runtime from RFC 01.

## Important Constraint

For many web-based hosts, the browser does not execute MCP calls. The browser is
only the interaction plane. MCP calls are made by the host's backend.

```text
browser -> host web app -> host backend -> remote MCP server
```

That means local machine interception usually does not work. A local proxy only
helps if the host can be configured to call a publicly reachable proxy URL.

## Observation Strategies for Hosted Web Clients

Evidence sources should be attempted in this order:

1. Public MCP trace proxy.
2. MCP server-side logs, if the server owner exposes them.
3. Host-native trace export.
4. Browser API/HAR artifacts.
5. DOM transcript and visible tool cards.
6. Screenshots/video/computer-use output.

The framework must allow browser-hosted runs with low-fidelity evidence, but it
must report that fidelity honestly.

## Browser Driver

The browser driver should be a generic Playwright-based driver, not a
Claude-specific implementation.

Generic capabilities:

- Launch or connect to a browser.
- Load a saved authenticated storage state.
- Open a host URL.
- Start or reset a conversation.
- Submit a scenario.
- Detect completion.
- Extract final answer.
- Capture screenshots, video, and optional HAR.

Initial config shape:

```yaml
hosts:
  claude-cowork:
    type: browser
    url: https://claude.ai
    auth:
      storageState: ./.auth/claude-cowork.json
    driver:
      selectors:
        promptBox: '[contenteditable="true"]'
        submitButton: '[aria-label="Send"]'
        assistantMessage: '[data-testid="assistant-message"]'
      completion:
        strategy: stable-dom
        timeoutMs: 180000
    observers:
      - kind: dom
      - kind: browser-artifacts
```

Host-specific adapters may provide code instead of selectors when the host's UI
requires more logic.

## Public MCP Trace Proxy

Hosted web clients can only be observed at the MCP protocol layer if their MCP
server configuration can point at a public proxy.

```text
host backend -> public trace proxy -> real MCP server
```

Requirements:

- Public HTTPS URL.
- Stable target MCP server configuration.
- Auth passthrough or configured upstream auth.
- Run/case correlation.
- Tenant isolation if shared across runs.
- Secret redaction.

This should be generic in OSS. A user can run it wherever they want:

```bash
mcp-server-tester trace-proxy \
  --listen https://eval.example.com/mcp \
  --target https://real-server.example.com/mcp \
  --run-id run_123
```

For local development, a tunnel such as ngrok or Cloudflare Tunnel may be used.
For production-scale runs, users can deploy the proxy in their own cloud.

## Claude Cowork MVP

Claude Cowork is a good first browser-hosted target because it is strategically
important and exercises the hardest class of host: browser interaction plus
backend-executed MCP.

The MVP should support two variants:

- `claude-cowork-glean-mcp`
- `claude-cowork-native-connectors`

The open-source adapter should not assume Glean. A Glean-specific config can be
an internal example layered on top.

### Variant: Cowork + Configured MCP Server

If Cowork can be configured to use a custom MCP endpoint, use:

```text
Cowork backend -> public trace proxy -> target MCP server
```

Expected evidence:

- Final answer: DOM or browser API.
- Tool calls to configured MCP server: public MCP proxy, high confidence.
- Token usage: host export/UI if available, otherwise unavailable.
- Artifacts: screenshot, video, HAR, raw proxy trace.

### Variant: Cowork + Native Connectors

Native connector calls cannot be proxied by `mcp-server-tester`.

Expected evidence:

- Final answer: DOM or browser API.
- Tool calls: host-native trace export if available; otherwise DOM/tool cards
  with low confidence.
- Token usage: host export/UI if available, otherwise unavailable.
- Artifacts: screenshot, video, HAR, raw host export when available.

Reports must make the asymmetry explicit. A Cowork + Glean MCP run with proxy
traces is not observationally equivalent to a Cowork + native connectors run
where only DOM evidence is available.

## Host-Native Trace Exports

If a host exports traces, the framework should collect them through a
host-specific `TraceCollector`.

The collector should answer:

- Where is the trace produced?
- How is it correlated to a scenario/run?
- Does it include tool calls?
- Does it include token usage?
- Does it include latency?
- Does it include hidden prompt/context information that should be redacted?

The collector should normalize to `Observed<T>` and preserve the raw artifact.
The storage location is not part of the core design. A trace could come from a
local file, host API, downloaded archive, object store, or manual import.

## Example Dataset

```json
{
  "id": "cowork-planning-docs",
  "mode": "external_host",
  "scenario": "Find the latest planning docs for Project Atlas. Use company knowledge.",
  "host": {
    "name": "claude-cowork",
    "variant": "glean-mcp",
    "driver": "browser",
    "observers": ["dom", "mcp-proxy"]
  },
  "iterations": 3,
  "accuracyThreshold": 0.67,
  "expect": {
    "containsText": ["Project Atlas"],
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }]
    },
    "passesJudge": "correctness"
  }
}
```

## Matrix Runner

Browser-hosted evals become most useful when run as a matrix:

```text
scenario set:
  planning-docs
  code-search
  policy-lookup

hosts:
  claude-cowork / glean-mcp
  claude-cowork / native-connectors
  claude-code / glean-mcp
  codex-cli / glean-mcp
```

The runner should expand:

```text
scenario x host variant x iteration
```

Results should be sliceable by:

- Host.
- Variant.
- Scenario.
- Tool.
- Evidence source.
- Confidence.
- Iteration.

## Phase-Two Outcomes

This phase is complete when:

- A generic Playwright browser driver can run a simple hosted web flow.
- Browser runs produce screenshots/video and final answer evidence.
- Browser runs can be combined with a public MCP trace proxy when the host is
  configured to use a proxy URL.
- Claude Cowork has an initial adapter or documented example.
- Reports clearly show evidence asymmetry between Glean MCP/configured-MCP and
  native connector variants.
- Matrix runs work for at least one browser host and one CLI host.

## Explicit Non-Outcomes

- No guarantee that every hosted web client exposes tool traces.
- No universal interception of host-backend MCP calls.
- No automatic bypass of host login, MFA, admin setup, or connector approval.
- No desktop app automation in this phase.
- No claims-grade token comparison unless token evidence source is high enough
  confidence for both compared variants.

## Risks

- DOM selectors may be brittle. Prefer host APIs or transcript exports where
  available.
- Auth/session state may make cloud execution hard. Treat credential lifecycle
  as part of host adapter readiness.
- Hosted clients may change UI or endpoint configuration flows without notice.
- Some comparisons may have asymmetric observability. The framework should
  surface this rather than blocking useful lower-confidence runs.
