/**
 * A small binary heap keyed by an arbitrary comparable identifier (a string
 * key in practice), supporting an O(log n) "priority improved" fix-up.
 *
 * Upstream's `astarsearch.cpp`/`pathfind.cpp` build their priority queues by
 * hand on top of `std::push_heap`/`std::pop_heap`/`std::find` (an O(n) scan
 * to locate a node before re-heapifying on "decrease key"). This is the same
 * binary-heap algorithm, just written once and reused by both `astar.ts` and
 * `pathfind.ts`, with an O(1) position lookup (a `Map`) replacing the O(n)
 * `std::find` -- a straightforward implementation improvement, not a
 * behavioral difference: both approaches produce a valid heap satisfying the
 * same ordering after a "key improved" fix-up.
 */
export class IndexedHeap<K> {
  private readonly heap: K[] = [];
  private readonly pos = new Map<K, number>();

  /** `higherPriority(a, b)` returns true if `a` must be popped before `b`. */
  constructor(private readonly higherPriority: (a: K, b: K) => boolean) {}

  get size(): number {
    return this.heap.length;
  }

  has(key: K): boolean {
    return this.pos.has(key);
  }

  push(key: K): void {
    this.heap.push(key);
    this.pos.set(key, this.heap.length - 1);
    this.siftUp(this.heap.length - 1);
  }

  pop(): K | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    this.pos.delete(top);
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.pos.set(last, 0);
      this.siftDown(0);
    }
    return top;
  }

  /** Call after `key`'s priority has improved (become higher-priority than before). */
  fix(key: K): void {
    const i = this.pos.get(key);
    if (i !== undefined) this.siftUp(i);
  }

  private siftUp(i: number): void {
    let idx = i;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!this.higherPriority(this.heap[idx]!, this.heap[parent]!)) break;
      this.swap(idx, parent);
      idx = parent;
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    let idx = i;
    for (;;) {
      let best = idx;
      const l = 2 * idx + 1;
      const r = 2 * idx + 2;
      if (l < n && this.higherPriority(this.heap[l]!, this.heap[best]!)) best = l;
      if (r < n && this.higherPriority(this.heap[r]!, this.heap[best]!)) best = r;
      if (best === idx) break;
      this.swap(idx, best);
      idx = best;
    }
  }

  private swap(i: number, j: number): void {
    const a = this.heap[i]!;
    const b = this.heap[j]!;
    this.heap[i] = b;
    this.heap[j] = a;
    this.pos.set(b, i);
    this.pos.set(a, j);
  }
}
