# Transport Configuration

MCP servers can be accessed via different transport mechanisms. This guide covers all supported transport types and their configuration.

## Table of Contents

- [Transport Types](#transport-types)
- [Stdio (Local Server)](#stdio-local-server)
- [HTTP (Remote Server)](#http-remote-server)
- [Multiple Transports](#multiple-transports)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Transport Types

`@gleanwork/mcp-server-tester` supports two transport types:

1. **stdio** - Local server processes (via stdin/stdout)
2. **HTTP** - Remote servers (via HTTP/SSE)

Choose based on your server deployment:

- Use **stdio** for local development and testing
- Use **HTTP** for remote servers or production environments

## Stdio (Local Server)

The stdio transport starts a local MCP server as a child process and communicates via standard input/output.

### Basic Configuration

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'mcp-local',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['path/to/server.js'],
        },
      },
    },
  ],
});
```

### Configuration Options

```typescript
{
  transport: 'stdio',
  command: string,           // Command to run (e.g., 'node', 'python', 'deno')
  args?: string[],           // Command arguments
  env?: Record<string, string>, // Environment variables
  capabilities?: {           // MCP capabilities
    roots?: { listChanged?: boolean },
    sampling?: { ... },
  },
}
```

> **Debug Logging:** Enable with `DEBUG=mcp-server-tester:* npm test`

### Examples

**Node.js Server:**

```typescript
mcpConfig: {
  transport: 'stdio',
  command: 'node',
  args: ['dist/server.js'],
}
```

**TypeScript with ts-node:**

```typescript
mcpConfig: {
  transport: 'stdio',
  command: 'npx',
  args: ['ts-node', 'src/server.ts'],
}
```

**Python Server:**

```typescript
mcpConfig: {
  transport: 'stdio',
  command: 'python',
  args: ['server.py'],
  env: {
    PYTHONPATH: '/path/to/modules',
  },
}
```

**Deno Server:**

```typescript
mcpConfig: {
  transport: 'stdio',
  command: 'deno',
  args: ['run', '--allow-all', 'server.ts'],
}
```

**With Environment Variables:**

```typescript
mcpConfig: {
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
  env: {
    NODE_ENV: 'test',
    API_KEY: 'test-key',
    LOG_LEVEL: 'debug',
  },
}
```

**With Debug Logging:**

```bash
# Enable debug logging via environment variable
DEBUG=mcp-server-tester:* npm test
```

### Process Management

The stdio transport automatically:

- Starts the server process when tests begin
- Manages stdin/stdout communication
- Terminates the process when tests complete
- Handles process errors and crashes

## HTTP (Remote Server)

The HTTP transport connects to a remote MCP server via HTTP and Server-Sent Events (SSE).

### Basic Configuration

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'mcp-remote',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'http://localhost:3000/mcp',
        },
      },
    },
  ],
});
```

### Configuration Options

```typescript
{
  transport: 'http',
  serverUrl: string,              // MCP server URL
  requestTimeoutMs?: number,      // Request timeout (default: 30000)
  headers?: Record<string, string>, // Custom HTTP headers
}
```

### Examples

**Local HTTP Server:**

```typescript
mcpConfig: {
  transport: 'http',
  serverUrl: 'http://localhost:3000/mcp',
}
```

**Remote Server with Authentication:**

```typescript
mcpConfig: {
  transport: 'http',
  serverUrl: 'https://api.example.com/mcp',
  headers: {
    'Authorization': 'Bearer your-token-here',
    'X-API-Key': 'your-api-key',
  },
}
```

For OAuth 2.1 authentication and more advanced auth patterns, see the [Authentication Guide](./authentication.md).

**With Custom Timeout:**

```typescript
mcpConfig: {
  transport: 'http',
  serverUrl: 'http://localhost:3000/mcp',
  requestTimeoutMs: 60000, // 60 seconds
}
```

**Production Server:**

```typescript
mcpConfig: {
  transport: 'http',
  serverUrl: process.env.MCP_SERVER_URL || 'https://mcp.production.com',
  headers: {
    'Authorization': `Bearer ${process.env.MCP_API_TOKEN}`,
  },
  requestTimeoutMs: 45000,
}
```

### Connection Management

The HTTP transport:

- Establishes HTTP connection on first use
- Maintains SSE stream for server events
- Closes connection when tests complete

> **Note:** Automatic reconnection is not currently implemented. If the remote
> server drops the connection mid-test-suite, subsequent tests will fail with
> connection errors. For production use against unreliable servers, implement
> reconnect logic at the Playwright `globalSetup` level or use Playwright's
> retry mechanism.

## Multiple Transports

Test against multiple server configurations using Playwright projects:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    // Local development server
    {
      name: 'local-dev',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['dist/server.js'],
          env: { NODE_ENV: 'development' },
        },
      },
    },

    // Local production build
    {
      name: 'local-prod',
      use: {
        mcpConfig: {
          transport: 'stdio',
          command: 'node',
          args: ['dist/server.js'],
          env: { NODE_ENV: 'production' },
        },
      },
    },

    // Staging server
    {
      name: 'staging',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://staging.example.com/mcp',
          headers: {
            Authorization: `Bearer ${process.env.STAGING_TOKEN}`,
          },
        },
      },
    },

    // Production server
    {
      name: 'production',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://api.example.com/mcp',
          headers: {
            Authorization: `Bearer ${process.env.PROD_TOKEN}`,
          },
        },
      },
    },
  ],
});
```

### Running Specific Projects

```bash
# Run all projects
npx playwright test

# Run only local tests
npx playwright test --project=local-dev

# Run only remote tests
npx playwright test --project=staging --project=production
```

## Environment Variables

Use environment variables for sensitive data and environment-specific config:

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'mcp',
      use: {
        mcpConfig: {
          transport: process.env.MCP_TRANSPORT || 'stdio',
          // Stdio config
          ...(process.env.MCP_TRANSPORT === 'stdio' && {
            command: process.env.MCP_COMMAND || 'node',
            args: [process.env.MCP_SERVER_PATH || 'server.js'],
          }),
          // HTTP config
          ...(process.env.MCP_TRANSPORT === 'http' && {
            serverUrl: process.env.MCP_SERVER_URL,
            headers: {
              Authorization: `Bearer ${process.env.MCP_API_TOKEN}`,
            },
          }),
        },
      },
    },
  ],
});
```

### Example .env File

```bash
# Transport type
MCP_TRANSPORT=stdio

# Stdio config
MCP_COMMAND=node
MCP_SERVER_PATH=dist/server.js
NODE_ENV=test

# HTTP config (when MCP_TRANSPORT=http)
# MCP_SERVER_URL=https://api.example.com/mcp
# MCP_API_TOKEN=your-token-here
```

Load with `dotenv`:

```bash
npm install --save-dev dotenv
```

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  // ... config using process.env
});
```

## Troubleshooting

### Stdio Transport Issues

**Issue:** Server process fails to start

```
Error: Command not found: node server.js
```

**Solutions:**

- Verify command exists: `which node`
- Use absolute paths: `/usr/local/bin/node`
- Check file exists: `ls -la server.js`
- Ensure executable permissions: `chmod +x server.js`

**Issue:** Server starts but doesn't respond

**Solutions:**

- Enable debug logging: `DEBUG=mcp-server-tester:* npm test`
- Check server logs for errors
- Verify server writes to stdout (not stderr)
- Ensure server follows MCP protocol

**Issue:** Environment variables not set

**Solutions:**

- Use `env` option in config
- Check variable names and values
- Verify dotenv is loaded before config

### HTTP Transport Issues

**Issue:** Connection refused

```
Error: connect ECONNREFUSED localhost:3000
```

**Solutions:**

- Verify server is running: `curl http://localhost:3000/mcp`
- Check correct port and host
- Ensure server accepts HTTP connections
- Check firewall rules

**Issue:** Request timeout

```
Error: Request timeout after 30000ms
```

**Solutions:**

- Increase timeout: `requestTimeoutMs: 60000`
- Check server response time
- Verify server isn't blocking
- Look for network issues

**Issue:** Authentication failure

```
Error: 401 Unauthorized
```

**Solutions:**

- Verify API token is correct
- Check header format: `Authorization: Bearer <token>`
- Ensure token hasn't expired
- Test authentication separately: `curl -H "Authorization: Bearer <token>" <url>`

## Next Steps

- See the [Quick Start Guide](./quickstart.md) for basic setup
- Learn about [Authentication](./authentication.md) for OAuth and token auth
- Check the [API Reference](./api-reference.md) for config type details
- Explore [Examples](../examples) for real-world configurations
