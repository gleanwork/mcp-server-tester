import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { ElectronApplication, Page, _electron } from '@playwright/test';
import { launchCodexElectron } from '../../../../src/evals/codex/electron.js';
import type { CodexProcessFacade } from '../../../../src/evals/codex/launcher.js';

type LaunchRequest = NonNullable<Parameters<typeof _electron.launch>[0]>;
let root: string;
let executablePath: string;
let profilePath: string;
let requests: LaunchRequest[];
let processes: CodexProcessFacade;
let child: ChildProcess;
let app: ElectronApplication & EventEmitter;
let page: Page;
let pages: Page[];
let ownedWindow: ReturnType<typeof fakeBrowserWindow>;
let windows: Map<Page, ReturnType<typeof fakeBrowserWindow>>;
let nativeOverrides: Record<string, unknown>;
let nativePid: number;
let launch: typeof _electron.launch;
const nativeEvents: string[] = [];
let onQuit: () => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function invoke<T>(
  callback: (...args: never[]) => T,
  globals: object,
  arg?: unknown,
  secondArg?: unknown
): T {
  return runInNewContext(`(${callback.toString()})(argument, secondArgument)`, {
    ...globals,
    argument: arg,
    secondArgument: secondArg,
  }) as T;
}

function fakePage(
  route = '/home',
  contents = 'Codex',
  url = 'app://-/index.html'
): Page {
  return {
    url: vi.fn(() => url),
    isClosed: vi.fn(() => false),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async (callback: () => unknown) =>
      invoke(callback, {
        location: { pathname: route },
        document: { body: { innerText: contents }, readyState: 'complete' },
      })
    ),
  } as unknown as Page;
}

function fakeBrowserWindow(id: number, url = 'app://-/index.html') {
  const state = {
    id,
    visible: false,
    focused: false,
    destroyed: false,
    contentsDestroyed: false,
    owned: true,
    isDestroyed: vi.fn((): boolean => state.destroyed),
    isVisible: vi.fn((): boolean => state.visible),
    isFocused: vi.fn((): boolean => state.focused),
    webContents: {
      id: id * 10,
      getURL: vi.fn(() => url),
      isDestroyed: vi.fn((): boolean => state.contentsDestroyed),
    },
    show: vi.fn(() => {
      state.visible = true;
    }),
    focus: vi.fn(() => {
      state.focused = true;
    }),
  };
  return state;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-electron-test-')));
  executablePath = join(root, 'ChatGPT.app/Contents/MacOS/ChatGPT');
  profilePath = join(root, 'profile');
  await mkdir(join(root, 'ChatGPT.app/Contents/MacOS'), { recursive: true });
  await writeFile(executablePath, 'offline fixture; never execute', {
    mode: 0o700,
  });
  requests = [];
  nativeOverrides = {};
  nativePid = 4646;
  nativeEvents.length = 0;
  onQuit = () => finish();
  child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 4646 });
  vi.spyOn(child, 'kill').mockImplementation(() => {
    throw new Error('No kill permitted');
  });
  processes = {
    platform: 'darwin',
    readBundleInfo: async () => ({
      identifier: 'com.openai.codex',
      executable: 'ChatGPT',
      version: '26.903.71938',
    }),
    verifyBundleSignature: async () => ({
      teamIdentifier: '2DC432GLL2',
    }),
    listProcesses: async () => [],
    spawn: () => {
      throw new Error('Raw native spawn must not be used');
    },
  };
  page = fakePage();
  pages = [page];
  ownedWindow = fakeBrowserWindow(7);
  windows = new Map([[page, ownedWindow]]);
  app = Object.assign(new EventEmitter(), {
    process: () => child,
    firstWindow: vi.fn(async () => pages[0]),
    windows: vi.fn(() => pages),
    browserWindow: vi.fn(async (target: Page) => ({
      value: windows.get(target),
      dispose: vi.fn(async () => {}),
    })),
    close: vi.fn(async () => {
      throw new Error('Unverified close must not be used');
    }),
    evaluate: vi.fn(
      async (
        callback: (...args: never[]) => unknown,
        arg?: { window: { value: unknown } | null }
      ) => {
        const request = requests.at(-1)!;
        const env = request.env!;
        const processView = {
          pid: nativePid,
          execPath: executablePath,
          env,
          cwd: () => request.cwd,
          getBuiltinModule: (name: string) => {
            expect(name).toBe('inspector');
            return {
              close: () => {
                nativeEvents.push('inspector-close');
              },
            };
          },
        };
        const electronApp = {
          getPath: (name: string) =>
            name === 'home' ? env.HOME : env.CODEX_ELECTRON_USER_DATA_PATH,
          quit: () => {
            nativeEvents.push('app-quit');
            onQuit();
          },
        };
        const result = invoke(
          callback,
          { process: processView, setTimeout },
          {
            app: electronApp,
            BrowserWindow: {
              getAllWindows: () => [...new Set(windows.values())],
              fromId: (id: number) =>
                [...windows.values()].find(
                  (candidate) =>
                    candidate.id === id &&
                    candidate.owned &&
                    !candidate.destroyed
                ),
            },
          },
          arg ? { ...arg, window: arg.window?.value ?? null } : undefined
        );
        nativeEvents.push('evaluate-ack');
        return typeof result === 'object' && result !== null
          ? { ...result, ...nativeOverrides }
          : result;
      }
    ),
  }) as unknown as ElectronApplication & EventEmitter;
  launch = vi.fn(async (request: LaunchRequest) => {
    requests.push(request);
    return app;
  });
});

function finish(code = 0, signal: NodeJS.Signals | null = null): void {
  Object.assign(child, { exitCode: code, signalCode: signal });
  child.emit('exit', code, signal);
  app.emit('close', app);
}

function start(timeoutMs = 2000, cleanupTimeoutMs = 1000) {
  return launchCodexElectron(
    {
      executablePath,
      profilePath,
      executionDeadline: Date.now() + timeoutMs,
      cleanupTimeoutMs,
      windowReady: () => {
        const dom = globalThis as typeof globalThis & {
          location: { pathname: string };
          document: { body: { innerText: string } };
        };
        return {
          readyRoute: dom.location.pathname === '/home',
          appContents: dom.document.body.innerText === 'Codex',
        };
      },
    },
    { processes, electron: { launch } }
  );
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('Codex Electron public boundary (offline)', () => {
  it('selects the unique ready owned page, shows and focuses its public BrowserWindow before readiness or an action', async () => {
    const splash = fakePage('/loading', 'Loading');
    const splashWindow = fakeBrowserWindow(3);
    windows.set(splash, splashWindow);
    pages = [splash, page];
    const handle = start();
    const session = await handle.ready;
    expect(session.window).toBe(page);
    expect(app.firstWindow).not.toHaveBeenCalled();
    expect(app.browserWindow).toHaveBeenCalledWith(page);
    expect(splashWindow.show).not.toHaveBeenCalled();
    expect(session.windowProof).toEqual({
      pid: 4646,
      browserWindowId: 7,
      webContentsId: 70,
      owned: true,
      destroyed: false,
      webContentsDestroyed: false,
      visible: true,
      focused: true,
      readyRoute: true,
      appContents: true,
    });
    ownedWindow.visible = false;
    ownedWindow.focused = false;
    const action = vi.fn(async (target: Page) => {
      expect(target).toBe(page);
      expect(ownedWindow.visible).toBe(true);
      expect(ownedWindow.focused).toBe(true);
      return 'one action';
    });
    expect(await session.runOnce(action)).toBe('one action');
    expect(action).toHaveBeenCalledTimes(1);
    expect((await handle.quit()).status).toBe('exited');
  });

  it('continues within the original deadline when the first startup Page mapping is transient, then maps the same owned ready page', async () => {
    vi.mocked(app.browserWindow).mockRejectedValueOnce(
      new Error(
        'electronApplication.browserWindow: Page is not an Electron window'
      )
    );
    const handle = start();

    const session = await handle.ready;

    expect(session.window).toBe(page);
    expect(app.browserWindow).toHaveBeenNthCalledWith(1, page);
    expect(app.browserWindow).toHaveBeenNthCalledWith(2, page);
    expect(session.windowProof).toMatchObject({
      pid: 4646,
      browserWindowId: 7,
      webContentsId: 70,
      owned: true,
      visible: true,
      focused: true,
      readyRoute: true,
      appContents: true,
    });
    expect(ownedWindow.show).toHaveBeenCalledTimes(1);
    expect(ownedWindow.focus).toHaveBeenCalledTimes(1);
    expect((await handle.quit()).status).toBe('exited');
  });

  it.each([
    'page.evaluate: Execution context was destroyed, most likely because of a navigation',
    'electronApplication.browserWindow: Cannot find context with specified id',
  ])(
    'continues after a read-only startup mapping navigation race: %s',
    async (message) => {
      vi.mocked(app.browserWindow).mockRejectedValueOnce(new Error(message));
      const handle = start();

      const session = await handle.ready;

      expect(session.window).toBe(page);
      expect(app.browserWindow).toHaveBeenNthCalledWith(1, page);
      expect(app.browserWindow).toHaveBeenNthCalledWith(2, page);
      expect(requests).toHaveLength(1);
      expect((await handle.quit()).status).toBe('exited');
    }
  );

  it('quarantines a startup mapping race when the retained Playwright child identity changes', async () => {
    const replacement = new ChildProcess();
    Object.defineProperty(replacement, 'pid', { value: 4646 });
    vi.mocked(app.browserWindow).mockImplementationOnce(async () => {
      Object.assign(app, { process: () => replacement });
      throw new Error(
        'electronApplication.browserWindow: Page is not an Electron window'
      );
    });
    const handle = start();

    await expect(handle.ready).rejects.toMatchObject({
      stage: 'window-ownership',
      reason: 'ownership',
    });

    expect(app.browserWindow).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(ownedWindow.show).not.toHaveBeenCalled();
    Object.assign(app, { process: () => child });
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it('maps the pinned null-target failure through the unique exact-URL public native window before activation and actions', async () => {
    vi.mocked(app.browserWindow).mockRejectedValue(
      new TypeError(
        "electronApplication.browserWindow: Cannot read properties of null (reading 'getOwnerBrowserWindow')"
      )
    );
    const handle = start();
    const session = await handle.ready;
    expect(session.window).toBe(page);
    expect(session.windowProof).toEqual({
      pid: 4646,
      browserWindowId: 7,
      webContentsId: 70,
      owned: true,
      destroyed: false,
      webContentsDestroyed: false,
      visible: true,
      focused: true,
      readyRoute: true,
      appContents: true,
    });
    expect(ownedWindow.show).toHaveBeenCalledTimes(1);
    expect(ownedWindow.focus).toHaveBeenCalledTimes(1);
    ownedWindow.visible = false;
    ownedWindow.focused = false;
    const action = vi.fn(async (target: Page) => {
      expect(target).toBe(page);
      expect(ownedWindow.visible).toBe(true);
      expect(ownedWindow.focused).toBe(true);
      return 'one action';
    });
    expect(await session.runOnce(action)).toBe('one action');
    expect(action).toHaveBeenCalledTimes(1);
    expect(ownedWindow.show).toHaveBeenCalledTimes(2);
    expect(ownedWindow.focus).toHaveBeenCalledTimes(2);
    expect(app.firstWindow).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('exited');
  });

  it('rejects ambiguous exact-URL native windows on the pinned null-target mapping path without activating either one', async () => {
    vi.mocked(app.browserWindow).mockRejectedValue(
      new TypeError(
        "Cannot read properties of null (reading 'getOwnerBrowserWindow')"
      )
    );
    const otherWindow = fakeBrowserWindow(8);
    // A native window need not have a corresponding Page in application.windows().
    windows.set(fakePage(), otherWindow);
    const handle = start();
    await expect(handle.ready).rejects.toMatchObject({
      stage: 'window-ownership',
      message: expect.stringContaining('ambiguous'),
    });
    expect(ownedWindow.show).not.toHaveBeenCalled();
    expect(otherWindow.show).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it('requires a unique exact-URL application Page when public native mapping is used, even for one native window', async () => {
    vi.mocked(app.browserWindow).mockRejectedValue(
      new Error(
        "electronApplication.browserWindow: TypeError: Cannot read properties of null (reading 'getOwnerBrowserWindow')"
      )
    );
    pages = [page, fakePage()];
    const handle = start();
    await expect(handle.ready).rejects.toMatchObject({
      stage: 'window-ownership',
      message: expect.stringContaining('ambiguous'),
    });
    expect(ownedWindow.show).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it('uses exact URL equality rather than the first native window and excludes destroyed native windows from mapping', async () => {
    vi.mocked(app.browserWindow).mockRejectedValue(
      new Error(
        "TypeError: Cannot read properties of null (reading 'getOwnerBrowserWindow')"
      )
    );
    const otherWindow = fakeBrowserWindow(8, 'app://-/index.html?other=1');
    const destroyedWindow = fakeBrowserWindow(9);
    destroyedWindow.destroyed = true;
    const destroyedContents = fakeBrowserWindow(10);
    destroyedContents.contentsDestroyed = true;
    windows = new Map([
      [fakePage(), otherWindow],
      [fakePage(), destroyedWindow],
      [fakePage(), destroyedContents],
      [page, ownedWindow],
    ]);
    const handle = start();
    const session = await handle.ready;
    expect(session.windowProof).toMatchObject({
      browserWindowId: 7,
      webContentsId: 70,
      owned: true,
      visible: true,
      focused: true,
    });
    expect(otherWindow.show).not.toHaveBeenCalled();
    expect(destroyedWindow.show).not.toHaveBeenCalled();
    expect(destroyedContents.show).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('exited');
  });

  it.each([
    'destroyed',
    'contentsDestroyed',
    'owned',
    'mapping',
    'webContents',
    'closed',
    'pageURL',
    'nativeURL',
    'pid',
    'nativeWindows',
    'equivalentPages',
  ] as const)(
    'blocks actions before activation when exact-URL mapping loses %s proof',
    async (change) => {
      vi.mocked(app.browserWindow).mockRejectedValue(
        new TypeError(
          "Cannot read properties of null (reading 'getOwnerBrowserWindow')"
        )
      );
      const handle = start();
      const session = await handle.ready;
      ownedWindow.show.mockClear();
      ownedWindow.focus.mockClear();
      const replacement = fakeBrowserWindow(8);
      if (change === 'mapping') windows.set(page, replacement);
      else if (change === 'webContents') ownedWindow.webContents.id = 71;
      else if (change === 'closed')
        vi.mocked(page.isClosed).mockReturnValue(true);
      else if (change === 'pageURL')
        vi.mocked(page.url).mockReturnValue('app://-/index.html#changed');
      else if (change === 'nativeURL')
        ownedWindow.webContents.getURL.mockReturnValue(
          'app://-/index.html?changed=1'
        );
      else if (change === 'pid') nativePid = 9999;
      else if (change === 'nativeWindows') windows.set(fakePage(), replacement);
      else if (change === 'equivalentPages') pages = [page, fakePage()];
      else ownedWindow[change] = change !== 'owned';
      const action = vi.fn(async () => 'must not run');
      await expect(session.runOnce(action)).rejects.toMatchObject({
        stage: 'window-ownership',
      });
      expect(action).not.toHaveBeenCalled();
      expect(ownedWindow.show).not.toHaveBeenCalled();
      expect(ownedWindow.focus).not.toHaveBeenCalled();
      expect(replacement.show).not.toHaveBeenCalled();
      expect((await handle.quit()).status).toBe('quarantined');
    }
  );

  it.each(['browserWindow', 'webContents'] as const)(
    'requires positive %s IDs before any native activation',
    async (field) => {
      if (field === 'browserWindow') ownedWindow.id = 0;
      else ownedWindow.webContents.id = 0;
      vi.useFakeTimers();
      const handle = start(1000);
      const failed = expect(handle.ready).rejects.toThrow(/deadline/i);
      await vi.waitFor(() => expect(app.browserWindow).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(1001);
      await failed;
      await handle.settled();
      expect(ownedWindow.show).not.toHaveBeenCalled();
      expect(ownedWindow.focus).not.toHaveBeenCalled();
      const cleanup = handle.quit();
      await vi.advanceTimersByTimeAsync(110);
      expect((await cleanup).status).toBe('quarantined');
    }
  );

  it('does not use URL mapping to mask unrelated Playwright mapping failures', async () => {
    vi.mocked(app.browserWindow).mockRejectedValue(
      new Error('private unrelated failure')
    );
    const handle = start();
    const error = await handle.ready.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ stage: 'window-ownership' });
    expect(String(error)).not.toContain('private');
    expect(ownedWindow.webContents.getURL).not.toHaveBeenCalled();
    expect(ownedWindow.show).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it('rejects ambiguous ready owned windows without activating either one', async () => {
    const other = fakePage();
    const otherWindow = fakeBrowserWindow(8);
    pages = [page, other];
    windows.set(other, otherWindow);
    const handle = start();
    await expect(handle.ready).rejects.toMatchObject({
      stage: 'window-selection',
    });
    expect(ownedWindow.show).not.toHaveBeenCalled();
    expect(otherWindow.show).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it.each(['destroyed', 'contentsDestroyed', 'owned'] as const)(
    'ignores an otherwise ready auxiliary page with invalid %s proof',
    async (field) => {
      const other = fakePage();
      const otherWindow = fakeBrowserWindow(8);
      otherWindow[field] = field !== 'owned';
      pages = [other, page];
      windows.set(other, otherWindow);
      const handle = start();
      const session = await handle.ready;
      expect(session.window).toBe(page);
      expect(other.evaluate).not.toHaveBeenCalled();
      expect(otherWindow.show).not.toHaveBeenCalled();
      expect((await handle.quit()).status).toBe('exited');
    }
  );

  it.each([
    'destroyed',
    'contentsDestroyed',
    'owned',
    'mapping',
    'webContents',
    'closed',
  ] as const)(
    'blocks an action when retained window %s proof changes',
    async (change) => {
      const handle = start();
      const session = await handle.ready;
      ownedWindow.show.mockClear();
      const replacement = fakeBrowserWindow(8);
      if (change === 'mapping') windows.set(page, replacement);
      else if (change === 'webContents') ownedWindow.webContents.id = 71;
      else if (change === 'closed')
        vi.mocked(page.isClosed).mockReturnValue(true);
      else ownedWindow[change] = change !== 'owned';
      const action = vi.fn(async () => 'must not run');
      await expect(session.runOnce(action)).rejects.toMatchObject({
        stage: 'window-ownership',
      });
      expect(action).not.toHaveBeenCalled();
      expect(ownedWindow.show).not.toHaveBeenCalled();
      expect(replacement.show).not.toHaveBeenCalled();
      expect((await handle.quit()).status).toBe('quarantined');
    }
  );

  it.each(['readyRoute', 'appContents'] as const)(
    'requires %s proof again before an action',
    async (field) => {
      const handle = start();
      const session = await handle.ready;
      vi.mocked(page.evaluate).mockResolvedValue({
        readyRoute: true,
        appContents: true,
        [field]: false,
      });
      ownedWindow.show.mockClear();
      const action = vi.fn(async () => 'must not run');
      await expect(session.runOnce(action)).rejects.toMatchObject({
        stage: 'window-readiness',
      });
      expect(action).not.toHaveBeenCalled();
      expect(ownedWindow.show).not.toHaveBeenCalled();
      expect((await handle.quit()).status).toBe('quarantined');
    }
  );

  it('keeps a hidden window unready when native show and focus have no effect', async () => {
    ownedWindow.show.mockImplementation(() => {});
    ownedWindow.focus.mockImplementation(() => {});
    vi.useFakeTimers();
    const handle = start(1000);
    const failed = expect(handle.ready).rejects.toMatchObject({
      stage: 'window-visibility',
      reason: 'deadline',
    });
    await vi.waitFor(() => expect(ownedWindow.focus).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1001);
    await failed;
    expect(ownedWindow.show).toHaveBeenCalledTimes(1);
    await handle.settled();
    const cleanup = handle.quit();
    await vi.advanceTimersByTimeAsync(110);
    expect((await cleanup).status).toBe('quarantined');
  });

  it('does not publish stale ready-content proof when the page changes during native activation', async () => {
    ownedWindow.focus.mockImplementation(() => {
      ownedWindow.focused = true;
      vi.mocked(page.evaluate).mockResolvedValue({
        readyRoute: false,
        appContents: true,
      });
    });
    const handle = start();
    await expect(handle.ready).rejects.toMatchObject({
      stage: 'window-readiness',
    });
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it('rechecks native identity after post-activation DOM proof before dispatching an action', async () => {
    const handle = start();
    const session = await handle.ready;
    vi.mocked(page.evaluate)
      .mockResolvedValueOnce({ readyRoute: true, appContents: true })
      .mockImplementationOnce(async () => {
        ownedWindow.destroyed = true;
        return { readyRoute: true, appContents: true };
      });
    const action = vi.fn(async () => 'must not run');
    await expect(session.runOnce(action)).rejects.toMatchObject({
      stage: 'window-ownership',
    });
    expect(action).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it('waits for public visible and focused state after a single show/focus request', async () => {
    ownedWindow.show.mockImplementation(() => {});
    ownedWindow.focus.mockImplementation(() => {
      setTimeout(() => {
        ownedWindow.visible = true;
        ownedWindow.focused = true;
      }, 20);
    });
    const handle = start();
    const session = await handle.ready;
    expect(session.windowProof).toMatchObject({ visible: true, focused: true });
    expect(ownedWindow.show).toHaveBeenCalledTimes(1);
    expect(ownedWindow.focus).toHaveBeenCalledTimes(1);
    expect((await handle.quit()).status).toBe('exited');
  });

  it('reports visibility failures without renderer payloads and never dispatches an action', async () => {
    const handle = start();
    const session = await handle.ready;
    const failure = new Error('private DOM, URL, or project payload');
    failure.name = 'TimeoutError';
    ownedWindow.show.mockImplementation(() => {
      throw failure;
    });
    const action = vi.fn(async () => 'must not run');
    const error = await session
      .runOnce(action)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: 'CodexElectronFailure',
      stage: 'window-visibility',
      errorName: 'TimeoutError',
      reason: 'timeout',
    });
    expect(String(error)).not.toMatch(/private DOM|project payload/);
    expect(error).not.toHaveProperty('cause');
    expect(action).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it.each([
    'pid',
    'executablePath',
    'userData',
    'home',
    'envHome',
    'codexHome',
    'workspacePath',
  ])(
    'refuses a native %s mismatch before exposing a renderer and keeps the profile quarantined',
    async (field) => {
      nativeOverrides[field] = field === 'pid' ? 9999 : '/not-the-owned-path';
      const handle = start();
      await expect(handle.ready).rejects.toThrow(
        'Codex native path confirmation failed'
      );
      expect(app.firstWindow).not.toHaveBeenCalled();
      await expect(start().ready).rejects.toThrow(/leased|quarantined/i);
      expect(requests).toHaveLength(1);
    }
  );

  it('blocks renderer actions after the caller explicitly quarantines the session', async () => {
    const handle = start();
    const session = await handle.ready;
    await session.quarantine();
    const action = vi.fn(async () => 'must not run');
    await expect(session.runOnce(action)).rejects.toThrow(/quarantined/i);
    expect(action).not.toHaveBeenCalled();
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it('does not start later renderer reads after cleanup expires while a native path read is pending', async () => {
    const inspection = deferred<unknown>();
    vi.mocked(app.evaluate).mockImplementationOnce(
      async () => inspection.promise
    );
    const handle = start(2000, 300);
    await vi.waitFor(() => expect(app.evaluate).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    const cleanup = handle.quit();
    await vi.advanceTimersByTimeAsync(301);
    expect((await cleanup).status).toBe('quarantined');
    inspection.resolve({
      pid: 4646,
      executablePath,
      userData: `${profilePath}/electron`,
      home: `${profilePath}/home`,
      envHome: `${profilePath}/home`,
      codexHome: `${profilePath}/codex`,
      workspacePath: requests[0]!.cwd,
    });
    await expect(handle.ready).rejects.toThrow(/quarantined|shutdown/i);
    await handle.settled();
    expect(app.firstWindow).not.toHaveBeenCalled();
    expect(app.close).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses one execution deadline but gives cooperative shutdown a fresh cleanup allowance', async () => {
    const handle = start(1000, 1000);
    const session = await handle.ready;
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(1001);
    const action = vi.fn(async () => 'not dispatched');
    await expect(session.runOnce(action)).rejects.toThrow(/deadline/i);
    expect(action).not.toHaveBeenCalled();
    const cleanup = handle.quit();
    await vi.advanceTimersByTimeAsync(110);
    expect((await cleanup).status).toBe('exited');
  });

  it('drains pending native visibility work without a late action or late quit after cleanup expires', async () => {
    const handle = start(1000, 300);
    const session = await handle.ready;
    const visibility = deferred<unknown>();
    const evaluate = vi.mocked(app.evaluate);
    evaluate.mockClear();
    evaluate.mockImplementationOnce(async () => visibility.promise);
    const callback = vi.fn(async () => 'must not run');
    vi.useFakeTimers();
    const action = session.runOnce(callback);
    const failed = expect(action).rejects.toMatchObject({
      stage: 'window-visibility',
      reason: 'deadline',
    });
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1001);
    await failed;
    nativeEvents.length = 0;
    const cleanup = handle.quit();
    await vi.advanceTimersByTimeAsync(301);
    expect((await cleanup).status).toBe('quarantined');
    let drained = false;
    const drain = handle.settled().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe(false);
    visibility.resolve({
      pid: 4646,
      browserWindowId: 7,
      webContentsId: 70,
      owned: true,
      destroyed: false,
      webContentsDestroyed: false,
      visible: true,
      focused: true,
    });
    await drain;
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).not.toHaveBeenCalled();
    expect(nativeEvents).toEqual([]);
    expect(app.close).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('quarantines pending actions without cancellation or a late quit, even after they settle', async () => {
    const handle = start(1000, 300);
    const session = await handle.ready;
    vi.useFakeTimers();
    const operation = deferred<void>();
    const action = session.runOnce(async () => operation.promise);
    const failed = expect(action).rejects.toThrow(/deadline|action failed/i);
    await vi.advanceTimersByTimeAsync(1001);
    await failed;
    nativeEvents.length = 0;
    const cleanup = handle.quit();
    await vi.advanceTimersByTimeAsync(301);
    expect((await cleanup).status).toBe('quarantined');
    expect(nativeEvents).toEqual([]);
    operation.resolve();
    await handle.settled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(nativeEvents).toEqual([]);
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
    await expect(start().ready).rejects.toThrow(/leased|quarantined/i);
  });

  it('bounds a pending launch without enabling Playwright timeout cancellation and retains a late child', async () => {
    const launched = deferred<ElectronApplication>();
    launch = vi.fn(async (request: LaunchRequest) => {
      requests.push(request);
      return launched.promise;
    });
    vi.useFakeTimers();
    const handle = start(1000, 300);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(1));
    const failed = expect(handle.ready).rejects.toThrow(
      /deadline|quarantined/i
    );
    await vi.advanceTimersByTimeAsync(1001);
    await failed;
    expect(requests[0]?.timeout).toBe(0);
    const cleanup = handle.quit();
    await vi.advanceTimersByTimeAsync(301);
    expect((await cleanup).status).toBe('quarantined');
    launched.resolve(app);
    await handle.settled();
    expect(handle.child).toBe(child);
    expect(app.evaluate).not.toHaveBeenCalled();
    expect(app.close).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    vi.useRealTimers();
    await expect(start().ready).rejects.toThrow(/leased|quarantined/i);
  });

  it.each(['close-without-exit', 'exit-without-close'])(
    'keeps incomplete shutdown quarantined, including %s',
    async (mode) => {
      const handle = start(2000, 300);
      const session = await handle.ready;
      onQuit = () => {
        if (mode === 'close-without-exit') app.emit('close', app);
        else {
          Object.assign(child, { exitCode: 0 });
          child.emit('exit', 0, null);
        }
      };
      vi.useFakeTimers();
      const cleanup = handle.quit();
      await vi.advanceTimersByTimeAsync(301);
      expect((await cleanup).status).toBe('quarantined');
      expect(child.kill).not.toHaveBeenCalled();
      expect(app.close).not.toHaveBeenCalled();
      finish();
      expect((await session.exited).status).toBe('quarantined');
      expect(handle.quit()).toBe(cleanup);
      vi.useRealTimers();
      await expect(start().ready).rejects.toThrow(/leased|quarantined/i);
    }
  );

  it('retries only read-only startup navigation races, then exposes a bounded DOM reader', async () => {
    vi.mocked(page.evaluate).mockRejectedValueOnce(
      new Error(
        'page.evaluate: Execution context was destroyed, most likely because of a navigation'
      )
    );
    const handle = start();
    const session = await handle.ready;
    // One navigation retry, then the required post-activation readiness proof.
    expect(page.evaluate).toHaveBeenCalledTimes(3);
    expect(await session.readDOM(() => 'read-only fixture')).toBe(
      'read-only fixture'
    );
    expect((await handle.quit()).status).toBe('exited');
  });

  it('distinguishes load navigation timeouts from visibility and action failures', async () => {
    const handle = start();
    const session = await handle.ready;
    const error = new Error('private navigation URL and DOM');
    error.name = 'TimeoutError';
    vi.mocked(page.waitForLoadState).mockRejectedValue(error);
    const failure = await session
      .readDOM(() => 'read')
      .catch((caught: unknown) => caught);
    expect(failure).toMatchObject({
      stage: 'renderer-navigation',
      errorName: 'TimeoutError',
      reason: 'timeout',
    });
    expect(String(failure)).not.toContain('private navigation');
    expect((await handle.quit()).status).toBe('exited');
  });

  it('does not expose arbitrary error names from a failed action', async () => {
    const handle = start();
    const session = await handle.ready;
    const error = new Error('private renderer message');
    error.name = 'private-project-name';
    const failure = await session
      .runOnce(async () => {
        throw error;
      })
      .catch((caught: unknown) => caught);
    expect(failure).toMatchObject({
      stage: 'renderer-action',
      errorName: 'Error',
    });
    expect(String(failure)).not.toContain('private');
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it('does not retry unrelated read failures or expose their raw details', async () => {
    vi.mocked(page.evaluate).mockRejectedValue(
      new Error('private renderer details')
    );
    const handle = start();
    await expect(handle.ready).rejects.toThrow('Codex renderer read failed');
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect((await handle.quit()).status).toBe('quarantined');
  });

  it.each(['Playwright', 'exact-URL'])(
    'never retries or rearms a submit callback after a navigation failure with %s mapping',
    async (mapping) => {
      if (mapping === 'exact-URL')
        vi.mocked(app.browserWindow).mockRejectedValue(
          new TypeError(
            "Cannot read properties of null (reading 'getOwnerBrowserWindow')"
          )
        );
      const handle = start();
      const session = await handle.ready;
      const submit = vi.fn(async () => {
        throw new Error(
          'Execution context was destroyed, most likely because of a navigation'
        );
      });
      await expect(session.runOnce(submit)).rejects.toMatchObject({
        name: 'CodexElectronFailure',
        message: expect.stringContaining('Codex renderer action failed'),
        stage: 'renderer-action',
        errorName: 'Error',
        reason: 'navigation',
      });
      await expect(session.runOnce(submit)).rejects.toThrow(/quarantined/i);
      expect(submit).toHaveBeenCalledTimes(1);
      expect((await handle.quit()).status).toBe('quarantined');
    }
  );

  it('acknowledges the deferred shutdown before closing inspector, requests normal quit once, and waits for process exit', async () => {
    const handle = start();
    const session = await handle.ready;
    nativeEvents.length = 0;
    const shutdown = handle.quit();
    expect(handle.quit()).toBe(shutdown);
    expect(await shutdown).toMatchObject({
      status: 'exited',
      exit: { code: 0, signal: null },
    });
    expect(nativeEvents).toEqual([
      'evaluate-ack',
      'inspector-close',
      'app-quit',
    ]);
    expect(app.close).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect((await session.exited).status).toBe('exited');
    const previousWorkspace = session.workspacePath;
    const previousProfile = session.profile.id;
    Object.assign(child, { exitCode: null, signalCode: null });
    const second = start();
    const reused = await second.ready;
    expect(reused.profile.id).toBe(previousProfile);
    expect(reused.profile.paths).toEqual(session.profile.paths);
    expect(reused.workspacePath).not.toBe(previousWorkspace);
    expect((await second.quit()).status).toBe('exited');
  });

  it('quarantines without signaling when a passive helper remains active', async () => {
    const passive = {
      pid: 5151,
      executablePath: join(
        root,
        'ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152.0.7977.83/Helpers/browser_crashpad_handler'
      ),
      startIdentity: 'passive-start',
    };
    processes.listProcesses = async () =>
      requests.length > 0 ? [passive] : [];
    const handle = start();
    await handle.ready;
    nativeEvents.length = 0;

    expect((await handle.quit()).status).toBe('quarantined');
    expect(nativeEvents).toEqual([
      'evaluate-ack',
      'inspector-close',
      'app-quit',
    ]);
    expect('requestSignal' in processes).toBe(false);
    expect(app.close).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('does not treat unsolicited clean process exit as a completed shutdown handshake', async () => {
    const handle = start();
    const session = await handle.ready;
    finish();
    expect((await session.exited).status).toBe('quarantined');
    expect((await handle.quit()).status).toBe('quarantined');
    await expect(start().ready).rejects.toThrow(/leased|quarantined/i);
  });

  it('launches only the explicit native app with private confirmed paths and an actual retained child', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'must-not-inherit');
    vi.stubEnv('NODE_OPTIONS', '--require=must-not-inherit');
    const handle = start();
    const session = await handle.ready;
    expect(session.child).toBe(child);
    expect(session.application).toBe(app);
    expect(session.window).toBe(page);
    expect(session.native).toEqual({
      pid: 4646,
      executablePath,
      userData: `${profilePath}/electron`,
      home: `${profilePath}/home`,
      envHome: `${profilePath}/home`,
      codexHome: `${profilePath}/codex`,
      workspacePath: session.workspacePath,
    });
    expect(requests).toEqual([
      expect.objectContaining({
        executablePath,
        args: [
          `--user-data-dir=${profilePath}/electron`,
          '--force-renderer-accessibility',
        ],
        cwd: session.workspacePath,
        timeout: 0,
        env: expect.objectContaining({
          HOME: `${profilePath}/home`,
          CODEX_HOME: `${profilePath}/codex`,
        }),
      }),
    ]);
    expect(requests[0]?.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(requests[0]?.env).not.toHaveProperty('NODE_OPTIONS');
    expect(session.workspacePath).toMatch(/\/codex-electron-workspace-/);
    expect(session.workspacePath.startsWith(`${root}/`)).toBe(false);
    expect(session.workspacePath.startsWith(`${profilePath}/`)).toBe(false);
    expect(await realpath(session.workspacePath)).toBe(session.workspacePath);
    expect((await stat(session.workspacePath)).mode & 0o777).toBe(0o700);
    expect(session.workspaceOwnership).toMatchObject({
      kind: 'codex-electron-workspace',
      version: 1,
      path: session.workspacePath,
      markerPath: join(session.workspacePath, '.owner.json'),
    });
    expect(
      JSON.parse(await readFile(session.workspaceOwnership.markerPath, 'utf8'))
    ).toEqual({
      kind: 'codex-electron-workspace',
      version: 1,
      id: session.workspaceOwnership.id,
      path: session.workspacePath,
      uid: process.getuid!(),
    });
    expect(
      (await stat(session.workspaceOwnership.markerPath)).mode & 0o777
    ).toBe(0o600);
    finish(1);
    expect((await session.exited).status).toBe('quarantined');
    await expect(stat(session.workspacePath)).resolves.toBeDefined();
  });
});
