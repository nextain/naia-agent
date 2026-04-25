// Slice 2 sub-B — NoopTracer unit tests (G05).

import { describe, it, expect } from "vitest";
import { NoopTracer } from "../tracer.js";

describe("NoopTracer", () => {
  it("startSpan returns a Span instance", () => {
    const t = new NoopTracer();
    const span = t.startSpan("op");
    expect(span).toBeDefined();
    expect(typeof span.setAttribute).toBe("function");
    expect(typeof span.setStatus).toBe("function");
    expect(typeof span.end).toBe("function");
  });

  it("Span methods are no-ops (do not throw)", () => {
    const t = new NoopTracer();
    const span = t.startSpan("op");
    expect(() => {
      span.setAttribute("k", "v");
      span.setStatus("ok");
      span.end();
    }).not.toThrow();
  });

  it("accepts optional parent SpanContext", () => {
    const t = new NoopTracer();
    const parent = { traceId: "t1", spanId: "s1" };
    expect(() => t.startSpan("child", parent)).not.toThrow();
  });
});
