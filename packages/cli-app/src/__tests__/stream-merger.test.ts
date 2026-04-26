import { describe, expect, it } from "vitest";
import { mergeStreams } from "../stream-merger.js";

async function* arr<T>(values: T[], delayMs = 0): AsyncIterable<T> {
  for (const v of values) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield v;
  }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe("mergeStreams — N→1 round-robin", () => {
  it("returns empty for zero sources", async () => {
    expect(await collect(mergeStreams<number>())).toEqual([]);
  });

  it("relays single source preserving order", async () => {
    const out = await collect(mergeStreams(arr([1, 2, 3])));
    expect(out).toEqual([1, 2, 3]);
  });

  it("preserves causal order WITHIN each source", async () => {
    const a = arr(["a1", "a2", "a3"]);
    const b = arr(["b1", "b2", "b3"]);
    const out = await collect(mergeStreams(a, b));
    // each source order preserved (a1 before a2 before a3, etc.)
    const ai = out.indexOf("a1");
    const ai2 = out.indexOf("a2");
    const ai3 = out.indexOf("a3");
    expect(ai).toBeLessThan(ai2);
    expect(ai2).toBeLessThan(ai3);
    const bi = out.indexOf("b1");
    const bi2 = out.indexOf("b2");
    const bi3 = out.indexOf("b3");
    expect(bi).toBeLessThan(bi2);
    expect(bi2).toBeLessThan(bi3);
    // all values present
    expect(out.sort()).toEqual(["a1", "a2", "a3", "b1", "b2", "b3"].sort());
  });

  it("handles different lengths", async () => {
    const a = arr([1, 2]);
    const b = arr([10, 20, 30, 40]);
    const out = await collect(mergeStreams(a, b));
    expect(out.sort()).toEqual([1, 2, 10, 20, 30, 40].sort());
  });

  it("handles delays without losing values", async () => {
    const fast = arr(["f1", "f2", "f3"], 5);
    const slow = arr(["s1", "s2"], 30);
    const out = await collect(mergeStreams(fast, slow));
    expect(out.sort()).toEqual(["f1", "f2", "f3", "s1", "s2"].sort());
  });
});
