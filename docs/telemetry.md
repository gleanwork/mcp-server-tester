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

A span with no times of its own is placed at the start of its trial and marked `mst.untimed`. A tool call timed from the model requests around it is marked `mst.timing: "inferred"`.

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
