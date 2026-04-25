// Slice 2 sub-B — ConsoleLogger unit tests (G05 + D06).

import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { ConsoleLogger, SilentLogger } from "../logger.js";

function captureStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines };
}

describe("ConsoleLogger", () => {
  it("emits info messages as JSON-lines", () => {
    const { stream, lines } = captureStream();
    const log = new ConsoleLogger({ stream });
    log.info("hello", { foo: "bar" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(parsed.foo).toBe("bar");
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("filters by level (default info hides debug)", () => {
    const { stream, lines } = captureStream();
    const log = new ConsoleLogger({ stream });
    log.debug("hidden");
    log.info("visible");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe("visible");
  });

  it("includes baseContext in every entry", () => {
    const { stream, lines } = captureStream();
    const log = new ConsoleLogger({ stream, baseContext: { service: "x" } });
    log.warn("hi");
    expect(JSON.parse(lines[0]!).service).toBe("x");
  });

  it("includes err details on error()", () => {
    const { stream, lines } = captureStream();
    const log = new ConsoleLogger({ stream });
    log.error("boom", new Error("nope"));
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.err.name).toBe("Error");
    expect(parsed.err.message).toBe("nope");
  });

  describe("D06 — tag()", () => {
    it("returns a child logger with merged tags", () => {
      const { stream, lines } = captureStream();
      const log = new ConsoleLogger({ stream });
      const tagged = log.tag!("agent", "slice-2");
      tagged.info("test");
      expect(JSON.parse(lines[0]!).tags).toEqual(["agent", "slice-2"]);
    });

    it("appends to existing tags (not replace)", () => {
      const { stream, lines } = captureStream();
      const log = new ConsoleLogger({ stream, baseContext: { tags: ["a"] } });
      log.tag!("b", "c").info("test");
      expect(JSON.parse(lines[0]!).tags).toEqual(["a", "b", "c"]);
    });

    it("does not mutate parent logger", () => {
      const { stream, lines } = captureStream();
      const log = new ConsoleLogger({ stream });
      log.tag!("child");
      log.info("from-parent");
      expect(JSON.parse(lines[0]!).tags).toBeUndefined();
    });
  });

  describe("D06 — time()", () => {
    it("emits an info log with elapsedMs on stop()", async () => {
      const { stream, lines } = captureStream();
      const log = new ConsoleLogger({ stream });
      const stop = log.time!("op", { foo: "bar" });
      await new Promise((r) => setTimeout(r, 10));
      stop();
      const parsed = JSON.parse(lines[0]!);
      expect(parsed.msg).toBe("op.elapsed");
      expect(parsed.elapsedMs).toBeGreaterThanOrEqual(5);
      expect(parsed.foo).toBe("bar");
    });
  });
});

describe("SilentLogger", () => {
  it("emits nothing", () => {
    const log = new SilentLogger();
    log.debug("x");
    log.info("x");
    log.warn("x");
    log.error("x");
    log.fatal("x");
    // No throw, no output. Just verify the methods exist.
    expect(typeof log.info).toBe("function");
  });
});
