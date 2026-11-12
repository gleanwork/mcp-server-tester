/**
 * Unit tests must not depend on the developer's LLM gateway setup. With these
 * set, credential resolution changes and a real token helper could run.
 */
for (const name of [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'MST_LLM_AUTH_COMMAND',
  'MST_LLM_AUTH_COMMAND_TTL_MS',
]) {
  delete process.env[name];
}

// Nor on their own ~/.mcp-server-tester/mst.config.json (ADR 0015): empty
// reads none. A test that needs one names it.
process.env.MST_USER_CONFIG = '';
