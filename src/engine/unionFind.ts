/**
 * Minimal disjoint-set (union-find) over string keys.
 *
 * Pure, zero-import module shared by the schema-level and rendered-graph
 * connectivity summarizers for weakly-connected grouping. Safe to bundle in both
 * the extension host and the webview.
 */

/** Minimal disjoint-set (union-find) over string keys for weakly-connected grouping. */
export class UnionFind {
  private parent = new Map<string, string>();

  /** Registers a key as its own singleton set if not already present. */
  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  /** Returns the set representative for `key`, compressing the path en route. */
  find(key: string): string {
    let root = key;
    while ((this.parent.get(root) ?? root) !== root) root = this.parent.get(root)!;
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
