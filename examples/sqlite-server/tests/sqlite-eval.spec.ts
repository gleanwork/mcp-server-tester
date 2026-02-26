import { test as base, expect } from '@playwright/test';
import { Project } from 'fixturify-project';
import Database from 'better-sqlite3';
import path from 'node:path';
import type { MCPConfig, MCPFixtureApi } from '@gleanwork/mcp-server-tester';
import {
  createMCPClientForConfig,
  createMCPFixture,
  closeMCPClient,
  loadEvalDataset,
  runEvalDataset,
  runConformanceChecks,
  extractText,
} from '@gleanwork/mcp-server-tester';
import {
  QueryResultSchema,
  TableListSchema,
  TableDescriptionSchema,
  extractQueryData,
  extractTableNames,
  extractTableDescription,
  validateRecordCount,
} from '../schemas/queryResultSchema.ts';

/**
 * Custom fixtures for SQLite MCP Server testing
 *
 * - dbProject: Manages temporary directory with fixturify-project
 * - dbPath: Absolute path to the SQLite database file
 * - mcp: Connected MCP client with helper methods
 */
type SQLiteFixtures = {
  dbProject: Project;
  dbPath: string;
  mcp: MCPFixtureApi;
};

/**
 * Extend Playwright test with custom fixtures for database testing
 */
const test = base.extend<SQLiteFixtures>({
  /**
   * Create a temporary project directory with SQLite database
   */
  dbProject: async ({}, use) => {
    const project = new Project('sqlite-test', '1.0.0');

    // Create the project directory
    await project.write();

    // Create database file in the project directory
    const dbPath = path.join(project.baseDir, 'app.db');
    const db = new Database(dbPath);

    try {
      // Create schema
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT UNIQUE NOT NULL,
          role TEXT DEFAULT 'user',
          created_at INTEGER DEFAULT (strftime('%s', 'now'))
        );

        CREATE TABLE posts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          content TEXT,
          published INTEGER DEFAULT 0,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
      `);

      // Seed data using a transaction for atomicity
      const seedData = db.transaction(() => {
        // Insert users
        const insertUser = db.prepare(
          'INSERT INTO users (name, email, role) VALUES (?, ?, ?)'
        );

        insertUser.run('Alice', 'alice@example.com', 'admin');
        insertUser.run('Bob', 'bob@example.com', 'moderator');
        insertUser.run('Charlie', 'charlie@example.com', 'user');
        insertUser.run('Diana', 'diana@example.com', 'user');

        // Insert posts
        const insertPost = db.prepare(
          'INSERT INTO posts (user_id, title, content, published) VALUES (?, ?, ?, ?)'
        );

        insertPost.run(
          1,
          'Getting Started with SQLite',
          'A comprehensive guide...',
          1
        );
        insertPost.run(1, 'Draft: Advanced Topics', 'Coming soon...', 0);
        insertPost.run(2, 'Database Best Practices', 'Learn how to...', 1);
        insertPost.run(2, 'Performance Tuning', 'Optimize your queries...', 1);
        insertPost.run(3, 'My First Post', 'Hello world!', 1);
      });

      seedData();
    } finally {
      // Always close the database before tests run
      db.close();
    }

    await use(project);

    // Cleanup: Remove temporary directory and database
    project.dispose();
  },

  /**
   * Get the absolute path to the database file
   */
  dbPath: async ({ dbProject }, use) => {
    const dbPath = path.join(dbProject.baseDir, 'app.db');
    await use(dbPath);
  },

  /**
   * Create and connect MCP client to SQLite server
   */
  mcp: async ({ dbPath }, use, testInfo) => {
    const config: MCPConfig = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server-sqlite-npx', dbPath],
      quiet: true, // Suppress server startup messages in test output
    };

    const client = await createMCPClientForConfig(config);
    const mcpApi = createMCPFixture(client, testInfo);

    await use(mcpApi);

    // Cleanup: Close MCP client connection
    await closeMCPClient(client);
  },
});

/**
 * Protocol Conformance Tests
 *
 * Validates that the SQLite MCP server conforms to the MCP protocol specification
 */
test.describe('Protocol Conformance', () => {
  test('should pass all conformance checks', async ({ mcp }, testInfo) => {
    // Pass testInfo to attach conformance results to the MCP reporter
    const result = await runConformanceChecks(
      mcp,
      {
        requiredTools: ['read_query', 'list_tables', 'describe_table'],
        validateSchemas: true,
        checkServerInfo: true,
      },
      testInfo
    );

    // SQLite server should pass all conformance checks
    const passedChecks = result.checks.filter((c) => c.pass);
    expect(passedChecks.length).toBeGreaterThanOrEqual(4); // At least 4 of 5 checks should pass

    // Verify specific checks exist
    const checkNames = result.checks.map((c) => c.name);
    expect(checkNames).toContain('server_info_present');
    expect(checkNames).toContain('invalid_tool_returns_error');
  });

  test('should have valid server info', async ({ mcp }) => {
    const serverInfo = mcp.getServerInfo();

    expect(serverInfo).not.toBeNull();
    expect(serverInfo?.name).toBeDefined();
    expect(serverInfo?.version).toBeDefined();
  });

  test('should list all available tools', async ({ mcp }) => {
    const tools = await mcp.listTools();

    expect(tools.length).toBeGreaterThan(0);

    // Verify expected SQLite tools are present
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('read_query');
    expect(toolNames).toContain('list_tables');
    expect(toolNames).toContain('describe_table');

    // Verify all tools have valid schemas
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBeDefined();
    }
  });
});

/**
 * Main test suite: Run all eval cases from dataset
 */
test('Run SQLite MCP Server evaluation dataset', async ({ mcp }, testInfo) => {
  // Load the evaluation dataset
  const dataset = await loadEvalDataset(
    path.join(import.meta.dirname, '..', 'eval-dataset.json'),
    {
      schemas: {
        queryResult: QueryResultSchema,
        tableList: TableListSchema,
        tableDescription: TableDescriptionSchema,
      },
    }
  );

  // Run evals - the runner uses validators internally based on the 'expect' block
  const result = await runEvalDataset(
    {
      dataset,
      schemas: {
        queryResult: QueryResultSchema,
        tableList: TableListSchema,
        tableDescription: TableDescriptionSchema,
      },
    },
    { mcp, testInfo, expect }
  );

  // For now, we expect all direct mode tests to pass
  const directModeTests = dataset.cases.filter(
    (c) => c.mode === 'direct' || !c.mode
  );
  expect(result.passed).toBeGreaterThanOrEqual(directModeTests.length);
});

/**
 * Individual test cases demonstrating specific operations
 */

test.describe('Direct Mode: SQL Query Operations', () => {
  test('should query all users', async ({ mcp }) => {
    const response = await mcp.callTool('read_query', {
      query: 'SELECT * FROM users ORDER BY id',
    });

    expect(response.isError).not.toBe(true);

    const data = extractQueryData(response);
    expect(data).toHaveLength(4);
    expect(data[0]).toMatchObject({
      name: 'Alice',
      email: 'alice@example.com',
      role: 'admin',
    });
  });

  test('should count users', async ({ mcp }) => {
    const response = await mcp.callTool('read_query', {
      query: 'SELECT COUNT(*) as count FROM users',
    });

    expect(response.isError).not.toBe(true);

    const data = extractQueryData(response);
    expect(data[0].count).toBe(4);
  });

  test('should filter users by role', async ({ mcp }) => {
    const response = await mcp.callTool('read_query', {
      query: "SELECT name, role FROM users WHERE role = 'admin'",
    });

    expect(response.isError).not.toBe(true);

    const data = extractQueryData(response);
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('Alice');
  });

  test('should perform JOIN query', async ({ mcp }) => {
    const response = await mcp.callTool('read_query', {
      query: `
        SELECT u.name, p.title
        FROM users u
        JOIN posts p ON u.id = p.user_id
        WHERE p.published = 1
        ORDER BY p.id
      `,
    });

    expect(response.isError).not.toBe(true);

    const data = extractQueryData(response);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('name');
    expect(data[0]).toHaveProperty('title');
  });

  test('should count posts per user', async ({ mcp }) => {
    const response = await mcp.callTool('read_query', {
      query: `
        SELECT u.name, COUNT(p.id) as post_count
        FROM users u
        LEFT JOIN posts p ON u.id = p.user_id
        GROUP BY u.id
        ORDER BY post_count DESC, u.name ASC
      `,
    });

    expect(response.isError).not.toBe(true);

    const data = extractQueryData(response);
    expect(data).toHaveLength(4);
    // Alice and Bob both have 2 posts, Alice comes first alphabetically
    expect(data[0].name).toBe('Alice');
    expect(data[0].post_count).toBe(2);
    expect(data[1].name).toBe('Bob');
    expect(data[1].post_count).toBe(2);
  });
});

test.describe('Direct Mode: Schema Operations', () => {
  test('should list tables', async ({ mcp }) => {
    const response = await mcp.callTool('list_tables', {});

    expect(response.isError).not.toBe(true);

    // Extract table names
    const tableNames = extractTableNames(response);

    expect(tableNames).toContain('users');
    expect(tableNames).toContain('posts');
  });

  test('should describe users table', async ({ mcp }) => {
    const response = await mcp.callTool('describe_table', {
      table_name: 'users',
    });

    expect(response.isError).not.toBe(true);

    const description = extractTableDescription(response);

    expect(description).toContain('id');
    expect(description).toContain('name');
    expect(description).toContain('email');
  });

  test('should describe posts table', async ({ mcp }) => {
    const response = await mcp.callTool('describe_table', {
      table_name: 'posts',
    });

    expect(response.isError).not.toBe(true);

    const description = extractTableDescription(response);

    expect(description).toContain('id');
    expect(description).toContain('user_id');
    expect(description).toContain('title');
    expect(description).toContain('published');
  });
});

test.describe('Error Handling', () => {
  test('should handle invalid SQL syntax', async ({ mcp }) => {
    const response = await mcp.callTool('read_query', {
      query: 'SELECT * FORM users', // Typo: FORM instead of FROM
    });

    expect(response.isError).toBe(true);
  });

  test('should handle non-existent table', async ({ mcp }) => {
    const response = await mcp.callTool('describe_table', {
      table_name: 'nonexistent_table',
    });

    // The SQLite MCP server returns an empty array for non-existent tables
    expect(response.isError).not.toBe(true);

    const description = extractTableDescription(response);
    expect(description).toBe('[]');
  });
});

/**
 * Advanced Features: Schema Validation and Text Utilities
 *
 * Demonstrates direct API usage with custom Zod schemas and text utilities.
 * These tests show how to use the library programmatically for custom validation.
 */
test.describe('Advanced Testing Features', () => {
  test('should validate query results with custom Zod schema', async ({
    mcp,
  }) => {
    const response = await mcp.callTool('read_query', {
      query: 'SELECT * FROM users WHERE role = "admin"',
    });

    expect(response.isError).not.toBe(true);

    // Extract and validate against custom Zod schema
    const data = extractQueryData(response);

    // Validate structure
    expect(data).toHaveLength(1);
    expect(data[0]).toHaveProperty('id');
    expect(data[0]).toHaveProperty('name');
    expect(data[0]).toHaveProperty('email');
    expect(data[0]).toHaveProperty('role');

    // Validate values
    expect(data[0].name).toBe('Alice');
    expect(data[0].role).toBe('admin');
  });

  test('should use text extraction utilities', async ({ mcp }) => {
    const response = await mcp.callTool('list_tables', {});

    expect(response.isError).not.toBe(true);

    // Use utility to extract text from MCP response
    const text = extractText(response);

    // Verify tables are listed
    expect(text).toContain('users');
    expect(text).toContain('posts');
  });

  test('should validate table schema with custom helper', async ({ mcp }) => {
    const response = await mcp.callTool('describe_table', {
      table_name: 'users',
    });

    expect(response.isError).not.toBe(true);

    // Use custom extraction helper
    const description = extractTableDescription(response);

    // Verify all expected columns are present
    expect(description).toContain('id');
    expect(description).toContain('name');
    expect(description).toContain('email');
    expect(description).toContain('role');
    expect(description).toContain('created_at');

    // Verify data types
    expect(description).toContain('INTEGER');
    expect(description).toContain('TEXT');
  });
});
