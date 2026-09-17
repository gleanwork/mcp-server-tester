import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  rm: vi.fn().mockResolvedValue(undefined),
  rmSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn().mockResolvedValue('/synthetic/cowork-python'),
  rm: mocks.rm,
}));
vi.mock('node:fs', () => ({ rmSync: mocks.rmSync }));
const exits: Array<() => void> = [];
afterEach(() => {
  for (const callback of exits.splice(0))
    process.removeListener('exit', callback);
  vi.restoreAllMocks();
  vi.resetModules();
  vi.clearAllMocks();
});
it('does not install into a worker-provided interpreter', async () => {
  const { ensureCoworkPython } = await import('./pythonRuntime.js');
  expect(
    await ensureCoworkPython({ MST_COWORK_PYTHON: '/worker/python' })
  ).toBe('/worker/python');
  expect(mocks.exec).not.toHaveBeenCalled();
});
it('prepares packaged requirements once and excludes inference credentials from installer processes', async () => {
  mocks.exec.mockImplementation((_command, _args, _options, callback) => {
    callback(null, '', '');
  });
  const before = new Set(process.listeners('exit'));
  const { ensureCoworkPython } = await import('./pythonRuntime.js');
  const env = {
    PATH: '/bin',
    ANTHROPIC_API_KEY: 'private-inference',
    MCP_TOKEN: 'private-mcp',
  };
  const python = await ensureCoworkPython(env);
  expect(await ensureCoworkPython(env)).toBe(python);
  expect(mocks.exec).toHaveBeenCalledTimes(2);
  expect(mocks.exec.mock.calls[1]![1]).toContain('-r');
  expect(mocks.exec.mock.calls[1]![1].at(-1)).toMatch(
    /scripts\/cowork-requirements.txt$/
  );
  expect(mocks.exec.mock.calls[0]![2].env).toEqual({ PATH: '/bin' });
  for (const listener of process.listeners('exit'))
    if (!before.has(listener)) exits.push(listener as () => void);
});
it('cleans failed dependency preparation without leaking process diagnostics', async () => {
  mocks.exec.mockImplementation((_command, _args, _options, callback) => {
    callback(new Error('private-data-from-child'), '', '');
  });
  const { ensureCoworkPython } = await import('./pythonRuntime.js');
  await expect(ensureCoworkPython({})).rejects.toThrow(
    'Unable to prepare Computer Use Python dependencies'
  );
  expect(mocks.rm).toHaveBeenCalledWith('/synthetic/cowork-python', {
    recursive: true,
    force: true,
  });
});
