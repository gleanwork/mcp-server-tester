import type {
  MCPHostSimulationResult,
  LLMToolCall,
} from '../../mcpHostTypes.js';

/** Parses NDJSON (stream-json) output from CLI hosts. */
export function parseStreamJson(stdout: string): MCPHostSimulationResult {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const toolCalls: LLMToolCall[] = [];
  const textParts: string[] = [];
  const conversationHistory: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: string;
  }> = [];

  for (const line of lines) {
    let event: StreamJsonEvent;
    try {
      event = JSON.parse(line) as StreamJsonEvent;
    } catch {
      // Skip non-JSON lines (e.g., debug output)
      continue;
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_use' && block.name) {
          const rawName = block.name;
          const mcpMatch = /^mcp__[^_]+__(.+)$/.exec(rawName);
          toolCalls.push({
            name: mcpMatch ? mcpMatch[1]! : rawName,
            arguments: block.input ?? {},
            id: block.id,
          });
        }

        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        }
      }
    }

    if (event.type === 'user' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'tool_result') {
          const content =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
          conversationHistory.push({ role: 'tool', content });
        }
      }
    }

    if (event.type === 'result' && typeof event.result === 'string') {
      if (textParts.length === 0) {
        textParts.push(event.result);
      }
    }

    if (event.type === 'result' && event.is_error === true) {
      return {
        success: false,
        toolCalls,
        error:
          typeof event.result === 'string'
            ? event.result
            : 'CLI host reported an error',
      };
    }
  }

  const response = textParts.join('');

  if (response) {
    conversationHistory.push({ role: 'assistant', content: response });
  }

  return {
    success: true,
    toolCalls,
    response: response || undefined,
    conversationHistory:
      conversationHistory.length > 0 ? conversationHistory : undefined,
  };
}

/** Creates a parser for CLIs that output a single JSON object with configurable paths. */
export function createJsonParser(paths: {
  toolCalls: string;
  response: string;
  success?: string;
}): (stdout: string) => MCPHostSimulationResult {
  return (stdout: string): MCPHostSimulationResult => {
    const data = JSON.parse(stdout) as Record<string, unknown>;

    const rawToolCalls = getNestedValue(data, paths.toolCalls);
    const toolCalls: LLMToolCall[] = Array.isArray(rawToolCalls)
      ? rawToolCalls.map((tc: Record<string, unknown>) => ({
          name: typeof tc.name === 'string' ? tc.name : '',
          arguments: (tc.arguments ?? tc.args ?? {}) as Record<string, unknown>,
        }))
      : [];

    const response = getNestedValue(data, paths.response);
    const success = paths.success
      ? Boolean(getNestedValue(data, paths.success))
      : true;

    return {
      success,
      toolCalls,
      response: typeof response === 'string' ? response : undefined,
    };
  };
}

interface ContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
}

interface StreamJsonEvent {
  type: string;
  message?: { role?: string; content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current !== null && typeof current === 'object') {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}
