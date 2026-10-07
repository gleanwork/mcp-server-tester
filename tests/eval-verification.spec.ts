/**
 * End-to-end verification of the eval runner in a Playwright test: trials and
 * pass rates, concurrency, tool-call assertions, and reporter attachments.
 *
 * The cases run on a scripted client (a custom executeCase) that calls the
 * mock stdio server's real tools, so the run needs no model.
 */
import { test, expect } from '../src/fixtures/mcp.js';
import {
  runEvalDataset,
  loadEvalDataset,
  type CaseExecution,
  type EvalCase,
  type MCPFixtureApi,
} from '../src/index.js';
import { clientRunToExecution } from '../src/evals/clientTrace.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * A scripted client: `echo <message>` calls echo, `add <a> <b>` calls
 * calculate. It answers with the tool's text and reports the call.
 */
function scriptedClient(mcp: MCPFixtureApi) {
  return async (evalCase: EvalCase): Promise<CaseExecution> => {
    const [verb, ...rest] = evalCase.input.split(' ');
    const [name, args]: [string, Record<string, unknown>] =
      verb === 'add'
        ? [
            'calculate',
            { operation: 'add', a: Number(rest[0]), b: Number(rest[1]) },
          ]
        : ['echo', { message: rest.join(' ') }];
    const result = await mcp.callTool(name, args);
    const text = (result.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('');
    return clientRunToExecution(
      {
        finalText: text,
        events: [{ kind: 'tool_call', source: 'mcp', name, arguments: args }],
      },
      'structured'
    );
  };
}

test.describe('Eval Enhancement Verification', () => {
  test('multi-trial pass rate fields are populated', async ({
    mcp,
  }, testInfo) => {
    const dataset = await loadEvalDataset(
      join(__dirname, '../data/eval-verification.json')
    );

    const result = await runEvalDataset(
      { dataset, executeCase: scriptedClient(mcp) },
      { mcp, testInfo }
    );

    // All cases should pass
    expect(result.passed).toBe(result.total);

    // Multi-trial cases should have passRate and trialResults
    const multiIterCases = result.caseResults.filter(
      (r) => r.trialResults !== undefined
    );

    expect(multiIterCases.length).toBeGreaterThan(0);

    for (const r of multiIterCases) {
      expect(r.passRate).toBeDefined();
      expect(r.passRate).toBeGreaterThanOrEqual(0);
      expect(r.passRate).toBeLessThanOrEqual(1);
      expect(Array.isArray(r.trialResults)).toBe(true);
    }

    // Log passRate results for inspection
    console.log('Assertion pass rate results:');
    for (const r of multiIterCases) {
      const trialCount = r.trialResults?.length ?? 0;
      console.log(
        `  ${r.id}: passRate=${(r.passRate ?? 0).toFixed(2)}, trials=${trialCount}, pass=${r.pass}`
      );
    }
  });

  test('echo multi-trial case: 3 trials, all pass', async ({
    mcp,
  }, testInfo) => {
    const dataset = await loadEvalDataset(
      join(__dirname, '../data/eval-verification.json')
    );

    const result = await runEvalDataset(
      { dataset, executeCase: scriptedClient(mcp) },
      { mcp, testInfo }
    );

    const echoCase = result.caseResults.find(
      (r) => r.id === 'multi-iter-echo-always-passes'
    );
    expect(echoCase).toBeDefined();
    expect(echoCase?.passRate).toBe(1.0);
    expect(echoCase?.trialResults).toHaveLength(3);
    expect(echoCase?.trialResults?.every((iter) => iter.pass)).toBe(true);
    expect(echoCase?.pass).toBe(true);
  });

  test('calculate multi-trial case: 5 trials, deterministic', async ({
    mcp,
  }, testInfo) => {
    const dataset = await loadEvalDataset(
      join(__dirname, '../data/eval-verification.json')
    );

    const result = await runEvalDataset(
      { dataset, executeCase: scriptedClient(mcp) },
      { mcp, testInfo }
    );

    const calcCase = result.caseResults.find(
      (r) => r.id === 'multi-iter-calculate-addition'
    );
    expect(calcCase).toBeDefined();
    expect(calcCase?.passRate).toBe(1.0); // 7+3=10 is always correct
    expect(calcCase?.trialResults).toHaveLength(5);
    expect(calcCase?.pass).toBe(true); // 1.0 >= 0.8 threshold
  });

  test('single-trial case: no passRate fields', async ({ mcp }, testInfo) => {
    const dataset = await loadEvalDataset(
      join(__dirname, '../data/eval-verification.json')
    );

    const result = await runEvalDataset(
      { dataset, executeCase: scriptedClient(mcp) },
      { mcp, testInfo }
    );

    const baselineCase = result.caseResults.find(
      (r) => r.id === 'single-iter-baseline'
    );
    expect(baselineCase).toBeDefined();
    expect(baselineCase?.passRate).toBeUndefined();
    expect(baselineCase?.trialResults).toBeUndefined();
    expect(baselineCase?.pass).toBe(true);
  });

  test('concurrency: running dataset with concurrency=2 completes correctly', async ({
    mcp,
  }, testInfo) => {
    const dataset = await loadEvalDataset(
      join(__dirname, '../data/eval-verification.json')
    );

    const result = await runEvalDataset(
      { dataset, concurrency: 2, executeCase: scriptedClient(mcp) },
      { mcp, testInfo }
    );

    // All cases pass, total count matches dataset
    expect(result.total).toBe(4);
    expect(result.passed).toBe(4);
  });

  test('calculate multi-trial case: 5 trials, deterministic result', async ({
    mcp,
  }, testInfo) => {
    const dataset = await loadEvalDataset(
      join(__dirname, '../data/eval-verification.json')
    );

    const result = await runEvalDataset(
      { dataset, executeCase: scriptedClient(mcp) },
      { mcp, testInfo }
    );

    const calcCase = result.caseResults.find(
      (r) => r.id === 'multi-iter-calculate-addition'
    );
    expect(calcCase).toBeDefined();
    expect(calcCase?.passRate).toBe(1.0); // 7+3=10 is always correct
    expect(calcCase?.trialResults).toHaveLength(5);
    expect(calcCase?.pass).toBe(true); // 1.0 >= 0.8 threshold
  });
});
