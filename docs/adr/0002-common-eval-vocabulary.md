---
status: accepted
---

# MST uses common eval vocabulary

MST grew its own names: manifests, arms, scenarios, iterations, expectations, verdicts, variant experiments. Someone who knows evals from Inspect, LangSmith, Braintrust, OpenAI Evals, promptfoo or Anthropic's guidance had to translate each one. For 2.0 we adopt the terms those frameworks share and rename MST's API, eval configs, CLI, docs and reports to match, breaking compatibility where needed. `CONTEXT.md` is the glossary. This record is the mapping, so anyone can carry their own vocabulary across.

## Mapping

| Concept                           | MST                          | Anthropic                    | Inspect        | LangSmith         | Braintrust | OpenAI Evals | promptfoo         |
| --------------------------------- | ---------------------------- | ---------------------------- | -------------- | ----------------- | ---------- | ------------ | ----------------- |
| What to evaluate and how          | eval (eval config)           | eval suite                   | task           | —                 | eval       | eval         | config            |
| Collection of inputs              | dataset                      | —                            | dataset        | dataset           | dataset    | data source  | tests             |
| One input with success criteria   | case                         | task (test case)             | sample         | example           | example    | item         | test case         |
| What the client is given          | input                        | input                        | input          | inputs            | input      | item         | vars              |
| Ground truth                      | expected                     | success criteria             | target         | reference outputs | expected   | —            | —                 |
| What acts on the input            | client, with a model         | agent harness, with a model  | solver / agent | target            | task       | —            | provider          |
| A setup being compared            | variant (baseline)           | —                            | —              | experiment        | experiment | run          | prompt × provider |
| One attempt                       | trial                        | trial                        | epoch          | repetition        | trial      | —            | repeat            |
| Record of an attempt              | trace                        | transcript (trace)           | transcript     | trace             | trace      | —            | —                 |
| Grading logic                     | grader: assertion or judge   | grader (code, model)         | scorer         | evaluator         | scorer     | grader       | assertion         |
| Grader output                     | score                        | score                        | score          | feedback          | score      | result       | result            |
| One execution                     | run                          | —                            | eval log       | experiment        | experiment | run          | eval              |
| Baseline-passing / -failing cases | regression / capability case | regression / capability eval | —              | —                 | —          | —            | —                 |

Where frameworks disagree, MST picks the most widely shared term that has one meaning:

- **Not "task".** It means a test case to Anthropic, a whole eval to Inspect, and the system under test to Braintrust.
- **"Case" over "example" or "sample".** It's the established word for testing, used by Anthropic and promptfoo. "Sample" collides with statistical sampling, which MST also reports.
- **"Trial".** Anthropic uses it, and pass@k and pass^k are defined over trials. "Iteration" suggests the attempts depend on each other.
- **"Variant" with a "baseline" over "arm".** That's the A/B vocabulary most people know. Tool metadata becomes one property of a variant, not a separate "tool variant".
- **"Grader" for the umbrella, "assertion" and "judge" for the kinds.** These are Anthropic's code-based and model-based graders, in the words practitioners already use for each.
- **"Client", with a separate "model".** What an MCP eval tests is two things: the application that uses the servers, and the model it runs. The MCP ecosystem calls those applications clients (Claude Code, Cowork, ChatGPT), so each one has a canonical name, and the model is set beside it. "Harness" is generic, and "host" names the containing application in the MCP specification, which users rarely mean. How MST drives a client (a CLI, desktop automation or an SDK) never appears in its name; MST's own minimal client is simply `mst`.
- **"Trace".** LangSmith, Braintrust and OpenTelemetry use it, and Anthropic lists it as a synonym of transcript.

## Consequences

- **Renames.**
  - The eval config replaces the manifest.
  - `arms` → `variants`; the first variant is the baseline unless one is named.
  - A variant's `tools` replaces `toolOverrides`.
  - `scenario` → `input`; `canonicalAnswer` folds into `expected.answer`.
  - `iterations` → `trials`; `accuracyThreshold` → `passThreshold`.
  - `expect` → `assertions`; scores replace verdicts.
  - Hosts become clients with canonical names: `mst` (was `vercel-sdk`, `anthropic-api` and `mcpHostConfig`), `claude-code` (was `claude-cli`), `cowork`, and `chatgpt` (was `chatgpt-mac` and `chatgpt-linux`). The model is its own setting.
  - The `mcp_host`, `external_host` and `host` case modes merge into one, since a case is always acted on by its variant's client.
  - `runVariantExperiment` becomes tool optimization.
- **Old names are errors, not aliases.** Validation is already strict. A config that uses an old name fails with a message naming its replacement, so nothing is silently ignored and no alias outlives 2.0.
- **Direct tool calls are tests, not evals.** A case that calls a tool with fixed arguments has nothing acting on it and nothing to compare. Those checks move to Playwright tests with MST's fixtures and matchers, and datasets hold only cases for a client.
- **One reports vocabulary.** Playwright's reporter shows tests. The evals report is organized by run, variant, case and trial, with comparisons against the baseline or an earlier run. It uses only these terms.
