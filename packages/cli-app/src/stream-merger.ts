/**
 * Generic N→1 async iterable merger.
 *
 * Architect P0-1 spike (Day 5.0) — interleave policy:
 *   (A) Within a single source iterator: strict order preserved (sequential
 *       await).
 *   (B) Across N source iterators: round-robin Promise.race — whichever
 *       source produces first wins. No timestamp re-sort (preserves causal
 *       order within source).
 *
 * Trade-off vs timestamp re-sort: simpler, no buffering latency, no
 * out-of-order risk for fast bursts. Cross-session ordering may not be
 * timestamp-monotonic but causal order within each session is preserved.
 *
 * Used by Phase1Supervisor to merge sub-agent + workspace + verification
 * streams into a single NaiaStreamChunk feed.
 */
export async function* mergeStreams<T>(
  ...sources: Array<AsyncIterable<T>>
): AsyncIterable<T> {
  if (sources.length === 0) return;
  const iters = sources.map((s) => s[Symbol.asyncIterator]());
  type Pending = { iter: AsyncIterator<T>; index: number; promise: Promise<{ index: number; result: IteratorResult<T> }> };
  const pending: (Pending | null)[] = iters.map((iter, index) => ({
    iter,
    index,
    promise: iter.next().then((result) => ({ index, result })),
  }));

  while (pending.some((p) => p !== null)) {
    const live = pending.filter((p): p is Pending => p !== null);
    if (live.length === 0) break;
    const winner = await Promise.race(live.map((p) => p.promise));
    const { index, result } = winner;
    // Paranoid P0-1 fix — pending[index] may have been settled by another
    // race winner during the await. Re-check before reassigning.
    const currentSlot = pending[index];
    if (!currentSlot) continue;
    if (result.done) {
      pending[index] = null;
      continue;
    }
    yield result.value;
    const slot = pending[index];
    if (slot) {
      slot.promise = slot.iter.next().then((r) => ({ index, result: r }));
    }
  }
}
