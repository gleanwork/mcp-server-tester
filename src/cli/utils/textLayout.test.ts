import { describe, expect, it } from 'vitest';
import { indented, listSection, outputWidth, wrap } from './textLayout.js';
import { formatTable } from '../commands/discoveryPlugins.js';

describe('outputWidth', () => {
  it("takes a terminal's columns, kept between 60 and 120", () => {
    expect(outputWidth({ isTTY: true, columns: 90 })).toBe(90);
    expect(outputWidth({ isTTY: true, columns: 40 })).toBe(60);
    expect(outputWidth({ isTTY: true, columns: 300 })).toBe(120);
  });

  it('is 100 when output is a pipe or a file', () => {
    expect(outputWidth({})).toBe(100);
    expect(outputWidth({ isTTY: false, columns: 200 })).toBe(100);
    // A terminal that reports no columns.
    expect(outputWidth({ isTTY: true })).toBe(100);
  });
});

describe('wrap', () => {
  it('breaks at spaces within the width', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('keeps a word longer than the width whole, on its own line', () => {
    expect(wrap('see /a/very/long/path/to/a/file now', 10)).toEqual([
      'see',
      '/a/very/long/path/to/a/file',
      'now',
    ]);
  });

  it('gives one empty line for empty text', () => {
    expect(wrap('', 10)).toEqual(['']);
  });
});

describe('indented and listSection', () => {
  it('hangs wrapped lines under the text after a bullet', () => {
    expect(indented('alpha beta gamma delta', 20, '    ', '  - ')).toEqual([
      '  - alpha beta gamma',
      '    delta',
    ]);
  });

  it('puts one item under its heading, several as bullets, none as nothing', () => {
    expect(listSection('Install', ['the app'], 80)).toEqual([
      '',
      'Install',
      '  the app',
    ]);
    expect(listSection('Setup', ['one', 'two'], 80)).toEqual([
      '',
      'Setup',
      '  - one',
      '  - two',
    ]);
    expect(listSection('Setup', [], 80)).toEqual([]);
    expect(listSection('Setup', undefined, 80)).toEqual([]);
  });
});

describe('formatTable', () => {
  const rows = [
    ['Name', 'Kind', 'Description'],
    ['a', 'judge', 'one two three four five six'],
    ['bb', 'pairwise', ''],
  ];

  it('pads every column but the last, and drops a column no row fills', () => {
    expect(
      formatTable([
        ['a', '', 'x'],
        ['bb', '', 'y'],
      ])
    ).toBe('a   x\nbb  y');
  });

  it("without a width, leaves the last column's lines as they are", () => {
    expect(formatTable(rows)).toBe(
      [
        'Name  Kind      Description',
        'a     judge     one two three four five six',
        'bb    pairwise',
      ].join('\n')
    );
  });

  it('with a width, wraps the last column under itself', () => {
    // The last column starts at 16, so 46 columns leave it 30.
    expect(formatTable(rows, 46)).toBe(
      [
        'Name  Kind      Description',
        'a     judge     one two three four five six',
        'bb    pairwise',
      ].join('\n')
    );
    expect(formatTable(rows, 46).split('\n')[1]!.length).toBeLessThanOrEqual(
      46
    );
    expect(
      formatTable(
        [
          ['a', 'alpha beta gamma delta epsilon zeta eta theta iota kappa'],
          ['b', 'first\nsecond'],
        ],
        40
      )
    ).toBe(
      [
        'a  alpha beta gamma delta epsilon zeta',
        '   eta theta iota kappa',
        'b  first',
        '   second',
      ].join('\n')
    );
  });

  it('puts the last column below its row when the others leave it under 30 characters', () => {
    expect(
      formatTable(
        [
          ['a-rather-long-reference', 'version-1', 'first words here'],
          ['b', 'v2', ''],
        ],
        50
      )
    ).toBe(
      [
        'a-rather-long-reference  version-1',
        '    first words here',
        'b                        v2',
      ].join('\n')
    );
  });
});
