# Security Policy

## Reporting a vulnerability

If you find a security vulnerability in MCP Server Tester, please report it privately.

**Do not open a public GitHub issue.** Email security@glean.com with:

- a description of the vulnerability
- steps to reproduce it
- the version affected (`npx mst --version`)
- any relevant logs, with credentials removed

## Supported versions

Only the latest release is actively supported with security patches.

| Version | Supported |
| ------- | --------- |
| Latest  | ✅        |
| Older   | ❌        |

## Scope

In scope:

- OAuth and token handling (`mst login`, `mst token`, token storage)
- Secrets: `--secrets-file`, `auth.accessTokenEnv` and host credentials, and their redaction from stored results, reports and logs
- The local MCP proxy that serves tool variants to hosts (it listens on 127.0.0.1)
- Processes MST starts (stdio MCP servers, CLI hosts) and plugins it loads. Both run with your privileges by design; a report should show MST running or exposing something you didn't configure.

Out of scope:

- Vulnerabilities in the MCP servers or hosts you test with MST; report those to their maintainers
- Social engineering and denial of service

## Disclosure

We follow coordinated disclosure. Once a fix is released, we publish a security advisory on this repository and credit the reporter, unless they prefer to stay anonymous.
