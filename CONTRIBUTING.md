# Contributing to @gleanwork/mcp-server-tester

Thank you for your interest in contributing! MST is in active development (2.0 is a release candidate), and community input shapes it. We welcome all types of contributions. For a security issue, see [SECURITY.md](./SECURITY.md) instead of opening an issue.

## Where to Find Things

This file covers setup and the pull request process. The rest has one home each, which people and coding agents both follow:

- [AGENTS.md](./AGENTS.md): the code style, the checks CI runs (the pre-push checklist), the tests each change needs, and how to add a validator, matcher, assertion type, judge provider, client provider, transport or built-in extension
- [CONTEXT.md](./CONTEXT.md): what each term means (eval, case, trial, grader, runner and the rest)
- [REVIEW.md](./REVIEW.md): what a review checks
- [docs/architecture.md](./docs/architecture.md) and [docs/adr/](./docs/adr): the module structure and the design decisions
- [RELEASE.md](./RELEASE.md): how releases work

## Ways to Contribute

- 🐛 **Report bugs** - Found an issue? Let us know!
- 💡 **Suggest features** - Have ideas for improvements?
- 📝 **Improve documentation** - Help make things clearer
- 🔧 **Submit code** - Bug fixes, features, tests, examples
- 🤔 **Ask questions** - Discussions help everyone learn

## Getting Started

### Prerequisites

- **mise** — manages the Node.js version automatically. Install once:

  ```bash
  curl https://mise.run | sh
  ```

  Then `mise install` in the repo root picks up `mise.toml` and activates Node 22.
  If you prefer to manage Node manually, ensure you have **Node.js 22+**.

- **npm** — used for all package operations (comes with Node).

### Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/mcp-server-tester.git
   cd mcp-server-tester
   ```
3. Install the toolchain (if using mise):
   ```bash
   mise install
   ```
4. Install dependencies:
   ```bash
   npm install
   ```
5. Build the project:
   ```bash
   npm run build
   ```

## Development Workflow

### Running Tests

```bash
# Unit tests (Vitest)
npm test
npm run test:watch

# Integration tests (Playwright)
npm run test:playwright
```

Before you push, run the checks in the pre-push checklist in [AGENTS.md](./AGENTS.md#pre-push-checklist). They are the checks CI runs.

### The Docs Site

The docs site in `website/` renders the pages in `docs/`, and serves them and the skills in `skills/` over MCP at `/mcp`. To preview it:

```bash
cd website
npm ci
npm start        # http://localhost:3000, reloads as you edit docs/
```

A new page needs an entry in `website/sidebars.ts`. `npm run build` fails on a broken link, including a relative link to a repo file that doesn't exist. After a build, `npm run test:site` (at the repo root) tests the site's MCP server with MST.

### Making Changes

1. Create a branch named for the change, such as `fix/report-columns`.
2. Follow the code style in [AGENTS.md](./AGENTS.md#code-style).
3. Add a test for each new behavior. [AGENTS.md](./AGENTS.md#tests-for-new-behavior) says what that means for flags, options and branches.
4. Update the docs that describe what you changed.
5. Commit with [Conventional Commits](https://www.conventionalcommits.org/) messages, `type(scope): summary`:

   ```bash
   git commit -m "feat(judges): add a Mistral judge provider"
   git commit -m "fix(cli): report the missing config path"
   git commit -m "docs: explain judge calibration"
   ```

6. Push and open a pull request.

### Testing Guidelines

- **Unit tests** (Vitest) are `*.test.ts` files, mostly next to the code they test in `src/`, plus repo-wide ones in `tests/`.
- **Integration tests** (Playwright) in `tests/` run against the mock servers in `tests/mocks/` with the real MCP SDK.
- **Conformance checks** are proved with a server that breaks the rule (see "Conformance Checking" in [AGENTS.md](./AGENTS.md)).
- Never skip a test without marking it explicitly (`test.skip()`).

## Documentation

When adding features:

1. Update relevant docs in `docs/`
2. Add JSDoc comments to public APIs
3. Include code examples
4. Update README if it affects quick start

## Pull Request Process

1. Update documentation for any changed functionality
2. Add tests for new features
3. Ensure all tests pass
4. Give the pull request one changelog label: `breaking`, `enhancement`,
   `bug`, `documentation` or `internal`. The Changelog label workflow sets it
   from the title: `feat:` and `perf:` are `enhancement`, `fix:` is `bug`,
   `docs:` is `documentation`, `!` is `breaking`, and `build:`, `chore:`,
   `ci:`, `refactor:`, `style:` and `test:` are `internal`, as are dependency
   bumps (`fix(deps):`). Change it when the title's type doesn't fit: a label
   you set stays, and one the workflow set follows the title. The
   workflow fails when the pull request has no changelog label and the title
   gives none, or when it has more than one. A title with `!` always gets
   `breaking`. Don't edit CHANGELOG.md:
   release-it generates each release's section from the merged pull requests'
   titles and labels. Put upgrade steps in `docs/migrations/`.
5. Request review from maintainers

### PR Title Format

Use conventional commit format:

- `feat: add HTTP SSE support`
- `fix: resolve connection timeout issue`
- `docs: improve the assertions guide`

### PR Description

Include:

- What changed and why
- Related issue (if any)
- How to test the changes
- Screenshots (if UI changes)

## Questions or Issues?

- **Documentation**: Check [`docs/`](./docs) directory
- **Examples**: See [`examples/`](./examples) directory
- **Bugs**: [Open an issue](https://github.com/gleanwork/mcp-server-tester/issues)
- **Discussions**: [GitHub Discussions](https://github.com/gleanwork/mcp-server-tester/discussions)

## Code of Conduct

Be respectful, inclusive, and collaborative. We're all here to build something useful together.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing!** Your help makes this project better for everyone.
