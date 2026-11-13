import { describe, expect, it } from 'vitest';
import {
  lastAddedBy,
  mayChangeLabelsOn,
  planLabels,
  readTitle,
  WORKFLOW_ACTOR,
  type LabelState,
} from '../scripts/changelog-label.js';

function plan(state: Partial<LabelState> & { title: string }) {
  return planLabels({
    labels: [],
    mayAdd: true,
    setByWorkflow: false,
    ...state,
  });
}

describe('readTitle', () => {
  it.each([
    ['feat(models): set default models', 'enhancement'],
    ['perf: cache the tool list', 'enhancement'],
    ['fix(cowork): run on the current UI', 'bug'],
    ['docs(release): describe the inputs', 'documentation'],
    ['ci(website): deploy on release tags', 'internal'],
    ['chore: bump tooling', 'internal'],
    ['refactor(evals): split the runner', 'internal'],
    ['test: cover the reporter', 'internal'],
    ['build: bundle the UI', 'internal'],
    ['refactor!: traces are transcripts', 'breaking'],
    ['fix(evals)!: score keys are assertion keys', 'breaking'],
    ['feat!: every write is accounted for', 'breaking'],
    ['fix(deps): bump fast-xml-parser from 5.8.0 to 5.12.0', 'internal'],
    ['chore(deps-dev): bump vitest', 'internal'],
    ['Feat: capitalized type', 'enhancement'],
  ])('%s -> %s', (title, label) => {
    expect(readTitle(title).label).toBe(label);
  });

  it.each([
    'Default Claude Code gateway context to 1M',
    'Revert "feat: add the history page"',
    'wip: not a known type',
    'feat:no space after the colon',
    'feat(deps : unclosed scope',
  ])('has no label for %s', (title) => {
    expect(readTitle(title).label).toBeNull();
  });
});

describe('planLabels', () => {
  it('adds the label the title implies when there is none', () => {
    expect(plan({ title: 'feat: add a judge' })).toEqual({
      kind: 'change',
      add: 'enhancement',
      remove: null,
    });
  });

  it('ignores labels that are not changelog labels', () => {
    expect(
      plan({
        title: 'fix(deps): bump a package',
        labels: ['dependencies', 'javascript'],
      })
    ).toEqual({ kind: 'change', add: 'internal', remove: null });
  });

  it('fails when the title implies no label and there is none', () => {
    const result = plan({ title: 'Default gateway context to 1M' });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain(
      "isn't a conventional commit"
    );
  });

  it('keeps a label a person chose over the one the title implies', () => {
    expect(plan({ title: 'fix(site): deploy', labels: ['internal'] })).toEqual({
      kind: 'ok',
      label: 'internal',
    });
  });

  it('matches labels case-insensitively, as lerna-changelog does', () => {
    expect(plan({ title: 'fix: x', labels: ['Bug'] })).toEqual({
      kind: 'ok',
      label: 'bug',
    });
  });

  it('fails with more than one changelog label', () => {
    const result = plan({ title: 'feat: x', labels: ['enhancement', 'bug'] });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain(
      'enhancement, bug'
    );
  });

  it('labels a breaking title breaking, whatever label it had', () => {
    expect(
      plan({ title: 'fix(store)!: check results', labels: ['bug'] })
    ).toEqual({ kind: 'change', add: 'breaking', remove: 'bug' });
  });

  it('moves a label the workflow added to follow the title', () => {
    expect(
      plan({
        title: 'feat(runner): add a runner',
        labels: ['bug'],
        setByWorkflow: true,
      })
    ).toEqual({ kind: 'change', add: 'enhancement', remove: 'bug' });
    expect(
      plan({
        title: 'feat: drop the flag',
        labels: ['breaking'],
        setByWorkflow: true,
      })
    ).toEqual({ kind: 'change', add: 'enhancement', remove: 'breaking' });
  });

  it('keeps a label a person added when the title changes', () => {
    expect(
      plan({ title: 'feat(runner): add a runner', labels: ['internal'] })
    ).toEqual({ kind: 'ok', label: 'internal' });
  });

  it('keeps the label when the title implies none', () => {
    expect(
      plan({
        title: 'Add a runner',
        labels: ['enhancement'],
        setByWorkflow: true,
      })
    ).toEqual({ kind: 'ok', label: 'enhancement' });
  });

  describe('mayChangeLabelsOn', () => {
    it.each([
      ['opened', true],
      ['reopened', true],
      ['edited', true],
      ['synchronize', true],
      // Dependabot adds `dependencies` right after opening.
      ['labeled', true],
      ['unlabeled', false],
    ])('%s -> %s', (action, expected) => {
      expect(mayChangeLabelsOn(action)).toBe(expected);
    });
  });

  describe('lastAddedBy', () => {
    const added = (label: string, login: string) => ({
      event: 'labeled',
      actor: { login },
      label: { name: label },
    });

    it('names who added the label last', () => {
      expect(
        lastAddedBy(
          [
            added('bug', WORKFLOW_ACTOR),
            {
              event: 'unlabeled',
              actor: { login: 'a' },
              label: { name: 'bug' },
            },
            added('Bug', 'a-person'),
            added('internal', WORKFLOW_ACTOR),
          ],
          'bug'
        )
      ).toBe('a-person');
      expect(
        lastAddedBy(
          [added('bug', 'a-person'), added('bug', WORKFLOW_ACTOR)],
          'bug'
        )
      ).toBe(WORKFLOW_ACTOR);
    });

    it('is null when nobody added it, or the actor is gone', () => {
      expect(lastAddedBy([{ event: 'renamed' }], 'bug')).toBeNull();
      expect(
        lastAddedBy(
          [{ event: 'labeled', actor: null, label: { name: 'bug' } }],
          'bug'
        )
      ).toBeNull();
    });
  });

  describe('when a label was removed', () => {
    it('only checks, so replacing a label never leaves two', () => {
      const result = plan({ title: 'feat: x', mayAdd: false });
      expect(result.kind).toBe('error');
      expect(result.kind === 'error' && result.message).toContain(
        'no changelog label'
      );
    });

    it('fails a breaking title with another label', () => {
      const result = plan({
        title: 'feat!: x',
        labels: ['enhancement'],
        mayAdd: false,
      });
      expect(result.kind).toBe('error');
      expect(result.kind === 'error' && result.message).toContain(
        'breaking change'
      );
    });

    it('passes a single changelog label', () => {
      expect(
        plan({ title: 'feat: x', labels: ['documentation'], mayAdd: false })
      ).toEqual({ kind: 'ok', label: 'documentation' });
    });

    it('leaves a workflow label for the next run to move', () => {
      expect(
        plan({
          title: 'feat: x',
          labels: ['bug'],
          setByWorkflow: true,
          mayAdd: false,
        })
      ).toEqual({ kind: 'ok', label: 'bug' });
    });
  });
});
