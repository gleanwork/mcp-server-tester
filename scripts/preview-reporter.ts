#!/usr/bin/env tsx
/**
 * Preview the run report: run a small eval on a scripted client (no model,
 * no network) and print its report's path. With a run directory, write that
 * run's report instead.
 *
 * Usage:
 *   npm run build:ui && npm run preview-reporter            # demo run
 *   npm run preview-reporter -- <run directory>             # an existing run
 *   npm run preview-reporter -- --open                      # and open it
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from '../src/evals/runEval.js';
import { writeRunReport } from '../src/evals/runReport.js';
import type { Plugin } from '../src/plugins/plugin.js';

/** Calls search for most cases; the `terse` variant misses action requests. */
const plugin: Plugin = {
  meta: { name: 'preview', namespace: 'preview' },
  clients: {
    scripted: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      run: async (input, _config, context) => {
        const terse = context.variant?.name === 'terse';
        const action = /^(Create|Post|Send)/.test(input.prompt);
        const calls =
          action && terse && Math.random() < 0.7
            ? []
            : [action ? 'find_skills' : 'search'];
        return {
          finalText: `Done: ${input.prompt}`,
          events: calls.map((name) => ({
            kind: 'tool_call' as const,
            source: 'mcp' as const,
            name,
            server: 'company',
            arguments: { query: input.prompt },
            output: `${name} results for "${input.prompt}"`,
            isError: false,
          })),
          usage: {
            inputTokens: 900 + Math.round(Math.random() * 400),
            outputTokens: 120,
            durationMs: 1200,
          },
        };
      },
    },
  },
};

async function demoRun(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-preview-'));
  const action = (id: string, input: string) => ({
    id,
    input,
    assertions: {
      toolsTriggered: { calls: [{ name: 'find_skills', required: true }] },
    },
  });
  const knowledge = (id: string, input: string) => ({
    id,
    input,
    tags: ['regression'],
    assertions: {
      toolsTriggered: {
        calls: [{ name: 'search', required: true }],
        exclusive: true,
      },
    },
  });
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'preview',
      cases: [
        action('tracker-create', 'Create a tracker ticket for the outage.'),
        action('chat-post', 'Post an update in #payments.'),
        action('mail-send', 'Send the postmortem to billing.'),
        knowledge('search-planning', 'Find the Q3 planning notes.'),
        knowledge('who-owns', 'Who owns the billing service?'),
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'preview',
      datasets: ['./cases.json'],
      client: 'preview/client/scripted',
      model: 'scripted-model',
      servers: {},
      trials: 5,
      redactStoredResponses: false,
      variants: [
        { name: 'terse', description: 'The server’s own short description.' },
        {
          name: 'actions',
          description: 'Names the actions and apps.',
          model: 'scripted-model-2',
        },
      ],
    })
  );
  const result = await runEval({
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
  });
  return result.outputDir;
}

const args = process.argv.slice(2);
const runDirectory = args.find((arg) => !arg.startsWith('--'));
const report = runDirectory
  ? await writeRunReport(path.resolve(runDirectory))
  : path.join(await demoRun(), 'report', 'index.html');
console.log(`Report: ${report}`);
if (args.includes('--open')) {
  const { default: open } = await import('open');
  await open(report);
}
