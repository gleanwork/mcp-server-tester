#!/usr/bin/env tsx
/**
 * Preview script for MCP Eval Reporter
 *
 * Generates a preview HTML report with realistic mock data that exercises
 * all UI components including the new Phase 1-5 additions.
 *
 * Usage:
 *   npm run preview-reporter
 *   tsx scripts/preview-reporter.ts
 */

import { writeFile, mkdir, cp } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MCPEvalData } from '../src/types/reporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const mockData: MCPEvalData = {
  runData: {
    timestamp: new Date().toISOString(),
    durationMs: 8231,
    environment: {
      ci: false,
      node: process.version,
      platform: process.platform,
    },
    metrics: {
      total: 18,
      passed: 13,
      failed: 5,
      passRate: 0.722,
      datasetBreakdown: {
        'search-evals': 8,
        'document-evals': 6,
        'llm-host-suite': 4,
      },
      expectationBreakdown: {
        exact: 2,
        schema: 3,
        textContains: 9,
        regex: 4,
        snapshot: 1,
        judge: 4,
        error: 1,
        size: 0,
        toolsTriggered: 4,
        toolCallCount: 2,
      },
    },
    results: [
      // Direct mode — search tool, passing
      {
        id: 'search-basic',
        datasetName: 'search-evals',
        toolName: 'search',
        source: 'eval',
        pass: true,
        baselinePass: true,
        response: {
          content: [
            { type: 'text', text: 'Found 12 results for "quarterly report".' },
          ],
        },
        expectations: {
          textContains: { pass: true, details: 'Contains "quarterly report"' },
          size: { pass: true, details: 'Response size within bounds' },
        },
        authType: 'api-token',
        durationMs: 312,
      },
      // Direct mode — search tool, regression
      {
        id: 'search-empty-query',
        datasetName: 'search-evals',
        toolName: 'search',
        source: 'eval',
        pass: false,
        baselinePass: true,
        response: { content: [{ type: 'text', text: 'No results found.' }] },
        expectations: {
          textContains: {
            pass: false,
            details: 'Expected "results" but got "No results found."',
          },
        },
        authType: 'api-token',
        durationMs: 198,
      },
      // Direct mode — search with multi-iteration
      {
        id: 'search-relevance',
        datasetName: 'search-evals',
        toolName: 'search',
        source: 'eval',
        pass: true,
        baselinePass: false,
        assertionPassRate: 0.8,
        assertionPassRateCI: { lower: 0.37, upper: 0.97 },
        infrastructureErrorRate: 0,
        iterationResults: [
          { pass: true, durationMs: 289 },
          { pass: true, durationMs: 312 },
          { pass: false, durationMs: 445 },
          { pass: true, durationMs: 301 },
          { pass: true, durationMs: 278 },
        ],
        response: {
          content: [{ type: 'text', text: 'Found 8 highly relevant results.' }],
        },
        expectations: {
          judge: {
            pass: true,
            details: 'Score: 0.84 — results are relevant and well-ranked',
          },
        },
        authType: 'api-token',
        tags: ['flaky', 'high-priority'],
        durationMs: 1625,
      },
      // Direct mode — search with infra error in one iteration
      {
        id: 'search-rate-limit',
        datasetName: 'search-evals',
        toolName: 'search',
        source: 'eval',
        pass: true,
        assertionPassRate: 1.0,
        assertionPassRateCI: { lower: 0.54, upper: 1.0 },
        infrastructureErrorRate: 0.2,
        infrastructureErrorCount: 1,
        iterationResults: [
          { pass: true, durationMs: 290 },
          {
            pass: false,
            durationMs: 100,
            isInfrastructureError: true,
            error: 'Rate limit exceeded',
          },
          { pass: true, durationMs: 310 },
          { pass: true, durationMs: 295 },
          { pass: true, durationMs: 288 },
        ],
        response: { content: [{ type: 'text', text: 'Found results.' }] },
        expectations: {
          textContains: { pass: true, details: 'Contains expected text' },
        },
        authType: 'api-token',
        tags: ['rate-limit'],
        durationMs: 1283,
      },
      // Direct mode — create_document, passing
      {
        id: 'create-doc-basic',
        datasetName: 'document-evals',
        toolName: 'create_document',
        source: 'eval',
        pass: true,
        baselinePass: true,
        response: {
          content: [
            {
              type: 'text',
              text: '{"id": "doc-123", "title": "Q4 Report", "url": "https://example.com/doc-123"}',
            },
          ],
        },
        expectations: {
          schema: {
            pass: true,
            details: 'Response matches DocumentCreated schema',
          },
          textContains: { pass: true, details: 'Contains "doc-123"' },
        },
        authType: 'oauth',
        durationMs: 876,
      },
      // Direct mode — create_document, schema fail
      {
        id: 'create-doc-schema-fail',
        datasetName: 'document-evals',
        toolName: 'create_document',
        source: 'eval',
        pass: false,
        baselinePass: false,
        response: {
          content: [{ type: 'text', text: '{"error": "Permission denied"}' }],
        },
        expectations: {
          schema: {
            pass: false,
            details:
              'Missing required field: id\nMissing required field: title',
          },
          error: {
            pass: false,
            details: 'Expected no error but response indicates failure',
          },
        },
        authType: 'oauth',
        tags: ['auth', 'high-priority'],
        durationMs: 234,
      },
      // Direct mode — create_document passing
      {
        id: 'create-doc-with-content',
        datasetName: 'document-evals',
        toolName: 'create_document',
        source: 'eval',
        pass: true,
        baselinePass: true,
        response: {
          content: [
            {
              type: 'text',
              text: '{"id": "doc-456", "title": "Project Plan", "url": "https://example.com/doc-456"}',
            },
          ],
        },
        expectations: {
          exact: { pass: true, details: 'Response matches expected value' },
        },
        authType: 'oauth',
        durationMs: 912,
      },
      // Direct mode — list_tools
      {
        id: 'list-tools-conformance',
        datasetName: 'document-evals',
        toolName: 'list_tools',
        source: 'test',
        pass: true,
        response: {
          content: [
            {
              type: 'text',
              text: 'Available tools: search, create_document, update_document',
            },
          ],
        },
        expectations: {
          textContains: { pass: true, details: 'Contains expected tool names' },
        },
        authType: 'api-token',
        durationMs: 89,
      },
      // Direct mode — update_document
      {
        id: 'update-doc-success',
        datasetName: 'document-evals',
        toolName: 'update_document',
        source: 'eval',
        pass: true,
        baselinePass: true,
        response: {
          content: [
            { type: 'text', text: '{"id": "doc-123", "updated": true}' },
          ],
        },
        expectations: {
          schema: {
            pass: true,
            details: 'Response matches UpdateResult schema',
          },
        },
        authType: 'oauth',
        durationMs: 654,
      },
      // Direct mode — update_document failing
      {
        id: 'update-doc-not-found',
        datasetName: 'document-evals',
        toolName: 'update_document',
        source: 'eval',
        pass: false,
        baselinePass: true,
        error: 'Document doc-999 not found',
        response: null,
        expectations: {
          textContains: {
            pass: false,
            details: 'Expected success response but got error',
          },
        },
        authType: 'oauth',
        tags: ['regression'],
        durationMs: 112,
      },
      // LLM host mode — good precision & recall
      {
        id: 'llm-host-search-scenario',
        datasetName: 'llm-host-suite',
        toolName: 'search',
        source: 'eval',
        pass: true,
        baselinePass: true,
        toolPrecision: 1.0,
        toolRecall: 1.0,
        assertionPassRate: 0.9,
        infrastructureErrorRate: 0,
        iterationResults: [
          {
            pass: true,
            durationMs: 1100,
            mcpHostTrace: {
              calls: [
                {
                  name: 'search',
                  arguments: { query: 'quarterly report' },
                  status: 'expected' as const,
                },
              ],
              missed: [],
            },
          },
          {
            pass: true,
            durationMs: 1250,
            mcpHostTrace: {
              calls: [
                {
                  name: 'search',
                  arguments: { query: 'Q4 report summary' },
                  status: 'expected' as const,
                },
              ],
              missed: [],
            },
          },
          {
            pass: false,
            durationMs: 980,
            mcpHostTrace: {
              calls: [
                {
                  name: 'chat',
                  arguments: { message: 'quarterly report' },
                  status: 'unexpected' as const,
                },
              ],
              missed: [{ name: 'search' }],
            },
          },
          {
            pass: true,
            durationMs: 1150,
            mcpHostTrace: {
              calls: [
                {
                  name: 'search',
                  arguments: { query: 'quarterly results' },
                  status: 'expected' as const,
                },
              ],
              missed: [],
            },
          },
          {
            pass: true,
            durationMs: 1200,
            mcpHostTrace: {
              calls: [
                {
                  name: 'search',
                  arguments: { query: 'Q4 financial report' },
                  status: 'expected' as const,
                },
              ],
              missed: [],
            },
          },
        ],
        response: {
          content: [
            {
              type: 'text',
              text: 'I found 5 relevant documents about the quarterly report.',
            },
          ],
        },
        expectations: {
          toolsTriggered: {
            pass: true,
            details: 'search was called as expected',
          },
          toolCallCount: { pass: true, details: 'Called 1 tool (expected 1)' },
        },
        mcpHostTrace: {
          calls: [
            {
              name: 'search',
              arguments: { query: 'quarterly report' },
              status: 'expected',
            },
          ],
          missed: [],
        },
        authType: 'api-token',
        tags: ['llm-host', 'high-priority'],
        durationMs: 5680,
      },
      // LLM host mode — low recall (missed required tool)
      {
        id: 'llm-host-create-scenario',
        datasetName: 'llm-host-suite',
        toolName: 'create_document',
        source: 'eval',
        pass: false,
        baselinePass: true,
        toolPrecision: 0.5,
        toolRecall: 0.5,
        response: {
          content: [
            {
              type: 'text',
              text: 'I searched for the content but did not create the document.',
            },
          ],
        },
        expectations: {
          toolsTriggered: {
            pass: false,
            details: 'Required tool create_document was not called',
          },
        },
        mcpHostTrace: {
          calls: [
            {
              name: 'search',
              arguments: { query: 'template' },
              status: 'unexpected',
            },
          ],
          missed: [{ name: 'create_document' }],
        },
        authType: 'oauth',
        tags: ['llm-host', 'regression'],
        durationMs: 3200,
      },
      // LLM host mode — unexpected extra tool calls
      {
        id: 'llm-host-multi-tool',
        datasetName: 'llm-host-suite',
        toolName: 'search',
        source: 'eval',
        pass: true,
        toolPrecision: 0.67,
        toolRecall: 1.0,
        response: {
          content: [
            {
              type: 'text',
              text: 'Done — I searched, checked permissions, and found the documents.',
            },
          ],
        },
        expectations: {
          toolsTriggered: { pass: true, details: 'search was called' },
        },
        mcpHostTrace: {
          calls: [
            {
              name: 'search',
              arguments: { query: 'documents' },
              status: 'expected',
            },
            {
              name: 'check_permissions',
              arguments: { resource: 'docs' },
              status: 'unexpected',
            },
            {
              name: 'search',
              arguments: { query: 'more results' },
              status: 'expected',
            },
          ],
          missed: [],
        },
        authType: 'api-token',
        tags: ['llm-host'],
        durationMs: 4100,
      },
      // LLM host — judge fail
      {
        id: 'llm-host-quality-fail',
        datasetName: 'llm-host-suite',
        toolName: 'search',
        source: 'eval',
        pass: false,
        baselinePass: false,
        toolPrecision: 1.0,
        toolRecall: 1.0,
        response: { content: [{ type: 'text', text: 'I found some stuff.' }] },
        expectations: {
          judge: {
            pass: false,
            details:
              'Score: 0.31 — response lacks specificity and citation of results',
          },
          toolsTriggered: {
            pass: true,
            details: 'search was called as expected',
          },
        },
        mcpHostTrace: {
          calls: [
            {
              name: 'search',
              arguments: { query: 'stuff' },
              status: 'expected',
            },
          ],
          missed: [],
        },
        authType: 'api-token',
        tags: ['llm-host', 'quality'],
        durationMs: 2900,
      },
      // Snapshot test
      {
        id: 'snapshot-server-info',
        datasetName: 'document-evals',
        toolName: 'get_server_info',
        source: 'test',
        pass: true,
        response: {
          content: [
            { type: 'text', text: '{"name": "Glean MCP", "version": "1.0.0"}' },
          ],
        },
        expectations: {
          snapshot: { pass: true, details: 'Matches snapshot "server-info"' },
        },
        authType: 'api-token',
        durationMs: 67,
      },
      // Regex test
      {
        id: 'regex-date-format',
        datasetName: 'search-evals',
        toolName: 'search',
        source: 'eval',
        pass: true,
        response: {
          content: [
            { type: 'text', text: 'Last updated: 2026-03-02T14:00:00Z' },
          ],
        },
        expectations: {
          regex: { pass: true, details: 'Matches ISO date pattern' },
        },
        authType: 'api-token',
        durationMs: 234,
      },
      // Error case
      {
        id: 'search-server-error',
        datasetName: 'search-evals',
        toolName: 'search',
        source: 'eval',
        pass: false,
        baselinePass: false,
        error: 'Internal server error: timeout after 30000ms',
        response: null,
        expectations: {
          error: {
            pass: false,
            details: 'Expected success response but got server error',
          },
        },
        authType: 'api-token',
        tags: ['infra'],
        durationMs: 30001,
      },
      // Passing judge
      {
        id: 'judge-response-quality',
        datasetName: 'search-evals',
        toolName: 'search',
        source: 'eval',
        pass: true,
        baselinePass: true,
        response: {
          content: [
            {
              type: 'text',
              text: 'Here are the 5 most relevant documents, ranked by recency and relevance score.',
            },
          ],
        },
        expectations: {
          judge: {
            pass: true,
            details:
              'Score: 0.91 — response is well-structured and accurately summarizes results',
          },
        },
        authType: 'api-token',
        tags: ['quality'],
        durationMs: 1890,
      },
    ],
    conformanceChecks: [
      {
        testTitle: 'MCP Protocol Conformance',
        pass: true,
        checks: [
          {
            name: 'initialize_succeeds',
            pass: true,
            message: 'Server responded to initialize request',
          },
          {
            name: 'tools_list_non_empty',
            pass: true,
            message: 'Server lists 4 tools',
          },
          {
            name: 'tool_schemas_valid',
            pass: true,
            message: 'All tool input schemas are valid JSON Schema',
          },
          {
            name: 'server_info_present',
            pass: true,
            message: 'Server info: Glean MCP v1.0.0',
          },
        ],
        serverInfo: { name: 'Glean MCP', version: '1.0.0' },
        toolCount: 4,
        authType: 'api-token',
      },
    ],
    serverCapabilities: [
      {
        testTitle: 'Available Tools',
        tools: [
          { name: 'search', description: 'Search across all indexed content' },
          {
            name: 'create_document',
            description: 'Create a new document in the workspace',
          },
          {
            name: 'update_document',
            description: 'Update an existing document',
          },
          {
            name: 'get_server_info',
            description: 'Get server version and capabilities',
          },
        ],
        toolCount: 4,
        authType: 'api-token',
      },
    ],
  },
  historical: Array.from({ length: 12 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (11 - i));
    const total = 16 + Math.floor(Math.random() * 4);
    // Simulate improving trend
    const baseRate = 0.55 + i * 0.015 + (Math.random() - 0.5) * 0.05;
    const passRate = Math.min(0.95, Math.max(0.4, baseRate));
    const passed = Math.round(total * passRate);
    return {
      timestamp: date.toISOString(),
      total,
      passed,
      failed: total - passed,
      passRate,
      durationMs: 6000 + Math.floor(Math.random() * 4000),
    };
  }),
};

async function main() {
  console.log('🎭 Generating MCP Eval Reporter preview...\n');

  const outputDir = '.preview-output';
  const uiDistPath = join(__dirname, '../src/reporters/ui-dist');

  await mkdir(outputDir, { recursive: true });
  await cp(uiDistPath, outputDir, { recursive: true, force: true });

  const dataScript = `window.MCP_EVAL_DATA = ${JSON.stringify(mockData, null, 2)};`;
  await writeFile(join(outputDir, 'data.js'), dataScript, 'utf-8');

  console.log('✅ Preview generated!');
  console.log(`📄 Location: ${outputDir}/index.html`);
  console.log(
    `\n📊 Mock Data: ${mockData.runData.metrics.total} cases — ${mockData.runData.metrics.passed} passed, ${mockData.runData.metrics.failed} failed`
  );
  console.log(
    `   Tools: search, create_document, update_document, get_server_info`
  );
  console.log(`   mcp_host cases: 4 (with precision/recall/trace)`);
  console.log(`   Multi-iteration: 2 cases`);
  console.log(`   Historical runs: ${mockData.historical.length}`);

  try {
    const { default: open } = await import('open');
    await open(join(outputDir, 'index.html'));
    console.log('\n🌐 Opened in browser!');
  } catch {
    console.log(
      `\n💡 Open manually: file://${process.cwd()}/${outputDir}/index.html`
    );
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
