import { describe, expect, it } from 'vitest';
import { walkAtspi, type AtspiRef } from './linuxAtspiBus.js';

const ref = (path: string): AtspiRef => ({ destination: ':1.20', path });
const tree: Record<string, string[]> = {
  '/app': ['/a', '/b'],
  '/a': ['/a1'],
  '/a1': [],
  '/b': [],
};

describe('walkAtspi', () => {
  it('omits a node whose visit returns null, with its subtree', async () => {
    const visited: string[] = [];
    const paths = await walkAtspi(ref('/app'), async ({ ref: node }) => {
      visited.push(node.path);
      if (node.path === '/a') return null;
      return { value: node.path, children: tree[node.path]!.map(ref) };
    });
    expect(paths).toEqual(['/app', '/b']);
    expect(visited).not.toContain('/a1');
  });

  it('refuses to omit the root', async () => {
    await expect(walkAtspi(ref('/app'), async () => null)).rejects.toThrow(
      'accessibility_tree_invalid'
    );
  });
});
