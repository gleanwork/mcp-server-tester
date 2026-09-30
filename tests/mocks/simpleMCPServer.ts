/**
 * Simple mock MCP server for testing purposes
 *
 * This is a minimal MCP server that implements basic tools
 * for testing the @gleanwork/mcp-server-tester library
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

// Create server
const server = new McpServer({
  name: 'test-mcp-server',
  version: '1.0.0',
});

// Register a simple echo tool
server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echoes back the input',
    inputSchema: z.object({
      message: z.string().describe('Message to echo'),
    }),
  },
  async ({ message }: { message: string }) => ({
    content: [
      {
        type: 'text',
        text: `Echo: ${message}`,
      },
    ],
    structuredContent: {
      echo: message,
    },
  })
);

// Register a calculation tool
server.registerTool(
  'calculate',
  {
    title: 'Calculate',
    description: 'Performs simple calculations',
    inputSchema: z.object({
      operation: z
        .enum(['add', 'subtract', 'multiply', 'divide'])
        .describe('Operation to perform'),
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    }),
  },
  async ({
    operation,
    a,
    b,
  }: {
    operation: 'add' | 'subtract' | 'multiply' | 'divide';
    a: number;
    b: number;
  }) => {
    let result: number;

    switch (operation) {
      case 'add':
        result = a + b;
        break;
      case 'subtract':
        result = a - b;
        break;
      case 'multiply':
        result = a * b;
        break;
      case 'divide':
        if (b === 0) {
          throw new Error('Division by zero');
        }
        result = a / b;
        break;
      default:
        throw new Error(`Unknown operation: ${String(operation)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: `Result: ${result}`,
        },
      ],
      structuredContent: {
        result,
      },
    };
  }
);

// Register a get_weather mock tool
server.registerTool(
  'get_weather',
  {
    title: 'Get Weather',
    description: 'Gets mock weather data for a city',
    inputSchema: z.object({
      city: z.string().describe('City name'),
    }),
  },
  async ({ city }: { city: string }) => ({
    content: [
      {
        type: 'text',
        text: `Weather for ${city}: 20°C, Sunny`,
      },
    ],
    structuredContent: {
      city,
      temperature: 20,
      conditions: 'Sunny',
    },
  })
);

// Register a get_city_info tool that returns markdown
server.registerTool(
  'get_city_info',
  {
    title: 'Get City Info',
    description: 'Gets formatted city information in markdown',
    inputSchema: z.object({
      city: z.string().describe('City name'),
    }),
  },
  async ({ city }: { city: string }) => {
    const markdown = `## City Information

**City:** ${city}
**Population:** 8.9M
**Country:** United Kingdom

### Features
- Public Transportation
- Cultural Attractions
- Historical Sites
- World-class Museums

### Climate
Temperature: 15°C
Conditions: Partly Cloudy

Last updated: 2025-01-22`;

    return {
      content: [
        {
          type: 'text',
          text: markdown,
        },
      ],
    };
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);

console.error('Test MCP Server started');
