import { ProtocolError } from '@modelcontextprotocol/client';
import type { ServerCapabilities, Tool } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { ConformanceCheckDefinition } from '../registry.js';
import type { MCPConformanceRaw } from '../conformanceChecks.js';

/** Options the core checks read. */
export interface CoreCheckOptions {
  requiredTools: string[];
  validateSchemas: boolean;
  checkServerInfo: boolean;
  checkResources: boolean;
  checkPrompts: boolean;
}

function formatCapabilities(capabilities: ServerCapabilities): string {
  const parts: string[] = [];
  if (capabilities.tools) parts.push('tools');
  if (capabilities.resources) parts.push('resources');
  if (capabilities.prompts) parts.push('prompts');
  if (capabilities.logging) parts.push('logging');
  if (capabilities.completions) parts.push('completions');
  if (capabilities.experimental) parts.push('experimental');
  const extensions = Object.keys(
    (capabilities as { extensions?: Record<string, unknown> }).extensions ?? {}
  );
  if (extensions.length > 0) parts.push(`extensions(${extensions.join(', ')})`);
  return parts.length > 0 ? parts.join(', ') : 'none declared';
}

const schemaValidator = new AjvJsonSchemaValidator();

/** Why a tool's outputSchema does not compile, or null when it does. */
function outputSchemaProblem(tool: Tool): string | null {
  if (tool.outputSchema === undefined) return null;
  try {
    schemaValidator.getValidator(tool.outputSchema);
    return null;
  } catch (error) {
    return `outputSchema does not compile: ${errorMessage(error)}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks that apply to every protocol era. Names and behavior are unchanged
 * from MST 1.x, so legacy-era results stay comparable across releases.
 */
export function coreChecks(
  options: CoreCheckOptions,
  raw: MCPConformanceRaw
): ConformanceCheckDefinition[] {
  const both = ['legacy', 'modern'] as const;
  return [
    {
      name: 'server_info_present',
      eras: both,
      severity: 'must',
      async run({ serverInfo, era }) {
        if (!options.checkServerInfo) return null;
        return {
          // `initialize` results require serverInfo; on 2026-07-28 it is a
          // SHOULD (DiscoverResult / result _meta).
          ...(era === 'modern' ? { severity: 'should' as const } : {}),
          pass: serverInfo !== null,
          message: serverInfo
            ? `Server info: ${serverInfo.name ?? 'unknown'} v${serverInfo.version ?? 'unknown'}`
            : 'Server info is missing',
        };
      },
    },
    {
      name: 'capabilities_valid',
      eras: both,
      severity: 'must',
      async run({ capabilities }) {
        return {
          pass: capabilities !== null,
          message: capabilities
            ? `Server capabilities: ${formatCapabilities(capabilities)}`
            : 'Server capabilities not available',
        };
      },
    },
    {
      name: 'list_tools_succeeds',
      eras: both,
      severity: 'must',
      stopOnFailure: true,
      async run({ tools, toolsError }) {
        return toolsError !== undefined
          ? { pass: false, message: `listTools failed: ${toolsError}` }
          : { pass: true, message: `listTools returned ${tools.length} tools` };
      },
    },
    {
      name: 'required_tools_present',
      eras: both,
      severity: 'must',
      async run({ tools }) {
        if (options.requiredTools.length === 0) return null;
        const names = new Set(tools.map((tool) => tool.name));
        const missing = options.requiredTools.filter(
          (name) => !names.has(name)
        );
        return {
          pass: missing.length === 0,
          message:
            missing.length === 0
              ? `All ${options.requiredTools.length} required tools are present`
              : `Missing required tools: ${missing.join(', ')}`,
        };
      },
    },
    {
      name: 'tool_schemas_valid',
      eras: both,
      severity: 'must',
      async run({ tools }) {
        if (!options.validateSchemas || tools.length === 0) return null;
        const invalid: string[] = [];
        for (const tool of tools) {
          if (!tool.name) {
            invalid.push('(unnamed tool): missing name');
            continue;
          }
          if (!tool.inputSchema) {
            invalid.push(`${tool.name}: missing inputSchema`);
            continue;
          }
          if (tool.inputSchema.type !== 'object') {
            invalid.push(
              `${tool.name}: inputSchema.type must be "object", got "${String(tool.inputSchema.type)}"`
            );
          }
          // An outputSchema must compile: the SDK compiles it before every
          // callTool and rejects the call otherwise (v1 failed listTools).
          const outputProblem = outputSchemaProblem(tool);
          if (outputProblem !== null) {
            invalid.push(`${tool.name}: ${outputProblem}`);
          }
        }
        return {
          pass: invalid.length === 0,
          message:
            invalid.length === 0
              ? `All ${tools.length} tools have valid schemas`
              : `Invalid tool schemas:\n  ${invalid.join('\n  ')}`,
        };
      },
    },
    {
      name: 'list_resources_succeeds',
      eras: both,
      severity: 'must',
      async run({ mcp, capabilities }) {
        if (!options.checkResources || !capabilities?.resources) return null;
        try {
          const result = await mcp.client.listResources();
          raw.resources = result.resources;
          return {
            pass: true,
            message: `listResources returned ${result.resources.length} resources`,
          };
        } catch (error) {
          return {
            pass: false,
            message: `listResources failed: ${errorMessage(error)}`,
          };
        }
      },
    },
    {
      name: 'list_prompts_succeeds',
      eras: both,
      severity: 'must',
      async run({ mcp, capabilities }) {
        if (!options.checkPrompts || !capabilities?.prompts) return null;
        try {
          const result = await mcp.client.listPrompts();
          raw.prompts = result.prompts;
          return {
            pass: true,
            message: `listPrompts returned ${result.prompts.length} prompts`,
          };
        } catch (error) {
          return {
            pass: false,
            message: `listPrompts failed: ${errorMessage(error)}`,
          };
        }
      },
    },
    {
      name: 'invalid_tool_returns_error',
      eras: both,
      severity: 'must',
      async run({ mcp }) {
        try {
          const result = await mcp.callTool('__nonexistent_tool__', {});
          // A protocol error (normalized by MST) or a tool execution error.
          const hasError = result.isError === true;
          return {
            pass: hasError,
            message: hasError
              ? 'Nonexistent tool correctly returned an error'
              : 'Calling nonexistent tool should have returned an error',
          };
        } catch (error) {
          // A custom fixture may let the protocol error throw; that counts.
          // Local failures (timeouts, closed connections) are not an answer.
          const isProtocolError = error instanceof ProtocolError;
          return {
            pass: isProtocolError,
            message: isProtocolError
              ? 'Nonexistent tool correctly threw an error'
              : `Calling nonexistent tool failed locally: ${errorMessage(error)}`,
          };
        }
      },
    },
  ];
}
