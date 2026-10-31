import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultSplit } from '../src/evals/labels.js';
import type { ClientBatchRequest } from '../src/evals/evalFrameworkTypes.js';
import {
  calibrationCases,
  LABELS,
  labelOf,
  TRACE_KINDS,
  type CalibrationCase,
  type CalibrationQuestion,
  type TraceKind,
} from '../scripts/calibration/cases.js';
import plugin from '../scripts/calibration/plugin.js';
import { missingVerdicts } from '../scripts/calibration/verdicts.js';

const CALIBRATION = fileURLToPath(
  new URL('../scripts/calibration/', import.meta.url)
);
const FILES = path.join(CALIBRATION, 'files');
const QUESTIONS = Object.keys(LABELS.sound) as CalibrationQuestion[];

describe('the calibration set', () => {
  it('has a unique case for every task in every trace kind', () => {
    const cases = calibrationCases();
    expect(cases).toHaveLength(16 * TRACE_KINDS.length);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it('can make a judge usable: 15 failing and 15 passing test labels for each question', () => {
    const test = calibrationCases().filter(
      (c) => defaultSplit(c.id) === 'test'
    );
    for (const question of QUESTIONS) {
      const labels = test.map((c) => labelOf(c, question));
      expect(
        labels.filter((label) => label === 'fail').length,
        question
      ).toBeGreaterThanOrEqual(15);
      expect(
        labels.filter((label) => label === 'pass').length,
        question
      ).toBeGreaterThanOrEqual(15);
    }
  });

  it('reads files that exist, except in the calls meant to fail', () => {
    const paths = (kind: string) =>
      calibrationCases()
        .filter((c) => c.metadata.kind === kind)
        .flatMap((c) => c.clientOptions.steps)
        .filter((step) => step.tool === 'read_text_file')
        .map((step) => String(step.args.path).replace('{files}', FILES));
    for (const file of [...paths('sound'), ...paths('wrong-tool')])
      expect(existsSync(file), file).toBe(true);
    // A false-success trace's only call fails.
    for (const file of paths('false-success'))
      expect(existsSync(file), file).toBe(false);
  });

  it('builds each kind of trace from its task as the kind says', () => {
    const byTemplate = new Map<string, CalibrationCase[]>();
    for (const c of calibrationCases())
      byTemplate.set(c.metadata.template, [
        ...(byTemplate.get(c.metadata.template) ?? []),
        c,
      ]);
    expect(byTemplate.size).toBe(16);
    for (const [template, cases] of byTemplate) {
      const of = (kind: string) =>
        cases.find((c) => c.metadata.kind === kind)!.clientOptions;
      const sound = of('sound');
      const [right] = sound.steps;
      const failing = of('false-success').steps;
      const at = `${template}: `;
      expect(sound.steps, at + 'sound').toHaveLength(1);
      // The recovered trace starts with the call false-success makes, and
      // ends with the right one.
      const recovered = of('recovered');
      expect(recovered.steps.length, at + 'recovered').toBeGreaterThan(1);
      expect(recovered.steps[0], at + 'recovered').toEqual(failing[0]);
      expect(recovered.steps.at(-1), at + 'recovered').toEqual(right);
      expect(recovered.answer, at + 'recovered').toBe(sound.answer);
      expect(of('wrong-fact').steps, at + 'wrong-fact').toEqual([right]);
      expect(of('wrong-fact').answer, at + 'wrong-fact').not.toBe(sound.answer);
      expect(of('unsupported-claim').steps).toEqual([right]);
      expect(
        of('unsupported-claim').answer.startsWith(`${sound.answer} `)
      ).toBe(true);
      expect(failing, at + 'false-success').toHaveLength(1);
      expect(failing[0], at + 'false-success').not.toEqual(right);
      // The right answer as if the call had worked: for arithmetic, which
      // needs no tool, credited to the tool; else the sound answer.
      const result = /^The answer is (.+)\.$/.exec(sound.answer)?.[1];
      expect(of('false-success').answer, at + 'false-success').toBe(
        result === undefined ? sound.answer : `The calculator gives ${result}.`
      );
      const wrongTool = of('wrong-tool');
      expect(wrongTool.steps, at + 'wrong-tool').toHaveLength(1);
      expect(wrongTool.steps[0], at + 'wrong-tool').not.toEqual(right);
      expect(wrongTool.answer, at + 'wrong-tool').not.toBe(sound.answer);
      const extra = of('extra-calls');
      expect(extra.steps[0], at + 'extra-calls').toEqual(right);
      expect(extra.steps.length, at + 'extra-calls').toBeGreaterThan(1);
      expect(extra.answer, at + 'extra-calls').toBe(sound.answer);
      expect(of('gave-up').steps, at + 'gave-up').toEqual(failing);
      expect(of('gave-up').answer, at + 'gave-up').not.toBe(sound.answer);
    }
  });

  it("labels by the trace's kind, except an arithmetic false-success answer on correctness", () => {
    const byId = new Map(calibrationCases().map((c) => [c.id, c]));
    const label = (id: string, question: CalibrationQuestion) =>
      labelOf(byId.get(id)!, question);
    // It credits the calculator, which the trace contradicts.
    expect(label('multiply-37-12--false-success', 'correctness')).toBeNull();
    expect(label('multiply-37-12--false-success', 'task-completion')).toBe(
      'fail'
    );
    expect(label('weather-lima--false-success', 'correctness')).toBe('pass');
    expect(label('multiply-37-12--sound', 'correctness')).toBe('pass');
  });

  it('refuses a run where a judge has no verdict on some trace, and counts unknown as one', () => {
    const rows = [
      { judge: 'correctness', verdict: 'pass' },
      { judge: 'correctness', verdict: 'unknown' },
      { judge: 'tool-use', verdict: 'fail' },
      { judge: 'tool-use' },
    ];
    expect(missingVerdicts(rows, ['correctness', 'tool-use'], 2)).toEqual([
      'tool-use has verdicts on 1 of 2 traces',
    ]);
    expect(missingVerdicts(rows, ['correctness'], 2)).toEqual([]);
  });

  it('runs every kind of trace on the mock server, recording failed calls as errors', async () => {
    const client = plugin.clients!.scripted!;
    const cases = calibrationCases().filter(
      (c) => c.metadata.template === 'multiply-37-12'
    );
    const server = {
      label: 'mock',
      transport: 'stdio' as const,
      command: process.execPath,
      args: [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./mocks/simpleMCPServer.ts', import.meta.url)),
      ],
    };
    const requests: ClientBatchRequest[] = cases.map((c) => ({
      caseId: c.id,
      trial: 0,
      input: { prompt: c.input, servers: [server] },
      config: {
        type: 'calibration/client/scripted',
        files: FILES,
        ...c.clientOptions,
      },
    }));
    const results = await client.runBatch!(
      requests,
      {} as Parameters<NonNullable<typeof client.runBatch>>[1]
    );
    const trace = new Map(
      cases.map((c, index) => [c.metadata.kind, results[index]!])
    );
    const sound = trace.get('sound');
    const falseSuccess = trace.get('false-success');
    const errors = (kind: TraceKind) =>
      trace.get(kind)!.events.map((event) => event.isError);
    expect(errors('recovered').at(0)).toBe(true);
    expect(errors('recovered').at(-1)).toBe(false);
    expect(trace.get('recovered')!.events.at(-1)!.output).toBe('Result: 444');
    expect(errors('wrong-fact')).toEqual([false]);
    expect(trace.get('wrong-fact')!.finalText).not.toContain('444');
    expect(errors('unsupported-claim')).toEqual([false]);
    expect(errors('wrong-tool')).toEqual([false]);
    expect(trace.get('wrong-tool')!.events[0]!.output).not.toBe('Result: 444');
    expect(errors('extra-calls')).toEqual([false, false, false]);
    expect(errors('gave-up')).toEqual([true]);
    expect(sound).toEqual({
      finalText: 'The answer is 444.',
      events: [
        {
          kind: 'tool_call',
          source: 'mcp',
          name: 'calculate',
          server: 'mock',
          arguments: { operation: 'multiply', a: 37, b: 12 },
          output: 'Result: 444',
          isError: false,
        },
      ],
    });
    expect(falseSuccess!.finalText).toBe('The calculator gives 444.');
    expect(falseSuccess!.events).toEqual([
      expect.objectContaining({
        arguments: { operation: 'multiplys', a: 37, b: 12 },
        isError: true,
      }),
    ]);
  }, 30_000);
});
