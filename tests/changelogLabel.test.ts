import { describe, expect, it } from 'vitest';
import {
  mayChangeLabelsOn,
  planLabels,
  readTitle,
  type LabelState,
} from '../scripts/changelog-label.js';

function plan(state: Partial<LabelState> & { title: string }) {
  return planLabels({ labels: [], mayAdd: true, ...state });
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

  it('moves a label that came from the old title to the new one', () => {
    expect(
      plan({
        title: 'feat(runner): add a runner',
        previousTitle: 'fix(runner): add a runner',
        labels: ['bug'],
      })
    ).toEqual({ kind: 'change', add: 'enhancement', remove: 'bug' });
    expect(
      plan({
        title: 'feat: drop the flag',
        previousTitle: 'feat!: drop the flag',
        labels: ['breaking'],
      })
    ).toEqual({ kind: 'change', add: 'enhancement', remove: 'breaking' });
  });

  it('keeps a chosen label when the title changes', () => {
    expect(
      plan({
        title: 'feat(runner): add a runner',
        previousTitle: 'fix(runner): add a runner',
        labels: ['internal'],
      })
    ).toEqual({ kind: 'ok', label: 'internal' });
  });

  it('keeps the label when the new title implies none', () => {
    expect(
      plan({
        title: 'Add a runner',
        previousTitle: 'feat: add a runner',
        labels: ['enhancement'],
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
  });
});
