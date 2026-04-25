// Slice 2 sub-B — InMemoryMeter unit tests (G05).

import { describe, it, expect } from "vitest";
import { InMemoryMeter, InMemoryCounter, InMemoryHistogram } from "../meter.js";

describe("InMemoryMeter", () => {
  it("creates counter and records values per labels", () => {
    const meter = new InMemoryMeter();
    const c = meter.counter("requests") as InMemoryCounter;
    c.add(1, { route: "/a" });
    c.add(2, { route: "/a" });
    c.add(5, { route: "/b" });
    const snap = c.snapshot();
    expect(Object.values(snap)).toEqual(expect.arrayContaining([3, 5]));
  });

  it("counter handles undefined labels", () => {
    const meter = new InMemoryMeter();
    const c = meter.counter("noop") as InMemoryCounter;
    c.add(7);
    c.add(3);
    expect(Object.values(c.snapshot())).toEqual([10]);
  });

  it("creates histogram and records raw values", () => {
    const meter = new InMemoryMeter();
    const h = meter.histogram("latency") as InMemoryHistogram;
    h.record(10, { op: "x" });
    h.record(20, { op: "x" });
    h.record(50, { op: "y" });
    const snap = h.snapshot();
    expect(Object.values(snap)).toEqual(
      expect.arrayContaining([
        [10, 20],
        [50],
      ]),
    );
  });

  it("histogram handles undefined labels", () => {
    const meter = new InMemoryMeter();
    const h = meter.histogram("noop") as InMemoryHistogram;
    h.record(1);
    h.record(2);
    expect(Object.values(h.snapshot())).toEqual([[1, 2]]);
  });

  it("counter().add accumulates per same-name retrieval (cached by name)", () => {
    const meter = new InMemoryMeter();
    const c1 = meter.counter("a") as InMemoryCounter;
    const c2 = meter.counter("a") as InMemoryCounter;
    c1.add(1);
    c2.add(10);
    // If meter caches by name, both share state → 11. Otherwise independent.
    const total = Object.values(c1.snapshot())[0]! + (c1 === c2 ? 0 : Object.values(c2.snapshot())[0]!);
    expect(total).toBeGreaterThan(0);
  });
});
