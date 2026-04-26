import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { InterruptManager } from "../interrupt-manager.js";

describe("InterruptManager", () => {
  it("trigger() aborts the signal exactly once (P2-1 debounce)", () => {
    let captured = "";
    const err = new Writable({
      write(c, _e, cb) {
        captured += c.toString("utf8");
        cb();
      },
    });
    const im = new InterruptManager({ err });
    expect(im.signal.aborted).toBe(false);
    im.trigger("first");
    expect(im.signal.aborted).toBe(true);
    im.trigger("second"); // debounced
    im.trigger("third");
    // message printed only once
    const matches = captured.match(/interrupt — cancelling/g);
    expect(matches?.length ?? 0).toBe(1);
  });

  it("custom message respected", () => {
    let captured = "";
    const err = new Writable({
      write(c, _e, cb) {
        captured += c.toString("utf8");
        cb();
      },
    });
    const im = new InterruptManager({ err, message: "STOP STOP" });
    im.trigger("user");
    expect(captured).toContain("STOP STOP");
  });

  it("aborted flag tracks state", () => {
    const err = new Writable({ write(_c, _e, cb) { cb(); } });
    const im = new InterruptManager({ err });
    expect(im.aborted).toBe(false);
    im.trigger("test");
    expect(im.aborted).toBe(true);
  });
});
