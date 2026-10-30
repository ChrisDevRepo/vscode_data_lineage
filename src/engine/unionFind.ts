/** Minimal disjoint-set (union-find) over string keys. */

/** Minimal disjoint-set (union-find) over string keys for weakly-connected grouping. */
class UnionFind {
  private parent = new Map<string, string>();

  /** Registers a key as its own singleton set if not already present. */
  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  /** Returns the set representative for `key`, compressing the path en route. */
  find(key: string): string {
    let root = key;
    while ((this.parent.get(root) ?? root) !== root)
      root = this.parent.get(root)!;
    let cur = key;
    while ((this.parent.get(cur) ?? cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  /** Merges the sets containing `a` and `b`, adding either if unseen. */
  union(a: string, b: string): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Groups items into weakly-connected components. */
export function groupByWeaklyConnected<T>(
  items: readonly T[],
  edges: Iterable<readonly [string, string]>,
  keyOf: (item: T) => string,
  labelOf: (item: T) => string = keyOf,
): string[][] {
  const uf = new UnionFind();
  for (const item of items) uf.add(keyOf(item));
  for (const [a, b] of edges) uf.union(a, b);

  const groups = new Map<string, string[]>();
  for (const item of items) {
    const root = uf.find(keyOf(item));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(labelOf(item));
  }

  return [...groups.values()]
    .map((g) => g.sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}
