# Traces (OpenTelemetry)

MST can send each trial of a run as an [OpenTelemetry](https://opentelemetry.io/) trace to a collector, over OTLP. MST builds the traces itself, from the record it keeps of each trial, so every client is traced the same way: the `mst` client, Claude Code, Cowork, ChatGPT and plugin clients, run locally, in Docker or on a cloud VM, attached or detached. No client needs a telemetry setting of its own.

```json
{
  "telemetry": {
    "otlp": {
      "endpoint": "https://collector.example.com",
      "bearerTokenEnv": "MST_OTLP_TOKEN"
    }
  }
}
```

| Field                | Meaning                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`           | The collector's base URL (MST posts OTLP/JSON to `<endpoint>/v1/traces`) or its traces URL. HTTPS, or HTTP to `localhost`.                                                                      |
| `headers`            | Headers to send, such as a tenant. Not for secrets.                                                                                                                                             |
| `bearerTokenEnv`     | The environment variable, or `--secrets-file` key, holding a bearer token for the collector. The token is never written to the run.                                                             |
| `resourceAttributes` | Added to every trace's resource, for example `{ "deployment.environment.name": "ci" }`.                                                                                                         |
| `content`            | Also send what the trial said: the prompt, the answer, each model request's text, tool arguments and results, judges' reasoning. Off by default. See [What a trace holds](#what-a-trace-holds). |
| `maxAttributeChars`  | The most characters of one content attribute (default 16384); longer ones are cut and say how much was cut.                                                                                     |

A plugin can supply `telemetry` in a config preset, like any other setting (see `extends` in [evaluation-framework.md](./evaluation-framework.md)).

## When traces are sent

The machine that runs `mst run` (or, for a [detached run](./adr/0007-detached-runs-move-the-coordinator.md), its coordinator) sends them, so the collector must be reachable from there, not from the client's machine or VM.

- **Each trial**, as soon as it's saved: the client's run, its model requests and its tool calls.
- **Each verdict**, once the run is graded: a span for the trial's pass or fail, one for each judge's score, and one for each pairwise judge's preference (in the candidate's first trial).
- **A regrade** (`mst grade`) sends only its verdicts, into the traces of the run it grades: a trial's trace ID comes from the run, variant, case and trial, so it's the same for every grading. Each verdict says which grading made it (`mst.grading_run_id`).

Sending never fails or slows the run. Requests are queued and sent in the background, retried on a network error, 429 or 5xx, and reported once if they still fail. At the end, the run waits up to 30 seconds for what's left, then says how many requests failed.

## What a trace holds

Spans follow OpenTelemetry's [generative AI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), plus `mst.*` attributes for the eval.

| Span                    | What it is                                       | Attributes                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `invoke_agent <client>` | The trial: the root.                             | `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.*`, `mst.eval`, `mst.run_id`, `mst.variant`, `mst.case_id`, `mst.trial`, `mst.dataset`, `mst.tags`, `mst.cost_usd`, `mst.tool_call_count`, `mst.model_call_count`; an error's message as its status |
| `chat <model>`          | One model request, when the client reports them. | `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.*`                                                                                                                                                                                           |
| `execute_tool <name>`   | One tool call: MCP or the client's own.          | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.type`, `mcp.method.name`, `mst.tool.server`, `mst.tool.source`, `mst.tool.kind`; an error status when the call failed                                                                                      |
| `evaluate <judge>`      | One verdict.                                     | `gen_ai.evaluation.name`, `gen_ai.evaluation.score.value`, `gen_ai.evaluation.score.label`, `mst.grading_run_id`                                                                                                                                                   |

`gen_ai.usage.input_tokens` counts all input, cached or not, as OpenTelemetry does; `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_creation.input_tokens` say how much was cached, and `mst.usage.uncached_input_tokens` is MST's own input count.

With `content: true`, spans also have `gen_ai.input.messages` (the prompt), `gen_ai.output.messages` (the answer, or a model request's text and tool calls), `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` and `gen_ai.evaluation.explanation`. These can hold anything the servers under test returned: send them only to a collector cleared for that data. `redactStoredResponses` doesn't apply to traces: a run that redacts what it stores still sends content when `content` is on.

### What each client reports

The trace has what the client recorded. Every client reports its answer and tool calls; model requests and times depend on what the client's own record has:

| Client        | Model requests                                      | Times                                                                     |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `mst`         | Each step's request, with usage and response ID     | Each request's; tool calls' from the requests around them                 |
| `claude-code` | Each message, with usage                            | From when each line of Claude Code's output arrived                       |
| Cowork        | Each message in the session's audit log, with usage | From the audit log's timestamps                                           |
| ChatGPT       | Each response's usage record                        | From the session log's timestamps; tool calls' own                        |
| Plugin client | Whatever its `ClientRunResult` has in `modelCalls`  | Its `startedAt` and `completedAt`, and its events' and model calls' times |

A span with no times of its own is placed at the start of its trial and marked `mst.untimed`. A tool call timed from the model requests around it is marked `mst.timing: "inferred"`; one timed by the host's own telemetry, `mst.timing: "host"`.

## The host's own telemetry

A client's record of a trial is its conversation: messages, tool calls and results, usage per message. Some hosts also report what they measured while running, over their own OpenTelemetry exporter, and never write it into that record: a request's duration, time to first token and cost, permission decisions, retries and API errors, the hooks and plugins that ran. With `telemetry.host`, MST records that too, in the same trial:

```json
{
  "telemetry": {
    "otlp": { "endpoint": "https://collector.example.com" },
    "host": {}
  }
}
```

MST runs an OTLP/HTTP receiver beside the client (one per process, on a random port and secret path) and points the host's exporter at it, asking for OTLP/JSON. Each trial takes the records of its own session: Claude Code runs with a session ID MST chooses, and a Cowork task is matched by its session. The trial's record keeps them in `trace.hostTelemetry`: the host's events, spans and metrics (each metric's latest value), with its resource attributes. `telemetry.otlp` isn't needed: without it, they're only in the run.

| Field     | Meaning                                                                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content` | Keep the host's content attributes (`prompt`, `response`, `tool_input`, `tool_parameters`, `gen_ai.*.messages`, ...), and ask the host to send them. Off by default: the host is asked for none, and any it sends are dropped. Identity attributes (`user.*`, `organization.id`, `host.name`) are never kept. |
| `traces`  | Also ask the host for its spans, where it has them (Claude Code's are beta).                                                                                                                                                                                                                                  |
| `forward` | Also pass what the host sent, as it sent it, on to a collector: `endpoint` (MST posts to `<endpoint>/v1/<signal>`), `headers`, `bearerTokenEnv`. Use it to keep a collector that got the host's telemetry before getting it. Sending never fails the run.                                                     |

In the trial's trace, a host event joins the span it names: an `api_request` the model request with its request ID, a `tool_decision` or `tool_result` the tool call with its ID (`tool_use_id`). Each is a span event, and the first event of each name is also the span's attributes, as `mst.host.<event>.<key>` (for example `mst.host.api_request.ttft_ms`), so a query can filter on them. A request the client's record doesn't have, such as a subagent's, gets a span of its own (`mst.model_call.source: "host"`). Other events, and metrics, are the root's events; the host's resource is the root's `mst.host.*`. The host's spans join under the root (`mst.span.source: "host"`, their own trace ID as `mst.host.trace_id`).

| Client        | How                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude-code` | MST sets `CLAUDE_CODE_ENABLE_TELEMETRY` and the per-signal `OTEL_EXPORTER_OTLP_*_ENDPOINT`s, and passes `--session-id`. A machine's managed settings with an `otelHeadersHelper` keep Claude Code's telemetry with their own collector by design: Claude Code then ignores MST's endpoints, and MST says so and records none.                                                        |
| Cowork        | Linux owned-desktop mode only (MST's image): MST writes Claude Desktop's `otlp*` settings, in place of the image's, pointing at the receiver. Desktop gives a task in its VM the host's address for `localhost`, so the receiver listens on every interface of the container, under its secret path. Desktop applies these settings with third-party inference, as MST's image uses. |
| Plugin client | `hostTelemetryReceiver(config)` (from `./evals`) starts or returns the process's receiver: point the host at its `endpoint`, then `collect(sessionIds)` after the trial and return it as `hostTelemetry`.                                                                                                                                                                            |

When the host sends nothing, the first trial waits 15 seconds for it, MST says so once, and later trials wait only briefly.

## Try it locally

Run [Jaeger](https://www.jaegertracing.io/) and point an eval at it:

```bash
docker run -d --name jaeger -p 127.0.0.1:16686:16686 -p 127.0.0.1:4318:4318 jaegertracing/jaeger:2.10.0
```

```json
{
  "telemetry": {
    "otlp": { "endpoint": "http://localhost:4318", "content": true }
  }
}
```

Then open <http://localhost:16686>, pick the service `mcp-server-tester`, and search by tag, for example `mst.run_id=<run id>`.
