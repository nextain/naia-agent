/**
 * Paranoid P0-1 regression — mergeStreams must survive a settled-during-race
 * scenario without crashing. Verifies the `pending[index] === null` guard
 * added in stream-merger.ts after the audit.
 */
import { describe, expect, it } from "vitest";
import { mergeStreams } from "../stream-merger.js";

async function* race<T>(values: T[], delays: number[]): AsyncIterable<T> {
  for (let i = 0; i < values.length; i++) {
    const d = delays[i] ?? 0;
    if (d > 0) await new Promise((r) => setTimeout(r, d));
    yield values[i] as T;
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("mergeStreams — P0-1 regression (settled during race)", () => {
  it("does not crash when one source completes mid-race", async () => {
    // Source A finishes early; B keeps going.
    // Race winner of (A done) → mark null → next iteration must skip cleanly.
    const a = race(["a1"], [5]);
    const b = race(["b1", "b2", "b3", "b4"], [10, 10, 10, 10]);
    const out = await collect(mergeStreams(a, b));
    expect(out.sort()).toEqual(["a1", "b1", "b2", "b3", "b4"].sort());
  });

  it("3 sources completing at different times — no orphan iter access", async () => {
    const a = race(["a"], [1]);
    const b = race(["b"], [3]);
    const c = race(["c1", "c2"], [5, 7]);
    const out = await collect(mergeStreams(a, b, c));
    expect(out.length).toBe(4);
    expect(out.sort()).toEqual(["a", "b", "c1", "c2"]);
  });

  it("rapid completion — many sources each yielding 1 then done", async () => {
    const sources = Array.from({ length: 10 }, (_, i) =>
      race([`x${i}`], [Math.random() * 5]),
    );
    const out = await collect(mergeStreams(...sources));
    expect(out.length).toBe(10);
  });
});
