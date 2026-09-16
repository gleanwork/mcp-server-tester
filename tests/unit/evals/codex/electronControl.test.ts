import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import type { CodexElectronSession } from '../../../../src/evals/codex/electron.js';
import {
  CodexElectronControlError,
  createCodexElectronControl,
  type CodexElectronDOMObservation,
} from '../../../../src/evals/codex/electronControl.js';

const workspaceBasename = 'codex-electron-workspace-grlvvW';
const workspace = `/tmp/${workspaceBasename}`;
const prompt = 'First line\nSecond line';

interface BrowserTestNode {
  readonly nodeType: number;
  readonly tagName?: string;
  readonly textContent: string;
  readonly innerText?: string;
  readonly childNodes: readonly BrowserTestNode[];
  readonly disabled?: boolean;
  getAttribute?(name: string): string | null;
  querySelectorAll?(selector: string): readonly BrowserTestNode[];
}

interface BrowserTestGlobal {
  readonly document: Pick<BrowserTestNode, 'querySelectorAll'>;
  readonly location: { readonly href: string };
}

interface NavigationTargetFixture {
  readonly kind: string;
  readonly name: string;
  readonly text: string;
}

function browserText(text: string): BrowserTestNode {
  return { nodeType: 3, textContent: text, childNodes: [] };
}

function browserElement(
  tagName: string,
  children: readonly BrowserTestNode[] = [],
  options: {
    textContent?: string;
    innerText?: string;
    attributes?: Readonly<Record<string, string>>;
    disabled?: boolean;
    queries?: Readonly<Record<string, readonly BrowserTestNode[]>>;
  } = {}
): BrowserTestNode {
  return {
    nodeType: 1,
    tagName,
    textContent:
      options.textContent ??
      children.map((child) => child.textContent).join(''),
    innerText: options.innerText,
    childNodes: children,
    disabled: options.disabled,
    getAttribute(name) {
      return options.attributes?.[name] ?? null;
    },
    querySelectorAll(selector) {
      return options.queries?.[selector] ?? [];
    },
  };
}

function pinnedLocalTargets(): readonly NavigationTargetFixture[] {
  return [
    {
      kind: 'workspace-project',
      name: `Change project: ${workspaceBasename}`,
      text: workspaceBasename,
    },
    { kind: 'add-context', name: 'Add context', text: '' },
    { kind: 'permissions', name: 'Permissions', text: 'Ask for approval' },
    {
      kind: 'reasoning',
      name: 'Select effort',
      text: 'GPT-5.6 LunaMedium',
    },
  ];
}

function authenticatedBrowserDOM(
  composerChildren: readonly BrowserTestNode[],
  options: {
    composerText?: string;
    footerTexts?: readonly string[];
    interactive?: readonly BrowserTestNode[];
    navigationTargets?: readonly NavigationTargetFixture[];
  } = {}
): BrowserTestGlobal {
  const composerText = options.composerText ?? '';
  const send = browserElement('BUTTON', [], {
    textContent: '',
    attributes: { 'aria-label': 'Send' },
  });
  const composerButtons = [
    browserElement('BUTTON', [], {
      attributes: { 'aria-label': 'Add files' },
    }),
    browserElement('BUTTON', [], {
      attributes: { 'aria-label': 'Options' },
    }),
    send,
  ];
  const composer = browserElement('DIV', composerChildren, {
    innerText: composerText,
    queries: {},
  });
  const navigationTargets = (
    options.navigationTargets ?? pinnedLocalTargets()
  ).map((target) =>
    browserElement('BUTTON', [], {
      textContent: target.text,
      attributes: {
        'data-composer-navigation-target': target.kind,
        'aria-label': target.name,
      },
    })
  );
  const root = browserElement(
    'DIV',
    [composer, ...composerButtons, ...navigationTargets],
    {
      queries: {
        '[data-codex-composer="true"][role="textbox"][contenteditable="true"]':
          [composer],
        '[data-composer-navigation-target]': navigationTargets,
        button: composerButtons,
      },
    }
  );
  const mode = browserElement('BUTTON', [], {
    attributes: { 'aria-label': 'Switch mode, current mode: Codex' },
  });
  const footers = (
    options.footerTexts ?? [
      workspaceBasename,
      'Ask for approval',
      'Select effortGPT-5.6 LunaMedium',
    ]
  ).map((text) => browserElement('DIV', [browserText(text)]));
  const selectorResults: Readonly<Record<string, readonly BrowserTestNode[]>> =
    {
      '[data-codex-composer-root][data-composer-placement="home"]': [root],
      '[data-composer-footer-collapse] [data-tooltip-overflow-target="true"]':
        footers,
      'button, a': options.interactive ?? [mode, ...composerButtons],
      'button[aria-label="Switch mode, current mode: Codex"]': [mode],
    };
  return {
    document: {
      querySelectorAll(selector) {
        return selectorResults[selector] ?? [];
      },
    },
    location: { href: 'app://-/index.html' },
  };
}

function readyDOM(
  overrides: Partial<CodexElectronDOMObservation> = {}
): CodexElectronDOMObservation {
  return {
    route: 'app://-/index.html',
    modeCodexCount: 1,
    homeComposerRootCount: 1,
    composerCount: 1,
    composerText: '',
    composerPlainText: true,
    workspaceProjectTargetCount: 1,
    workspaceProjectTargetNames: [`Change project: ${workspaceBasename}`],
    workspaceProjectTargetTexts: [workspaceBasename],
    forbiddenWorktreeCount: 0,
    runLocationCount: 0,
    runLocationNames: [],
    runLocationTexts: [],
    footerCount: 1,
    footerText: workspaceBasename,
    footerTexts: [workspaceBasename],
    signInCount: 0,
    dialogCount: 0,
    turnCount: 0,
    generationCount: 0,
    queueCount: 0,
    attachmentCount: 0,
    sendButtonCount: 1,
    sendButtonEnabled: true,
    ...overrides,
  };
}

function fixture(
  options: {
    observations?: CodexElectronDOMObservation[];
    appAcknowledgement?: { handled: boolean; prevented: boolean };
    fillError?: Error;
    clickError?: Error;
    browser?: BrowserTestGlobal;
    readErrorAfter?: number;
  } = {}
) {
  let current = readyDOM();
  const queued = [...(options.observations ?? [])];
  const emitted: string[] = [];
  const fills: string[] = [];
  const events: string[] = [];
  let clicks = 0;
  let runOnceCalls = 0;
  let readDOMCalls = 0;
  const selectors: string[] = [];
  const roles: Array<{ role: string; name: string; exact: boolean }> = [];

  const composerLocator = {
    async fill(text: string) {
      fills.push(text);
      if (options.fillError) throw options.fillError;
      current = readyDOM({ composerText: text });
    },
  };
  const sendLocator = {
    async click() {
      clicks += 1;
      events.push('click');
      if (options.clickError) throw options.clickError;
    },
  };
  const rootLocator = {
    locator(selector: string) {
      selectors.push(selector);
      return composerLocator;
    },
    getByRole(role: string, query: { name: string; exact: boolean }) {
      roles.push({ role, ...query });
      return sendLocator;
    },
  };
  const page = {
    locator(selector: string) {
      selectors.push(selector);
      return rootLocator;
    },
  } as unknown as Page;
  const application = {
    async evaluate(
      _callback: unknown,
      href: string
    ): Promise<{ handled: boolean; prevented: boolean }> {
      emitted.push(href);
      return options.appAcknowledgement ?? { handled: true, prevented: true };
    },
  };
  const proof = Object.freeze({
    pid: 4242,
    browserWindowId: 17,
    webContentsId: 29,
    owned: true,
    destroyed: false,
    webContentsDestroyed: false,
    visible: true,
    focused: true,
    readyRoute: true,
    appContents: true,
  });
  const session = {
    application,
    window: page,
    windowProof: proof,
    workspacePath: workspace,
    workspaceOwnership: {
      kind: 'codex-electron-workspace',
      version: 1,
      id: '7ecf4887-1087-4686-96e6-82ebc11cc57f',
      path: workspace,
      markerPath: `${workspace}/.owner.json`,
      uid: process.getuid!(),
    },
    native: { pid: 4242, workspacePath: workspace },
    async readDOM<T>(reader: () => T | Promise<T>): Promise<T> {
      readDOMCalls += 1;
      if (
        options.readErrorAfter !== undefined &&
        readDOMCalls > options.readErrorAfter
      )
        throw new Error('test execution deadline expired');
      if (options.browser)
        return runInNewContext(
          `(${reader.toString()})()`,
          options.browser as object
        ) as T;
      current = queued.shift() ?? current;
      return current as T;
    },
    async runOnce<T>(
      action: (window: Page, remainingMs: number) => Promise<T>
    ): Promise<T> {
      runOnceCalls += 1;
      return action(page, 1_000);
    },
  } as unknown as CodexElectronSession;
  const beforeSubmit = vi.fn(async () => {
    events.push('receipt');
  });
  const control = createCodexElectronControl({
    session,
    attemptId: 'attempt_01JZQ3N5FRK8W2H6Y9M4',
    beforeSubmit,
  });
  return {
    control,
    beforeSubmit,
    emitted,
    fills,
    selectors,
    roles,
    events,
    get clicks() {
      return clicks;
    },
    get runOnceCalls() {
      return runOnceCalls;
    },
    get readDOMCalls() {
      return readDOMCalls;
    },
  };
}

async function openAndFill(f: ReturnType<typeof fixture>): Promise<void> {
  await f.control.openFreshWorkspace(workspace);
  await f.control.replacePrompt(prompt);
}

describe('Codex Electron control', () => {
  it('accepts the actual pinned local target list with no run-location or branch/worktree target', async () => {
    const f = fixture({
      browser: authenticatedBrowserDOM([browserElement('P')], {
        composerText: '\n',
      }),
    });

    await expect(f.control.observe()).resolves.toMatchObject({
      route: 'app://-/index.html',
      homeComposerRootCount: 1,
      composerCount: 1,
      composerText: '',
      composerPlainText: true,
      workspaceProjectTargetCount: 1,
      workspaceProjectTargetNames: [`Change project: ${workspaceBasename}`],
      workspaceProjectTargetTexts: [workspaceBasename],
      forbiddenWorktreeCount: 0,
      runLocationCount: 0,
      runLocationNames: [],
      runLocationTexts: [],
      footerTexts: [
        workspaceBasename,
        'Ask for approval',
        'Select effortGPT-5.6 LunaMedium',
      ],
      sendButtonCount: 1,
      sendButtonEnabled: true,
    });
    await expect(
      f.control.openFreshWorkspace(workspace)
    ).resolves.toBeUndefined();
  });

  it.each(['B', 'A', 'IMG'])(
    'rejects a rich %s node in the composer DOM',
    async (tagName) => {
      const richNode = browserElement(tagName, [browserText(prompt)]);
      const f = fixture({
        browser: authenticatedBrowserDOM([browserElement('P', [richNode])], {
          composerText: prompt,
        }),
        readErrorAfter: 2,
      });

      await expect(f.control.observe()).resolves.toMatchObject({
        composerText: prompt,
        composerPlainText: false,
      });
      await expect(f.control.openFreshWorkspace(workspace)).rejects.toThrow(
        'test execution deadline expired'
      );
    }
  );

  it('serializes the live Playwright fill DOM with one LF between direct paragraphs', async () => {
    const controlProbe = 'CONTROL_PROBE_NO_SUBMIT\nsecond line';
    const f = fixture({
      browser: authenticatedBrowserDOM(
        [
          browserElement('P', [browserText('CONTROL_PROBE_NO_SUBMIT')]),
          browserElement('P', [browserText('second line')]),
        ],
        { composerText: 'CONTROL_PROBE_NO_SUBMIT\n\nsecond line' }
      ),
    });

    await expect(f.control.observe()).resolves.toMatchObject({
      composerText: controlProbe,
      composerPlainText: true,
    });
  });

  it.each([
    {
      name: 'within-paragraph BR and exact surrounding spaces',
      children: [
        browserElement('P', [
          browserText('  First line  '),
          browserElement('BR'),
          browserText(' second line '),
        ]),
      ],
      expected: '  First line  \n second line ',
    },
    {
      name: 'multiline direct paragraphs',
      children: [
        browserElement('P', [
          browserText('first\nembedded'),
          browserElement('BR'),
          browserText('continued'),
        ]),
        browserElement('P', [
          browserText('second'),
          browserElement('BR'),
          browserText('last'),
        ]),
      ],
      expected: 'first\nembedded\ncontinued\nsecond\nlast',
    },
    {
      name: 'leading and trailing empty paragraphs',
      children: [
        browserElement('P'),
        browserElement('P', [browserText('middle')]),
        browserElement('P'),
      ],
      expected: '\nmiddle\n',
    },
    {
      name: 'exact direct text newlines',
      children: [browserText('  leading\n\ntrailing  ')],
      expected: '  leading\n\ntrailing  ',
    },
    {
      name: 'empty paragraph',
      children: [browserElement('P')],
      expected: '',
    },
    {
      name: 'empty paragraph BR sentinel',
      children: [browserElement('P', [browserElement('BR')])],
      expected: '',
    },
    {
      name: 'empty direct BR sentinel',
      children: [browserElement('BR')],
      expected: '',
    },
  ])(
    'serializes $name without innerText heuristics',
    async ({ children, expected }) => {
      const f = fixture({
        browser: authenticatedBrowserDOM(children, {
          composerText: 'deliberately incorrect innerText',
        }),
      });

      await expect(f.control.observe()).resolves.toMatchObject({
        composerText: expected,
        composerPlainText: true,
      });
    }
  );

  it('rejects non-element and non-text composer nodes', async () => {
    const commentNode: BrowserTestNode = {
      nodeType: 8,
      textContent: 'comment',
      childNodes: [],
    };
    const f = fixture({
      browser: authenticatedBrowserDOM([
        browserElement('P', [browserText('safe'), commentNode]),
      ]),
    });

    await expect(f.control.observe()).resolves.toMatchObject({
      composerPlainText: false,
    });
  });

  it('rejects composer DOM traversal beyond the node limit', async () => {
    const excessiveNodes = Array.from({ length: 16_385 }, () =>
      browserText('x')
    );
    const f = fixture({ browser: authenticatedBrowserDOM(excessiveNodes) });

    await expect(f.control.observe()).resolves.toMatchObject({
      composerPlainText: false,
    });
  });

  it('rejects a BR with hidden child content', async () => {
    const f = fixture({
      browser: authenticatedBrowserDOM([
        browserElement('P', [
          browserText('safe'),
          browserElement('BR', [browserText('hidden')]),
        ]),
      ]),
    });

    await expect(f.control.observe()).resolves.toMatchObject({
      composerPlainText: false,
    });
  });

  it('accepts one exact public Local run-location target', async () => {
    const f = fixture({
      browser: authenticatedBrowserDOM([browserElement('P')], {
        navigationTargets: [
          ...pinnedLocalTargets(),
          {
            kind: 'run-location',
            name: 'Select where to run the chat',
            text: 'Run in Local workspace',
          },
        ],
      }),
    });

    await expect(f.control.observe()).resolves.toMatchObject({
      forbiddenWorktreeCount: 0,
      runLocationCount: 1,
      runLocationNames: ['Select where to run the chat'],
      runLocationTexts: ['Run in Local workspace'],
    });
    await expect(
      f.control.openFreshWorkspace(workspace)
    ).resolves.toBeUndefined();
  });

  it.each([
    {
      name: 'remote run location',
      navigationTargets: [
        ...pinnedLocalTargets(),
        {
          kind: 'run-location',
          name: 'Select where to run the chat',
          text: 'Local or Remote cloud',
        },
      ],
      expected: { projects: 1, forbidden: 1, locations: 1 },
    },
    {
      name: 'active worktree target',
      navigationTargets: [
        ...pinnedLocalTargets(),
        {
          kind: 'workspace-branch',
          name: 'Change worktree',
          text: 'feature/live-location',
        },
      ],
      expected: { projects: 1, forbidden: 1, locations: 0 },
    },
    {
      name: 'ambiguous run locations',
      navigationTargets: [
        ...pinnedLocalTargets(),
        {
          kind: 'run-location',
          name: 'Select where to run the chat',
          text: 'Local',
        },
        {
          kind: 'run-location',
          name: 'Select where to run the chat',
          text: 'Local',
        },
      ],
      expected: { projects: 1, forbidden: 0, locations: 2 },
    },
    {
      name: 'ambiguous workspace projects',
      navigationTargets: [
        ...pinnedLocalTargets(),
        {
          kind: 'workspace-project',
          name: `Change project: ${workspaceBasename}`,
          text: workspaceBasename,
        },
      ],
      expected: { projects: 2, forbidden: 0, locations: 0 },
    },
    {
      name: 'missing workspace project',
      navigationTargets: pinnedLocalTargets().filter(
        (target) => target.kind !== 'workspace-project'
      ),
      expected: { projects: 0, forbidden: 0, locations: 0 },
    },
  ])('rejects $name evidence', async ({ navigationTargets, expected }) => {
    const f = fixture({
      browser: authenticatedBrowserDOM([browserElement('P')], {
        navigationTargets,
      }),
      readErrorAfter: 2,
    });

    await expect(f.control.observe()).resolves.toMatchObject({
      workspaceProjectTargetCount: expected.projects,
      forbiddenWorktreeCount: expected.forbidden,
      runLocationCount: expected.locations,
    });
    await expect(f.control.openFreshWorkspace(workspace)).rejects.toThrow(
      'test execution deadline expired'
    );
  });

  it.each([
    {
      name: 'aria',
      project: {
        kind: 'workspace-project',
        name: `Change project: ${workspaceBasename}-copy`,
        text: workspaceBasename,
      },
    },
    {
      name: 'text',
      project: {
        kind: 'workspace-project',
        name: `Change project: ${workspaceBasename}`,
        text: `${workspaceBasename}-copy`,
      },
    },
  ])('rejects near-match workspace $name evidence', async ({ project }) => {
    const f = fixture({
      browser: authenticatedBrowserDOM([browserElement('P')], {
        navigationTargets: [project, ...pinnedLocalTargets().slice(1)],
      }),
      readErrorAfter: 2,
    });

    await expect(f.control.openFreshWorkspace(workspace)).rejects.toThrow(
      'test execution deadline expired'
    );
  });

  it('bounds navigation target traversal and public name/text evidence', async () => {
    const navigationTargets = [
      {
        kind: 'workspace-project',
        name: `Change project: ${'n'.repeat(600)}`,
        text: 't'.repeat(300),
      },
      ...pinnedLocalTargets().slice(1),
      ...Array.from({ length: 29 }, (_, index) => ({
        kind: `other-${index}`,
        name: `Other ${index}`,
        text: '',
      })),
    ];
    const f = fixture({
      browser: authenticatedBrowserDOM([browserElement('P')], {
        navigationTargets,
      }),
      readErrorAfter: 2,
    });

    await expect(f.control.observe()).resolves.toMatchObject({
      workspaceProjectTargetCount: 2,
      forbiddenWorktreeCount: 2,
      runLocationCount: 2,
    });
    const observation = await fixture({
      browser: authenticatedBrowserDOM([browserElement('P')], {
        navigationTargets: navigationTargets.slice(0, 4),
      }),
    }).control.observe();
    expect(observation.workspaceProjectTargetNames[0]).toHaveLength(512);
    expect(observation.workspaceProjectTargetTexts[0]).toHaveLength(256);
    await expect(f.control.openFreshWorkspace(workspace)).rejects.toThrow(
      'test execution deadline expired'
    );
  });

  it('bounds footer text evidence without using unrelated footer controls as location identity', async () => {
    const footerTexts = [
      workspaceBasename,
      ...Array.from(
        { length: 39 },
        (_, index) => `${index}-${'x'.repeat(300)}`
      ),
    ];
    const f = fixture({
      browser: authenticatedBrowserDOM([browserElement('P')], {
        footerTexts,
      }),
    });

    const observation = await f.control.observe();
    expect(observation.footerCount).toBe(40);
    expect(observation.footerTexts).toHaveLength(32);
    expect(observation.footerTexts?.every((text) => text.length <= 256)).toBe(
      true
    );
    await expect(
      f.control.openFreshWorkspace(workspace)
    ).resolves.toBeUndefined();
  });

  it('counts only exact Sign in and Log in labels', async () => {
    const nearMatch = browserElement('BUTTON', [browserText('Sign in now')]);
    const exactMatch = browserElement('A', [browserText('ignored')], {
      attributes: { 'aria-label': 'Log in' },
    });
    const f = fixture({
      browser: authenticatedBrowserDOM([browserElement('P')], {
        interactive: [nearMatch, exactMatch],
      }),
      readErrorAfter: 2,
    });

    await expect(f.control.observe()).resolves.toMatchObject({
      signInCount: 1,
    });
    await expect(f.control.openFreshWorkspace(workspace)).rejects.toThrow(
      'test execution deadline expired'
    );
  });

  it('opens only the session workspace through one exact acknowledged deep link and requires two stable fresh observations', async () => {
    const f = fixture();

    await f.control.openFreshWorkspace(workspace);

    expect(f.emitted).toEqual([
      'codex://new?path=%2Ftmp%2Fcodex-electron-workspace-grlvvW',
    ]);
    expect(f.runOnceCalls).toBe(1);
    await expect(f.control.openFreshWorkspace(workspace)).rejects.toThrow(
      'Workspace is already open'
    );
    expect(f.emitted).toHaveLength(1);
  });

  it('waits through stale and loading workspace DOM after emitting the deep link once', async () => {
    const f = fixture({
      observations: [
        readyDOM({
          composerText: 'stale draft',
          workspaceProjectTargetNames: ['Change project: previous-z8N4mV'],
          workspaceProjectTargetTexts: ['previous-z8N4mV'],
          footerText: 'previous-z8N4mV',
          footerTexts: ['previous-z8N4mV'],
        }),
        readyDOM({
          workspaceProjectTargetCount: 0,
          workspaceProjectTargetNames: [],
          workspaceProjectTargetTexts: [],
          footerText: 'Loading branch…',
          footerTexts: ['Loading branch…'],
        }),
        readyDOM(),
        readyDOM(),
      ],
    });

    await expect(
      f.control.openFreshWorkspace(workspace)
    ).resolves.toBeUndefined();
    expect(f.emitted).toEqual([
      'codex://new?path=%2Ftmp%2Fcodex-electron-workspace-grlvvW',
    ]);
    expect(f.runOnceCalls).toBe(1);
    expect(f.readDOMCalls).toBe(4);
  });

  it('does not accept a matching basename without handled and prevented exact-path attribution', async () => {
    const f = fixture({
      appAcknowledgement: { handled: true, prevented: false },
    });

    await expect(f.control.openFreshWorkspace(workspace)).rejects.toThrow(
      'Codex workspace deep link was not acknowledged'
    );
    expect(f.emitted).toHaveLength(1);
  });

  it('rejects a different path before emitting a deep link', async () => {
    const f = fixture();

    await expect(
      f.control.openFreshWorkspace('/tmp/other-a7K9pQ')
    ).rejects.toThrow('Workspace must exactly match the owned session');
    expect(f.emitted).toHaveLength(0);
    expect(f.runOnceCalls).toBe(0);
  });

  it.each([
    {
      name: 'dialog state',
      second: readyDOM({ dialogCount: 1 }),
    },
    {
      name: 'run-location evidence',
      second: readyDOM({
        runLocationCount: 1,
        runLocationNames: ['Select where to run the chat'],
        runLocationTexts: ['Local'],
      }),
    },
    {
      name: 'workspace-project public name',
      second: readyDOM({
        workspaceProjectTargetNames: [
          `Change project: ${workspaceBasename}-renamed`,
        ],
      }),
    },
  ])('rejects unstable $name after the one deep link', async ({ second }) => {
    const f = fixture({ observations: [readyDOM(), second] });

    await expect(f.control.openFreshWorkspace(workspace)).rejects.toThrow(
      'Codex home composer is not fresh and stable'
    );
    expect(f.emitted).toHaveLength(1);
  });

  it('uses Playwright fill exactly once and requires exact multiline plain-text readback', async () => {
    const f = fixture();
    await f.control.openFreshWorkspace(workspace);

    await f.control.replacePrompt(prompt);

    expect(f.fills).toEqual([prompt]);
    expect(f.selectors).toEqual([
      '[data-codex-composer-root][data-composer-placement="home"]',
      '[data-codex-composer="true"][role="textbox"][contenteditable="true"]',
    ]);
    expect(f.runOnceCalls).toBe(2);
  });

  it('rejects CR line endings before fill instead of normalizing exact prompt input', async () => {
    const f = fixture();
    await f.control.openFreshWorkspace(workspace);

    await expect(
      f.control.replacePrompt('First line\r\nSecond line')
    ).rejects.toThrow('Prompt must use LF line endings');
    expect(f.fills).toHaveLength(0);
  });

  it('permits only one fill attempt when replacePrompt calls overlap', async () => {
    const f = fixture();
    await f.control.openFreshWorkspace(workspace);

    const results = await Promise.allSettled([
      f.control.replacePrompt(prompt),
      f.control.replacePrompt('competing prompt'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(f.fills).toEqual([prompt]);
  });

  it('replaces a stable retained plain-text draft exactly once', async () => {
    const f = fixture({
      observations: [
        readyDOM(),
        readyDOM(),
        readyDOM({ composerText: 'stale draft' }),
      ],
    });
    await f.control.openFreshWorkspace(workspace);

    await expect(f.control.replacePrompt(prompt)).resolves.toBeUndefined();
    expect(f.fills).toEqual([prompt]);
  });

  it('rejects rich DOM readback after the single fill and never permits another fill', async () => {
    const f = fixture({
      observations: [
        readyDOM(),
        readyDOM(),
        readyDOM(),
        readyDOM({ composerText: prompt, composerPlainText: false }),
      ],
    });
    await f.control.openFreshWorkspace(workspace);

    await expect(f.control.replacePrompt(prompt)).rejects.toThrow(
      'Full prompt DOM readback did not match'
    );
    await expect(f.control.replacePrompt(prompt)).rejects.toThrow(
      'Prompt fill was already attempted'
    );
    expect(f.fills).toEqual([prompt]);
  });

  it('persists the full receipt before one root-scoped enabled Send click', async () => {
    const f = fixture();
    await openAndFill(f);

    await expect(f.control.submitOnce()).resolves.toEqual({
      status: 'acknowledged',
    });

    expect(f.beforeSubmit).toHaveBeenCalledExactlyOnceWith({
      attemptId: 'attempt_01JZQ3N5FRK8W2H6Y9M4',
      pid: 4242,
      browserWindowId: 17,
      webContentsId: 29,
      workspace,
      fullPromptSha256: createHash('sha256').update(prompt).digest('hex'),
      inputMode: 'playwright-fill',
      readback: 'exact',
    });
    expect(f.roles).toEqual([{ role: 'button', name: 'Send', exact: true }]);
    expect(f.events).toEqual(['receipt', 'click']);
    expect(f.clicks).toBe(1);
    await expect(f.control.submitOnce()).rejects.toThrow(
      'Submit was already attempted'
    );
    expect(f.clicks).toBe(1);
  });

  it('rechecks fresh identity before the durable receipt', async () => {
    const f = fixture({
      observations: [
        readyDOM(),
        readyDOM(),
        readyDOM(),
        readyDOM({ composerText: prompt }),
        readyDOM({ composerText: prompt, queueCount: 1 }),
      ],
    });
    await openAndFill(f);

    await expect(f.control.submitOnce()).rejects.toThrow(
      'Codex home composer freshness guard failed'
    );
    expect(f.beforeSubmit).not.toHaveBeenCalled();
    expect(f.clicks).toBe(0);
  });

  it('returns uncertain after a Send click acknowledgement failure and never clicks again', async () => {
    const f = fixture({ clickError: new Error('detached after dispatch') });
    await openAndFill(f);

    const result = await f.control.submitOnce();

    expect(result.status).toBe('uncertain');
    if (result.status === 'uncertain')
      expect(result.error).toBeInstanceOf(CodexElectronControlError);
    expect(f.clicks).toBe(1);
    await expect(f.control.submitOnce()).rejects.toThrow(
      'Submit was already attempted'
    );
    expect(f.clicks).toBe(1);
  });

  it('does not click when the durable receipt fails', async () => {
    const f = fixture();
    await openAndFill(f);
    f.beforeSubmit.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(f.control.submitOnce()).rejects.toThrow(
      'Durable beforeSubmit receipt failed'
    );
    expect(f.clicks).toBe(0);
    await expect(f.control.submitOnce()).rejects.toThrow(
      'Submit was already attempted'
    );
  });
});
