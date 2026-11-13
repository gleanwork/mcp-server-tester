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
 * When the title changes, a label that came from the old title follows it. A
 * label a person chose stays, unless the title marks a breaking change.
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

export interface LabelState {
  title: string;
  /** The title before this edit, when the event changed it. */
  previousTitle?: string;
  /** Every label on the pull request now. */
  labels: string[];
  /** Add a label when there is none. Label events only check. */
  mayAdd: boolean;
}

export type LabelPlan =
  | { kind: 'ok'; label: ChangelogLabel }
  | { kind: 'change'; add: ChangelogLabel; remove: ChangelogLabel | null }
  | { kind: 'error'; message: string };

const LABEL_LIST = CHANGELOG_LABELS.map((label) => `\`${label}\``).join(', ');

export function planLabels(state: LabelState): LabelPlan {
  const present = CHANGELOG_LABELS.filter((label) =>
    state.labels.some((name) => name.toLowerCase() === label)
  );
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

  // A label that came from the old title follows the new one.
  if (state.previousTitle !== undefined && title.label && state.mayAdd) {
    const previous = readTitle(state.previousTitle).label;
    if (previous === current && title.label !== current)
      return { kind: 'change', add: title.label, remove: current };
  }

  return { kind: 'ok', label: current };
}

interface PullRequestEvent {
  action: string;
  number: number;
  pull_request: { title: string };
  changes?: { title?: { from: string } };
}

async function github(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
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
  const issue = `/repos/${requireEnv('GITHUB_REPOSITORY')}/issues/${event.number}`;
  // The labels now, not when the event fired: a person may have changed them.
  const labels = (await github('GET', `${issue}/labels`)) as Array<{
    name: string;
  }>;
  const plan = planLabels({
    title: event.pull_request.title,
    previousTitle: event.changes?.title?.from,
    labels: labels.map((label) => label.name),
    // Replacing a label in GitHub's picker removes one and adds the other in
    // separate events. Adding on the removal would leave two.
    mayAdd: event.action !== 'labeled' && event.action !== 'unlabeled',
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
