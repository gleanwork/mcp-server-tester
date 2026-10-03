// Fixture plugin for the use-case suite: a deterministic "model" host that
// drives real MCP servers, an assistant host with no tool evidence, and a
// keyword judge. Nothing here calls an LLM or the network.
//
// The model host follows a policy instead of reasoning. A policy is a list of
// rules; the first rule whose `when` matches the case is its plan, and each
// step of the plan either calls a visible MCP tool or emits a host-native
// event. Because tools are chosen by the names and descriptions the host can
// see, renaming or re-describing a tool changes what it does, as it would
// for a real model.
//
// Every trace the host returns is appended to the JSONL file named by
// USECASE_LEDGER, so tests can check MST's aggregates against what the host
// actually reported.
import fs from 'node:fs';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';

const ToolMatch = z
  .object({
    name: z.string().optional(),
    nameIncludes: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const Step = z.union([
  z
    .object({
      call: ToolMatch,
      args: z.record(z.string(), z.unknown()).default({}),
      /** Call every matching tool, not only the first. */
      all: z.boolean().default(false),
      /** Only tools the last tool search surfaced are callable. */
      afterSearch: z.boolean().default(false),
      rate: z.number().min(0).max(1).default(1),
    })
    .strict(),
  z
    .object({
      skill: z.string(),
      rate: z.number().min(0).max(1).default(1),
    })
    .strict(),
  z
    .object({
      toolSearch: z.string(),
      rate: z.number().min(0).max(1).default(1),
    })
    .strict(),
]);

const Rule = z
  .object({
    when: z
      .object({
        scenario: z.string().optional(),
        scenarioStartsWith: z.string().optional(),
        instruction: z.string().optional(),
        plugin: z.string().optional(),
        /** The run index (USECASE_RUN), for cases that run more than once. */
        run: z.number().int().nonnegative().optional(),
      })
      .strict()
      .default({}),
    steps: z.array(Step),
  })
  .strict();

const ModelConfig = z
  .object({
    type: z.string(),
    model: z.string().default('scripted-model'),
    systemPrompt: z.string().optional(),
    plugins: z.array(z.string()).default([]),
    policy: z.array(Rule).default([]),
  })
  .strict();

const AssistantConfig = z
  .object({ type: z.string(), answer: z.string() })
  .strict();

/** Runs a step on a deterministic share of iterations: `rate` of every 10. */
function runsOn(rate, iteration) {
  if (!Number.isInteger(iteration))
    throw new Error(`Expected an integer iteration, got ${iteration}.`);
  return iteration % 10 < Math.round(rate * 10);
}

const RUN = Number(process.env.USECASE_RUN ?? '0');

function matches(when, scenario, config) {
  const lower = scenario.toLowerCase();
  if (when.scenario && !lower.includes(when.scenario.toLowerCase()))
    return false;
  if (when.scenarioStartsWith && !scenario.startsWith(when.scenarioStartsWith))
    return false;
  if (
    when.instruction &&
    !(config.systemPrompt ?? '')
      .toLowerCase()
      .includes(when.instruction.toLowerCase())
  )
    return false;
  if (when.plugin && !config.plugins.includes(when.plugin)) return false;
  if (when.run !== undefined && when.run !== RUN) return false;
  return true;
}

function toolMatches(match, tool) {
  if (match.name !== undefined && tool.name !== match.name) return false;
  if (
    match.nameIncludes !== undefined &&
    !tool.name.includes(match.nameIncludes)
  )
    return false;
  if (
    match.description !== undefined &&
    !(tool.description ?? '')
      .toLowerCase()
      .includes(match.description.toLowerCase())
  )
    return false;
  return true;
}

function text(result) {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

async function closeAll(connections) {
  await Promise.allSettled(connections.map(({ client }) => client.close()));
}

/** Connects to a run's servers once and lists their tools. */
async function connect(servers) {
  const connections = [];
  try {
    for (const server of servers) {
      const client = new Client({ name: 'usecase-model', version: '1.0.0' });
      if (server.transport === 'stdio') {
        await client.connect(
          new StdioClientTransport({
            command: server.command,
            args: server.args ?? [],
            env: { PATH: process.env.PATH ?? '', ...(server.env ?? {}) },
          })
        );
      } else if (server.transport === 'http') {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.serverUrl))
        );
      } else {
        throw new Error(
          `The use-case model host connects to stdio and http servers; got ${server.transport}.`
        );
      }
      connections.push({ label: server.label, client, tools: [] });
      connections.at(-1).tools = (await client.listTools()).tools;
    }
    return connections;
  } catch (error) {
    await closeAll(connections);
    throw error;
  }
}

const chars = (value) => JSON.stringify(value ?? '').length;

async function runModel(request, config, connections) {
  const { scenario } = request.input;
  const visible = connections.flatMap((connection) =>
    connection.tools.map((tool) => ({ connection, tool }))
  );
  const rule = config.policy.find((candidate) =>
    matches(candidate.when, scenario, config)
  );
  const events = [];
  const outputs = [];
  let searched;
  for (const step of rule?.steps ?? []) {
    if (!runsOn(step.rate, request.iteration)) continue;
    if ('skill' in step) {
      events.push({ kind: 'skill', source: 'host', name: step.skill });
      continue;
    }
    if ('toolSearch' in step) {
      // Tool search returns the tools whose description shares a word with
      // the query, as a harness's catalog search would.
      const words = step.toolSearch
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 3);
      searched = visible.filter(({ tool }) =>
        words.some((word) =>
          (tool.description ?? '').toLowerCase().includes(word)
        )
      );
      events.push({
        kind: 'tool_search',
        source: 'host',
        name: 'ToolSearch',
        arguments: { query: step.toolSearch },
        results: searched.map(({ connection, tool }) => ({
          name: tool.name,
          ...(connection.label ? { server: connection.label } : {}),
        })),
      });
      continue;
    }
    const pool = step.afterSearch ? (searched ?? []) : visible;
    const picked = pool.filter(({ tool }) => toolMatches(step.call, tool));
    for (const { connection, tool } of step.all ? picked : picked.slice(0, 1)) {
      const result = await connection.client.callTool({
        name: tool.name,
        arguments: step.args,
      });
      const output = text(result);
      outputs.push(output);
      events.push({
        kind: 'tool_call',
        source: 'mcp',
        name: tool.name,
        // Like many hosts, name the server only when there is more than one;
        // MST attributes single-server calls itself.
        ...(connections.length > 1 ? { server: connection.label } : {}),
        arguments: step.args,
        output,
        isError: result.isError === true,
      });
    }
  }
  // Each model turn re-reads the prompt, the tool definitions and every
  // output so far, so more tools and bigger outputs cost more input tokens.
  const prompt =
    chars(config.systemPrompt) +
    chars(scenario) +
    visible.reduce((sum, { tool }) => sum + chars(tool), 0);
  let inputChars = 0;
  for (let turn = 0; turn <= outputs.length; turn += 1) {
    inputChars +=
      prompt + outputs.slice(0, turn).reduce((sum, o) => sum + o.length, 0);
  }
  const calls = events.filter((event) => event.kind === 'tool_call').length;
  const durationMs = 100 + 50 * calls;
  return {
    // The model answers from the last thing it read, so the trace can hold
    // facts the answer leaves out (and a judge must read the answer only).
    finalText: outputs.length
      ? `Answer: ${outputs.at(-1)}`
      : 'I could not find a tool for that.',
    events,
    usage: {
      inputTokens: Math.ceil(inputChars / 4),
      outputTokens: 20 + 15 * calls,
      durationMs,
    },
    durationMs,
  };
}

function record(entry) {
  const ledger = process.env.USECASE_LEDGER;
  if (ledger) fs.appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
}

export default {
  meta: {
    name: 'mst-usecase-fixtures',
    version: '1.0.0',
    namespace: 'usecase',
  },
  hosts: {
    model: {
      schema: ModelConfig,
      evidence: 'structured',
      async runBatch(requests, context) {
        const results = [];
        const pools = new Map();
        try {
          for (const request of requests) {
            const config = ModelConfig.parse(request.config);
            const key = JSON.stringify(request.input.servers);
            if (!pools.has(key))
              pools.set(key, await connect(request.input.servers));
            const result = await runModel(request, config, pools.get(key));
            record({
              arm: context.arm?.name ?? 'default',
              caseId: request.caseId,
              iteration: request.iteration,
              usage: result.usage,
              events: result.events.map(({ kind, source, name, server }) => ({
                kind,
                source,
                name,
                server,
              })),
            });
            results.push(result);
          }
        } finally {
          await Promise.allSettled([...pools.values()].map(closeAll));
        }
        return results;
      },
    },
    assistant: {
      schema: AssistantConfig,
      evidence: 'none',
      async run(input, config, context) {
        const result = {
          finalText: config.answer,
          events: [],
          durationMs: 100,
        };
        record({
          arm: context.arm?.name ?? 'default',
          caseId: null,
          iteration: null,
          events: [],
        });
        return result;
      },
    },
  },
  judges: {
    keywords: {
      schema: z.object({ keywords: z.array(z.string()).min(1) }).strict(),
      async evaluate({ trial }, options) {
        // Judge the host's answer, never its trace.
        const answer = trial.text;
        if (!answer)
          throw new Error('usecase/keywords judges a text response.');
        const haystack = answer.toLowerCase();
        const missing = options.keywords.filter(
          (keyword) => !haystack.includes(keyword.toLowerCase())
        );
        const score =
          (options.keywords.length - missing.length) / options.keywords.length;
        return {
          score,
          reasoning: missing.length
            ? `Missing: ${missing.join(', ')}`
            : 'All keywords present.',
        };
      },
    },
  },
};
