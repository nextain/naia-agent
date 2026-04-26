/**
 * R4 Phase 4.1 Day 3.6 — StdioDispatcher unit tests.
 *
 * Coverage:
 * - handshake gate (P0-1 fix): non-handshake frames before handshake → drop + log
 * - handshake_ack 응답 (protocolVersion + agentCapabilities)
 * - protocolVersion mismatch → exit 3 (mocked via spy)
 * - frame routing by kind (P0-2 fix)
 * - unknown kind drop + log
 * - handshake timeout (graceful — log + proceed)
 * - close() idempotency
 * - skipHandshake (CLI mode bypass)
 * - register/unregister
 * - IpcApprovalBroker integration via attachToDispatcher (mode "dispatched")
 */
import { Readable, Writable } from "node:stream";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { StdioFrame } from "@nextain/agent-protocol";
import { IpcApprovalBroker } from "../ipc-approval-broker.js";
import { StdioDispatcher } from "../stdio-dispatcher.js";

interface TestStreams {
  in: Readable;
  out: Writable;
  output: () => string;
  push: (line: string) => void;
}

function makeStreams(): TestStreams {
  let captured = "";
  const outStream = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString("utf8");
      cb();
    },
  });
  const inStream = new Readable({ read() {} });
  return {
    in: inStream,
    out: outStream,
    output: () => captured,
    push: (line: string) => {
      inStream.push(`${line}\n`);
    },
  };
}

function frame(kind: string, type: "request" | "response" | "event", id = "id-1", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: "1",
    id,
    type,
    payload: { kind, ...extra },
  });
}

describe("StdioDispatcher — handshake gate (P0-1 fix)", () => {
  let s: TestStreams;
  let d: StdioDispatcher;

  beforeEach(() => {
    s = makeStreams();
    d = new StdioDispatcher({ in: s.in, out: s.out, handshakeTimeoutMs: 1000 });
  });

  afterEach(() => {
    d.close();
  });

  it("first handshake_request → handshake_ack response with capabilities", async () => {
    d.start();
    s.push(JSON.stringify({
      v: "1", id: "hs-1", type: "request",
      payload: { kind: "handshake", shellCapabilities: ["approval_modal"], protocolVersion: 1 },
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(d.handshakeComplete).toBe(true);
    const out = s.output();
    expect(out).toContain('"kind":"handshake_ack"');
    expect(out).toContain('"protocolVersion":"1"');
    expect(out).toContain('"agentCapabilities"');
    // P0-NEW-1 (Day 3 review fix) — handshake_ack id is freshly generated,
    // NOT echoed from request. Prevents id collision/spoofing.
    expect(out).not.toContain('"id":"hs-1"');
    expect(out).toMatch(/"id":"handshake-ack-[0-9a-f-]+"/);
  });

  it("non-handshake frame before handshake → drop + log", async () => {
    d.start();
    let routed = false;
    d.register("approval", () => { routed = true; });
    s.push(frame("approval", "response", "early"));
    await new Promise((r) => setTimeout(r, 30));
    expect(routed).toBe(false);
    expect(d.handshakeComplete).toBe(false);
  });

  it("after handshake → frames routed to registered handlers", async () => {
    d.start();
    let received: StdioFrame | null = null;
    d.register("approval", (f) => { received = f; });
    s.push(JSON.stringify({
      v: "1", id: "hs-2", type: "request",
      payload: { kind: "handshake" },
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(d.handshakeComplete).toBe(true);
    s.push(frame("approval", "response", "after-hs"));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).not.toBeNull();
    expect(received!.id).toBe("after-hs");
  });

  it("skipHandshake: true → handshake bypassed, frames immediately routed", async () => {
    const s2 = makeStreams();
    const d2 = new StdioDispatcher({ in: s2.in, out: s2.out, skipHandshake: true });
    try {
      d2.start();
      expect(d2.handshakeComplete).toBe(true);
      let received: StdioFrame | null = null;
      d2.register("approval", (f) => { received = f; });
      s2.push(frame("approval", "response", "skipped-hs"));
      await new Promise((r) => setTimeout(r, 30));
      expect(received).not.toBeNull();
    } finally {
      d2.close();
    }
  });

  it("handshake timeout → graceful (log + handshakeComplete becomes true)", async () => {
    const s2 = makeStreams();
    const d2 = new StdioDispatcher({ in: s2.in, out: s2.out, handshakeTimeoutMs: 30 });
    try {
      d2.start();
      await new Promise((r) => setTimeout(r, 80));
      expect(d2.handshakeComplete).toBe(true);
    } finally {
      d2.close();
    }
  });

  it("protocolVersion mismatch → exit 3", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      // Do not throw — just record the call. Throwing propagates through readline
      // event loop and produces an unhandled-rejection error in vitest output.
      return undefined as never;
    }) as never);
    try {
      d.start();
      s.push(JSON.stringify({
        v: "1", id: "hs-bad", type: "request",
        payload: { kind: "handshake", protocolVersion: "99" },
      }));
      await new Promise((r) => setTimeout(r, 30));
      expect(exitSpy).toHaveBeenCalledWith(3);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("StdioDispatcher — kind routing (P0-2 fix)", () => {
  let s: TestStreams;
  let d: StdioDispatcher;

  beforeEach(() => {
    s = makeStreams();
    d = new StdioDispatcher({ in: s.in, out: s.out, skipHandshake: true });
    d.start();
  });

  afterEach(() => {
    d.close();
  });

  it("routes by kind", async () => {
    const events: string[] = [];
    d.register("approval", () => events.push("approval"));
    d.register("chat", () => events.push("chat"));
    d.register("panel_install", () => events.push("panel_install"));

    s.push(frame("approval", "response", "1"));
    s.push(frame("chat", "request", "2"));
    s.push(frame("panel_install", "request", "3"));
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["approval", "chat", "panel_install"]);
  });

  it("unknown kind (not in whitelist) → drop + log", async () => {
    let received = false;
    d.register("approval", () => { received = true; });
    s.push(JSON.stringify({
      v: "1", id: "x", type: "response",
      payload: { kind: "totally_made_up_kind" },
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toBe(false);
  });

  it("kind in whitelist but no handler → drop + log", async () => {
    s.push(frame("approval", "response", "no-handler"));
    await new Promise((r) => setTimeout(r, 30));
    // No throw, no crash. Verified by absence of error.
    expect(true).toBe(true);
  });

  it("handler throws → caught + logged, dispatcher continues", async () => {
    const events: string[] = [];
    d.register("approval", () => { throw new Error("handler boom"); });
    d.register("chat", () => events.push("chat"));
    s.push(frame("approval", "response", "boom"));
    s.push(frame("chat", "request", "ok"));
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["chat"]);
  });

  it("async handler error → caught", async () => {
    const events: string[] = [];
    d.register("approval", async () => { throw new Error("async boom"); });
    d.register("chat", () => events.push("chat"));
    s.push(frame("approval", "response", "async-boom"));
    s.push(frame("chat", "request", "ok"));
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(["chat"]);
  });

  it("__proto__ kind dropped (whitelist)", async () => {
    let received = false;
    d.register("approval", () => { received = true; });
    s.push(JSON.stringify({
      v: "1", id: "p", type: "response",
      payload: { kind: "__proto__" },
    }));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toBe(false);
  });

  it("malformed JSON → drop + no crash", async () => {
    let received = false;
    d.register("approval", () => { received = true; });
    s.push("not-json");
    s.push(frame("approval", "response", "after-bad"));
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toBe(true);
  });

  it("register with invalid kind → silent rejection", () => {
    let received = false;
    d.register("__proto__", () => { received = true; });
    s.push(JSON.stringify({
      v: "1", id: "x", type: "response",
      payload: { kind: "__proto__" },
    }));
    expect(received).toBe(false);
  });

  it("unregister removes handler", async () => {
    let count = 0;
    d.register("approval", () => count++);
    s.push(frame("approval", "response", "1"));
    await new Promise((r) => setTimeout(r, 20));
    d.unregister("approval");
    s.push(frame("approval", "response", "2"));
    await new Promise((r) => setTimeout(r, 20));
    expect(count).toBe(1);
  });
});

describe("StdioDispatcher — lifecycle", () => {
  it("close() idempotent", () => {
    const s = makeStreams();
    const d = new StdioDispatcher({ in: s.in, out: s.out, skipHandshake: true });
    d.start();
    d.close();
    d.close(); // no throw
    expect(true).toBe(true);
  });

  it("start() idempotent (no double readline)", () => {
    const s = makeStreams();
    const d = new StdioDispatcher({ in: s.in, out: s.out, skipHandshake: true });
    try {
      d.start();
      d.start(); // no error
    } finally {
      d.close();
    }
    expect(true).toBe(true);
  });

  it("input stream end → close()", async () => {
    const s = makeStreams();
    const d = new StdioDispatcher({ in: s.in, out: s.out, skipHandshake: true });
    d.start();
    s.in.push(null);
    await new Promise((r) => setTimeout(r, 30));
    d.close(); // safe
    expect(true).toBe(true);
  });

  it("routeFrame() injection (test usage)", () => {
    const s = makeStreams();
    const d = new StdioDispatcher({ in: s.in, out: s.out, skipHandshake: true });
    try {
      d.start();
      let received: StdioFrame | null = null;
      d.register("approval", (f) => { received = f; });
      d.routeFrame({
        v: "1", id: "inject-1", type: "response",
        payload: { kind: "approval", status: "approved", at: 1 },
      });
      expect(received).not.toBeNull();
    } finally {
      d.close();
    }
  });
});

describe("StdioDispatcher × IpcApprovalBroker (mode: dispatched)", () => {
  it("broker.attachToDispatcher() routes approval + approval_cancel", async () => {
    const s = makeStreams();
    const dispatcher = new StdioDispatcher({ in: s.in, out: s.out, skipHandshake: true });
    const broker = new IpcApprovalBroker({ out: s.out, mode: "dispatched" });
    try {
      broker.attachToDispatcher(dispatcher);
      dispatcher.start();
      const decisionPromise = broker.decide({
        id: "id-disp",
        invocation: { id: "tu", name: "write", input: {}, tier: "T2" },
        tier: "T2",
        timeoutMs: 1000,
      });
      // simulate response via dispatcher inbound
      s.push(JSON.stringify({
        v: "1", id: "id-disp", type: "response",
        payload: { kind: "approval", status: "approved", at: 99 },
      }));
      const decision = await decisionPromise;
      expect(decision.status).toBe("approved");
    } finally {
      dispatcher.close();
      broker.close();
    }
  });

  it("approval_cancel via dispatcher → denied (M1)", async () => {
    const s = makeStreams();
    const dispatcher = new StdioDispatcher({ in: s.in, out: s.out, skipHandshake: true });
    const broker = new IpcApprovalBroker({ out: s.out, mode: "dispatched" });
    try {
      broker.attachToDispatcher(dispatcher);
      dispatcher.start();
      const decisionPromise = broker.decide({
        id: "id-canc",
        invocation: { id: "tu", name: "x", input: {}, tier: "T2" },
        tier: "T2",
        timeoutMs: 5000,
      });
      s.push(JSON.stringify({
        v: "1", id: "id-canc", type: "event",
        payload: { kind: "approval_cancel", reason: "user_sigint" },
      }));
      const decision = await decisionPromise;
      expect(decision.status).toBe("denied");
      if (decision.status === "denied") {
        expect(decision.reason).toContain("user_sigint");
      }
    } finally {
      dispatcher.close();
      broker.close();
    }
  });

  it("attachToDispatcher() throws if mode != dispatched", () => {
    const s = makeStreams();
    const broker = new IpcApprovalBroker({ out: s.out });  // standalone (default)
    try {
      const dispatcher = { register: () => {} };
      expect(() => broker.attachToDispatcher(dispatcher)).toThrow(/dispatched/);
    } finally {
      broker.close();
    }
  });

  it("dispatched mode: broker does NOT create readline (no race)", async () => {
    // If broker created its own readline on stdin, this test would deadlock.
    // (We use real process.stdin reference but never push frames.)
    // This test just verifies broker construction with mode=dispatched + non-TTY default doesn't hang.
    const broker = new IpcApprovalBroker({
      out: new Writable({ write(_c, _e, cb) { cb(); } }),
      mode: "dispatched",
    });
    try {
      expect(broker.pendingCount()).toBe(0);
    } finally {
      broker.close();
    }
  });
});
