/**
 * Codex's sandbox mode from MST_JUDGE_SANDBOX: `os` (the default), its own
 * read-only OS sandbox; `container`, none, because the machine is a
 * disposable container that is the sandbox (see codexRuntime.ts). The Codex
 * judge and the `codex` client both read it. A module of its own, so a bundle
 * that only needs this doesn't take the judge runtime's imports.
 */
export function codexSandboxMode(
  env: NodeJS.ProcessEnv = process.env
): 'read-only' | 'danger-full-access' {
  const value = env.MST_JUDGE_SANDBOX?.trim() || 'os';
  if (value === 'os') return 'read-only';
  if (value === 'container') return 'danger-full-access';
  throw new Error(
    `MST_JUDGE_SANDBOX must be "os" or "container", not "${value}".`
  );
}
