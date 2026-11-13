/**
 * Gives a pull request the one changelog label that lerna-changelog needs at
 * release, and fails when it can't. Run by
 * `.github/workflows/changelog-label.yml`, with Node's type stripping and no
 * dependencies, so the workflow never installs packages while it holds a
 * write token.
 *
 * lerna-changelog leaves out a pull request with none of these labels, and
 * lists one with two under both headings. The label comes from the
 * conventional commit title (`feat:` is `enhancement`, `!` is `breaking`).
 * A label this workflow added follows the title when it changes. A label a
 * person added stays, unless the title marks a breaking change.
 *
 * Every run reads the pull request's title, labels and label history as they
 * are when it runs, never from its event. GitHub drops a queued run when a
 * newer one queues, so the run that survives must reach the same answer.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const CHANGELOG_LABELS = [
  'breaking',
  'enhancement',
  'bug',
  'documentation',
  'internal',
] as const;

export type ChangelogLabel = (typeof CHANGELOG_LABELS)[number];

const TYPE_LABELS: Record<string, ChangelogLabel> = {
  feat: 'enhancement',
  perf: 'enhancement',
  fix: 'bug',
  docs: 'documentation',
  build: 'internal',
  chore: 'internal',
  ci: 'internal',
  refactor: 'internal',
  style: 'internal',
  test: 'internal',
};

const CONVENTIONAL_TITLE = /^([a-z]+)(?:\(([^)]*)\))?(!)?: \S/i;

export interface TitleInfo {
  /** The label the title implies, or null when it has none. */
  label: ChangelogLabel | null;
  /** The title marks a breaking change with `!`. */
  breaking: boolean;
}

export function readTitle(title: string): TitleInfo {
  const match = CONVENTIONAL_TITLE.exec(title.trim());
  if (!match) return { label: null, breaking: false };
  const type = (match[1] ?? '').toLowerCase();
  const scope = (match[2] ?? '').toLowerCase();
  if (match[3]) return { label: 'breaking', breaking: true };
  // Dependency bumps (Dependabot's `fix(deps):`, `chore(deps):`).
  if (scope === 'deps' || scope === 'deps-dev')
    return { label: TYPE_LABELS[type] ? 'internal' : null, breaking: false };
  return { label: TYPE_LABELS[type] ?? null, breaking: false };
}

export function changelogLabelsIn(labels: string[]): ChangelogLabel[] {
  return CHANGELOG_LABELS.filter((label) =>
    labels.some((name) => name.toLowerCase() === label)
  );
}

/** The login GitHub gives a workflow's `GITHUB_TOKEN`. */
export const WORKFLOW_ACTOR = 'github-actions[bot]';

interface IssueEvent {
  event: string;
  actor?: { login: string } | null;
  label?: { name: string };
}

/** Who added `label` last, from the issue events (oldest first). */
export function lastAddedBy(
  events: IssueEvent[],
  label: string
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.event === 'labeled' && event.label?.name.toLowerCase() === label)
      return event.actor?.login ?? null;
  }
  return null;
}

/**
 * A person removed the last changelog label, and may be about to add
 * another: adding one back now would leave two. From the issue events, not
 * the event that started the run.
 */
export function personRemovedLast(events: IssueEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (
      (event?.event === 'labeled' || event?.event === 'unlabeled') &&
      changelogLabelsIn([event.label?.name ?? '']).length > 0
    )
      return (
        event.event === 'unlabeled' && event.actor?.login !== WORKFLOW_ACTOR
      );
  }
  return false;
}

export interface LabelState {
  title: string;
  /** Every label on the pull request now. */
  labels: string[];
  /**
   * This workflow added the pull request's changelog label, and no person
   * has added it since.
   */
  setByWorkflow: boolean;
  /** Add or change a label: false when `personRemovedLast`. */
  mayAdd: boolean;
}

export type LabelPlan =
  | { kind: 'ok'; label: ChangelogLabel }
  | { kind: 'change'; add: ChangelogLabel; remove: ChangelogLabel | null }
  | { kind: 'error'; message: string };

const LABEL_LIST = CHANGELOG_LABELS.map((label) => `\`${label}\``).join(', ');

export function planLabels(state: LabelState): LabelPlan {
  const present = changelogLabelsIn(state.labels);
  const title = readTitle(state.title);

  if (present.length > 1)
    return {
      kind: 'error',
      message: `This pull request has ${present.length} changelog labels (${present.join(', ')}). lerna-changelog lists it under each one. Keep one.`,
    };

  const [current] = present;
  if (!current) {
    if (state.mayAdd && title.label)
      return { kind: 'change', add: title.label, remove: null };
    return {
      kind: 'error',
      message: title.label
        ? `This pull request has no changelog label. Add one of ${LABEL_LIST}.`
        : `This pull request has no changelog label, and its title isn't a conventional commit (\`feat:\`, \`fix:\`, \`docs:\`, \`chore:\` ...) to take one from. Add one of ${LABEL_LIST}, or retitle it.`,
    };
  }

  if (title.breaking && current !== 'breaking') {
    if (state.mayAdd)
      return { kind: 'change', add: 'breaking', remove: current };
    return {
      kind: 'error',
      message: `The title marks a breaking change (\`!\`), but the changelog label is \`${current}\`. Label it \`breaking\`, or remove the \`!\`.`,
    };
  }

  // A label this workflow added follows the title.
  if (
    state.setByWorkflow &&
    state.mayAdd &&
    title.label &&
    title.label !== current
  )
    return { kind: 'change', add: title.label, remove: current };

  return { kind: 'ok', label: current };
}

interface PullRequestEvent {
  number: number;
}

async function github(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${requireEnv('GITHUB_TOKEN')}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${await response.text()}`
    );
  return response.status === 204 ? null : response.json();
}

async function issueEvents(issue: string): Promise<IssueEvent[]> {
  const events: IssueEvent[] = [];
  for (let page = 1; ; page++) {
    const batch = (await github(
      'GET',
      `${issue}/events?per_page=100&page=${page}`
    )) as IssueEvent[];
    events.push(...batch);
    if (batch.length < 100) return events;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function summarize(line: string): void {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${line}\n`);
}

async function main(): Promise<void> {
  const event = JSON.parse(
    fs.readFileSync(requireEnv('GITHUB_EVENT_PATH'), 'utf8')
  ) as PullRequestEvent;
  const repo = `/repos/${requireEnv('GITHUB_REPOSITORY')}`;
  const issue = `${repo}/issues/${event.number}`;
  const pull = (await github('GET', `${repo}/pulls/${event.number}`)) as {
    title: string;
    labels: Array<{ name: string }>;
  };
  const labels = pull.labels.map((label) => label.name);
  const [only, ...others] = changelogLabelsIn(labels);
  const events = await issueEvents(issue);
  const plan = planLabels({
    title: pull.title,
    labels,
    setByWorkflow:
      only !== undefined &&
      others.length === 0 &&
      lastAddedBy(events, only) === WORKFLOW_ACTOR,
    mayAdd: !personRemovedLast(events),
  });

  if (plan.kind === 'error') {
    console.log(`::error title=Changelog label::${plan.message}`);
    summarize(plan.message);
    process.exitCode = 1;
    return;
  }
  if (plan.kind === 'change') {
    if (plan.remove) await github('DELETE', `${issue}/labels/${plan.remove}`);
    await github('POST', `${issue}/labels`, { labels: [plan.add] });
    summarize(
      plan.remove
        ? `Changed the changelog label from \`${plan.remove}\` to \`${plan.add}\`, from the title.`
        : `Added the changelog label \`${plan.add}\`, from the title.`
    );
    return;
  }
  summarize(`Changelog label: \`${plan.label}\`.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
