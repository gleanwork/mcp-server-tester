# Development Guide

This guide covers contributing to `@gleanwork/mcp-server-tester`, running tests, and building the library.

## Table of Contents

- [Setup](#setup)
- [Running Tests](#running-tests)
- [Building](#building)
- [Code Quality](#code-quality)
- [Project Structure](#project-structure)
- [Contributing](#contributing)

## Setup

### Prerequisites

- Node.js 18 or higher
- npm or yarn

### Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/gleanwork/mcp-server-tester.git
cd server-tester
npm install
```

## Running Tests

The project includes a comprehensive test suite with both unit tests and integration tests.

### Unit Tests (Vitest)

Unit tests cover core functionality:

```bash
# Run all unit tests
npm test

# Run in watch mode
npm run test:watch
```

**Test Coverage:**

- Configuration validation
- Dataset types and loading
- Assertions (exact, schema, textContains, regex, snapshot, judge)
- MCP client factory and fixtures
- LLM client simulation
- Judge implementations (OpenAI, Anthropic)

### Integration Tests (Playwright)

Integration tests use a mock MCP server (5 tests):

```bash
# Run integration tests
npm run test:playwright
```

**Test Coverage:**

- MCP server connection and info
- Tool listing and conformance checks
- Eval dataset execution
- Error handling

### Running All Tests

```bash
# Run both unit and integration tests
npm test && npm run test:playwright
```

### Mock MCP Server

The integration tests use a mock server located at `tests/mocks/simpleMCPServer.ts`.

**Available Tools:**

- `echo` - Echoes back the input
- `calculate` - Performs basic math operations
- `get_weather` - Returns mock weather data

The mock server requires Zod schemas for MCP SDK compatibility.

## Building

### Build Commands

```bash
# Build library (ESM + CJS + .d.ts)
npm run build

# Build in watch mode
npm run dev

# Type check only (no build)
npm run typecheck
```

### Build Output

The build produces:

```
dist/
├── index.js        # ESM build
├── index.cjs       # CommonJS build
└── index.d.ts      # TypeScript declarations
```

**Package Exports:**

The `package.json` exports both ESM and CJS for maximum compatibility:

```json
{
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  }
}
```

## Code Quality

### Linting

```bash
# Run ESLint
npm run lint

# Auto-fix issues
npm run lint:fix
```

### Formatting

```bash
# Format with Prettier
npm run format

# Check formatting
npm run format:check
```

### Pre-commit Checks

Before committing, ensure:

```bash
npm run typecheck  # TypeScript validation
npm run lint       # No lint errors
npm test           # All tests pass
npm run build      # Build succeeds
```

## Project Structure

```
@gleanwork/mcp-server-tester/
├── src/
│   ├── config/       # MCPConfig types + Zod validation
│   ├── mcp/          # Client factory, fixtures, MCPFixtureApi
│   ├── evals/        # Dataset types, loader, runner, grading
│   ├── judge/        # LLM-as-a-judge (OpenAI, Anthropic)
│   ├── spec/         # Protocol conformance checks
│   └── index.ts      # Public API exports
├── tests/
│   ├── mocks/simpleMCPServer.ts  # Mock server for integration tests
│   └── mcp-tests.spec.ts         # Integration test suite
├── examples/         # Example projects
├── docs/            # Documentation
└── dist/            # Build output (generated)
```

### Key Files

**Public API:**

- `src/index.ts` - All exported functions and types

**Fixtures:**

- `src/fixtures/mcp.ts` - Playwright fixture definitions
- `src/mcp/fixtures/mcpFixture.ts` - Fixture implementation

**Configuration:**

- `src/config/mcpConfig.ts` - Transport configuration types and Zod validation schemas

**Evaluations:**

- `src/evals/datasetTypes.ts` - Dataset and case types
- `src/evals/evalRunner.ts` - Dataset execution logic
- `src/assertions/validators/` - All validator implementations

## Contributing

We welcome contributions! Here's how to get started:

### Reporting Issues

1. Check existing issues first
2. Create a new issue with:
   - Clear description
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (Node version, OS, etc.)

### Submitting Pull Requests

1. **Fork the repository**

2. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes**
   - Follow existing code style
   - Add tests for new functionality
   - Update documentation as needed

4. **Run quality checks**

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run test:playwright
   npm run build
   ```

5. **Commit your changes**

   ```bash
   git commit -m "feat: add new feature"
   ```

   Use conventional commit format:
   - `feat:` - New feature
   - `fix:` - Bug fix
   - `docs:` - Documentation changes
   - `test:` - Test changes
   - `refactor:` - Code refactoring
   - `chore:` - Build/tooling changes

6. **Push and create PR**

   ```bash
   git push origin feature/your-feature-name
   ```

   Then open a pull request on GitHub.

### Code Style

Follow these conventions:

1. **Function declarations over expressions**

   ```typescript
   // ✓ Good
   export function createClient() {}

   // ✗ Avoid
   export const createClient = () => {};
   ```

2. **Explicit null over short-circuit**

   ```typescript
   // ✓ Good
   condition ? 'value' : null;

   // ✗ Avoid
   condition && 'value';
   ```

3. **Descriptive type names**

   ```typescript
   // ✓ Good
   (EvalDataset, MCPFixtureApi, Judge);

   // ✗ Avoid
   (Data, Api, Client);
   ```

4. **TypeScript strict mode**
   - No `any` types
   - Prefer type safety
   - Use proper null checks

5. **Async function style**
   - Keep `async` keyword for consistency
   - Even if no `await` currently used

### Adding Features

#### New Validator

1. Create `src/assertions/validators/myValidator.ts` returning `ValidationResult`
2. Export from `src/assertions/validators/index.ts`
3. Add unit tests in `validators.test.ts`
4. Update `docs/assertions.md`

#### New LLM Judge Provider

1. Add provider to `ProviderKind` union in `src/judge/judgeTypes.ts`
2. Create `src/judge/myProviderJudge.ts` implementing `Judge`
3. Add case to `createJudge()` switch in `src/judge/judgeClient.ts`
4. Use environment variables for API keys
5. Add tests
6. Update `docs/assertions.md`

#### New Transport Type

1. Add to `MCPConfig` discriminated union in `src/config/mcpConfig.ts`
2. Update `createMCPClientForConfig()` in `src/mcp/clientFactory.ts` with SDK transport class
3. Update type guards and Zod schema in `src/config/mcpConfig.ts`
4. Add tests
5. Update `docs/transports.md`

### Testing Guidelines

- **Unit tests**: Mock MCP interactions, test logic in isolation
- **Integration tests**: Use `simpleMCPServer.ts` mock with real MCP SDK
- **Conformance tests**: Validate against MCP protocol spec
- Never skip tests without marking them explicitly (`test.skip()`)

### Documentation

When adding features:

1. Update relevant docs in `docs/`
2. Add JSDoc comments to public APIs
3. Include code examples
4. Update `CHANGELOG.md` (if maintaining one)

## Release Process

See [RELEASE.md](../RELEASE.md) for the release process using release-it.

## Getting Help

- **Documentation**: Check [`docs/`](../docs) directory
- **Examples**: See [`examples/`](../examples) directory
- **Issues**: [GitHub Issues](https://github.com/gleanwork/mcp-server-tester/issues)

## License

MIT - See LICENSE file for details
