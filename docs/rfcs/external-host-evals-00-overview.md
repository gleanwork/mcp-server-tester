# RFC 00: External Host Evals Overview

## Status

Draft.

## Context

`mcp-server-tester` currently supports two useful but incomplete ways to evaluate
MCP behavior:

- `direct` mode calls MCP tools directly and gives deterministic server-level
  signal.
- `mcp_host` mode uses an SDK-driven LLM loop to approximate how a host might
  discover and call tools.

That is not enough for real-world host behavior. MCP servers are increasingly
used through concrete hosts: CLI clients, desktop applications, and hosted web
products. Those hosts differ in prompting, tool selection, tool execution,
context limits, token accounting, UX, and trace visibility.

The goal of external host evals is to run the same scenario set through real MCP
hosts and normalize the resulting evidence into the same eval/reporting model
used by `mcp-server-tester`.

## Design Goal

External host evals should be portable first, host-enriched second, and
company-specific last.

The open-source library should provide:

- Generic host-driving interfaces.
- Generic trace and artifact schemas.
- Optional MCP protocol tracing when a host can be routed through a proxy.
- Reporter support that makes evidence source and confidence explicit.
- Host adapter extension points for CLI, browser, and desktop clients.

Company-specific infrastructure, dashboards, credentials, and internal trace
stores should be adapters or examples, not assumptions in the core design.

## Non-Goals

- Do not assume every host can be transparently intercepted.
- Do not assume web-hosted clients execute MCP calls from the user's local
  machine.
- Do not claim equal trace fidelity across host variants when evidence comes
  from different sources.
- Do not make computer-use or DOM scraping the source of truth when protocol
  traces or structured host traces are available.
- Do not require Glean infrastructure for the open-source feature to work.

## Host Support Matrix

This matrix is intentionally concrete. It should be updated as adapters mature.

| Host                    | Surface     | MCP calls from     | Endpoint proxy feasible                                   | Driving                            | Final answer                | Tool trace                                                                            | Token usage             | Cloud feasibility                | Confidence  |
| ----------------------- | ----------- | ------------------ | --------------------------------------------------------- | ---------------------------------- | --------------------------- | ------------------------------------------------------------------------------------- | ----------------------- | -------------------------------- | ----------- |
| Claude Code             | CLI/TUI     | Local process      | Yes                                                       | Spawn process                      | stdout / stream JSON        | CLI stream plus optional MCP proxy                                                    | CLI output if available | Container or VM                  | High        |
| Codex CLI               | CLI/TUI     | Local process      | Yes                                                       | Spawn process                      | stdout / logs               | CLI logs plus optional MCP proxy                                                      | Logs if available       | Container or VM                  | High        |
| Gemini CLI              | CLI/TUI     | Local process      | Likely                                                    | Spawn process                      | stdout / logs               | Logs plus optional MCP proxy                                                          | Logs if available       | Container or VM                  | Medium-high |
| Claude Desktop          | Desktop app | Local app          | Yes if config is editable                                 | Accessibility / computer use       | UI / transcript             | Local MCP proxy or app logs                                                           | UI / logs if available  | VM only                          | Medium      |
| Claude Cowork web       | Browser     | Host backend       | Only if host config can point to a public proxy           | Playwright / DOM                   | DOM, export, or browser API | Public MCP proxy for configured MCP servers; host export or DOM for native connectors | Host export or UI       | Browser worker if auth is stable | Medium      |
| ChatGPT Enterprise      | Browser     | Host backend       | Maybe for custom MCP connectors                           | Playwright / DOM                   | DOM, export, or browser API | Public MCP proxy if configurable; DOM/tool cards otherwise                            | UI/export if available  | Browser worker                   | Medium-low  |
| Gemini Enterprise       | Browser     | Host backend       | Maybe through admin config                                | Playwright / DOM                   | DOM or browser API          | Public MCP proxy if configurable; DOM otherwise                                       | Unknown                 | Browser worker                   | Medium-low  |
| Cursor                  | Desktop app | Local/remote mixed | Maybe                                                     | App automation or CLI if available | UI / logs                   | Proxy/logs if local MCP                                                               | Unknown                 | VM                               | Medium-low  |
| Generic hosted web host | Browser     | Host backend       | Only if server URL can be configured to a public endpoint | Playwright / DOM                   | DOM/API/export              | Public proxy, host export, or DOM                                                     | Host export/UI/none     | Browser worker                   | Varies      |
| Generic local CLI host  | CLI/TUI     | Local process      | Yes                                                       | Spawn process                      | stdout / logs               | stdout/logs/proxy                                                                     | stdout/logs/none        | Container or VM                  | High        |

## Feasibility Tiers

External host support should be described by tier, not just by host name.

| Tier                         | Meaning                                                                              | Examples                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Tier 1: Structured           | Host runs through a process or API and emits structured output or logs.              | Claude Code, Codex CLI                                                    |
| Tier 2: Protocol-observed    | Host can be pointed at an MCP trace proxy.                                           | Local CLI, editable desktop configs, hosted web with configurable MCP URL |
| Tier 3: Host-export observed | Host exposes native traces, but collection is host-specific.                         | Claude Cowork trace export, app logs                                      |
| Tier 4: UI-observed          | Only browser DOM, transcript export, network artifacts, or tool cards are available. | ChatGPT/Cowork native connectors                                          |
| Tier 5: Visual/computer-use  | Only screenshot/accessibility-driven operation is available.                         | Opaque desktop apps                                                       |

The framework can support all tiers, but reports must surface the tier and
evidence source. A low-fidelity host run can still be useful; it just must not
be presented as protocol-level truth.

## Observation Ladder

For each run, evidence should be collected from the strongest available source:

1. MCP protocol trace: proxy or server-side logs.
2. Host-native trace: exported run trace, local log, or host API.
3. Browser API trace: web app APIs visible to Playwright/CDP.
4. DOM trace: visible transcript, tool cards, status indicators.
5. Visual trace: screenshots, video, accessibility tree, computer-use output.

Each metric should carry source metadata:

```typescript
type TraceSource =
  | 'mcp-proxy'
  | 'mcp-server-logs'
  | 'host-native-export'
  | 'browser-api'
  | 'dom'
  | 'screenshot'
  | 'manual-import'
  | 'none';

type ObservationConfidence = 'high' | 'medium' | 'low';

interface Observed<T> {
  value: T;
  source: TraceSource;
  confidence: ObservationConfidence;
  limitations?: string[];
}
```

## Conceptual Architecture

```text
Eval dataset
  |
  v
Host eval orchestrator
  |
  +-- Host driver        // operates the host
  +-- Trace collectors   // collect protocol, host, browser, or UI evidence
  +-- Result normalizer  // converts host evidence into eval results
  +-- Reporter           // displays evidence source, confidence, artifacts
```

Driving and observability are separate. A Playwright browser driver may submit
the prompt, but protocol traces might come from an MCP proxy, host traces might
come from a downloaded export, and the final answer might come from the DOM.

## Proposed Dataset Shape

The long-term dataset shape should distinguish synthetic SDK hosts from real
external hosts.

```json
{
  "id": "find-planning-docs",
  "mode": "external_host",
  "scenario": "Find the latest planning docs for Project Atlas. Use company knowledge.",
  "host": {
    "name": "claude-cowork",
    "variant": "glean-mcp",
    "driver": "browser",
    "observers": ["dom", "mcp-proxy"]
  },
  "expect": {
    "containsText": ["Project Atlas"],
    "toolsTriggered": {
      "calls": [{ "name": "search", "required": true }]
    },
    "passesJudge": "correctness"
  }
}
```

Possible mode naming:

- `direct`: direct MCP tool call.
- `mcp_host`: current synthetic SDK/CLI host behavior.
- `external_host`: real host execution through CLI, browser, or desktop.

## Outcomes

This RFC is successful when:

- We agree on the support matrix dimensions.
- We agree that evidence source and confidence are first-class report fields.
- We agree that host driving and trace collection are separate interfaces.
- We agree that Glean-specific trace stores and dashboards are adapters, not
  core assumptions.

## Open Questions

- Should `external_host` be a new mode, or should `mcp_host.hostType` grow to
  cover real external hosts?
- Should host adapters live in the main package, separate packages, or examples?
- Which trace sources should be mandatory for a run to be considered pass/fail
  eligible?
- How much artifact retention should the default reporter provide before a
  separate dashboard/storage system is needed?
