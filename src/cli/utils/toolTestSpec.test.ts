import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  appendToolChecks,
  canAppendToolChecks,
  GENERATED_TESTS_END,
  renderToolTestSpec,
  type ToolCheck,
} from './toolTestSpec.js';

const weather: ToolCheck = {
  id: 'get_weather-1',
  description: 'London weather',
  toolName: 'get_weather',
  args: { city: 'London' },
  containsText: ['temperature', 'it\'s "sunny"'],
  matchesPattern: ['\\d+°C'],
  response: { content: [{ type: 'text', text: 'sunny' }] },
  snapshot: true,
};

/** Syntax errors TypeScript reports for `source`. */
function syntaxErrors(source: string): string[] {
  const file = ts.createSourceFile(
    'generated.spec.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  return (
    (file as unknown as { parseDiagnostics: ts.Diagnostic[] })
      .parseDiagnostics ?? []
  ).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

describe('renderToolTestSpec', () => {
  it('writes one test per call, asserting with the matchers', () => {
    const source = renderToolTestSpec('weather tools', [weather]);
    expect(syntaxErrors(source)).toEqual([]);
    expect(source).toContain(
      "import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';"
    );
    expect(source).toContain('test.describe("weather tools", () => {');
    expect(source).toContain('  // London weather');
    expect(source).toContain(
      '    const result = await mcp.callTool("get_weather", {"city":"London"});'
    );
    expect(source).toContain('    expect(result).not.toBeToolError();');
    expect(source).toContain(
      '    expect(result).toContainToolText(["temperature","it\'s \\"sunny\\""]);'
    );
    expect(source).toContain(
      '    expect(result).toMatchToolPattern(new RegExp("\\\\d+°C"));'
    );
    expect(source).toContain('expect(result).toMatchToolResponse({');
    expect(source).toContain(
      '    await expect(result).toMatchToolSnapshot("get_weather-1");'
    );
    expect(canAppendToolChecks(source)).toBe(true);
  });

  it('asserts only what the check records', () => {
    const source = renderToolTestSpec('minimal', [
      { id: 'ping', toolName: 'ping', args: {} },
    ]);
    expect(syntaxErrors(source)).toEqual([]);
    expect(source).not.toContain('toContainToolText');
    expect(source).not.toContain('toMatchToolSnapshot');
    expect(source).toContain('expect(result).not.toBeToolError();');
  });
});

describe('appendToolChecks', () => {
  it('adds tests above the marker, keeping edits to the file', () => {
    const edited = renderToolTestSpec('weather tools', [weather]).replace(
      'expect(result).not.toBeToolError();',
      'expect(result).not.toBeToolError(); // checked by hand'
    );
    const next = appendToolChecks(edited, [
      { id: 'ping', toolName: 'ping', args: {} },
    ]);
    expect(syntaxErrors(next)).toEqual([]);
    expect(next).toContain('// checked by hand');
    expect(next.indexOf('test("ping"')).toBeGreaterThan(
      next.indexOf('test("get_weather-1"')
    );
    expect(next.indexOf('test("ping"')).toBeLessThan(
      next.indexOf(GENERATED_TESTS_END)
    );
  });

  it('refuses a spec without the marker', () => {
    expect(canAppendToolChecks("test('x', () => {});")).toBe(false);
    expect(() => appendToolChecks("test('x', () => {});", [weather])).toThrow(
      /Choose a new --output file/
    );
  });
});
