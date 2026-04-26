/**
 * R4 Phase 4.1 Day 2.4 — IpcApprovalBroker unit tests.
 *
 * Coverage targets:
 * - tier별 default timeout (T1:60s/T2:120s/T3:300s) — fast tests use timeoutMs override
 * - approve / deny / timeout 3 case
 * - SIGINT during modal (approval_cancel event)
 * - agent crash (broker close + pending cleanup)
 * - multiple concurrent approvals (id-based routing)
 * - "always" 차단 (status union 보장)
 * - T0 통과 (approval 없음)
 * - malformed frame drop
 * - broker closed → denied
 * - stale response drop
 * - prototype pollution attempt drop
 */
import { Readable, Writable } from "node:stream";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { ApprovalRequest } from "@nextain/agent-types";
import { IpcApprovalBroker, isValidKind } from "../ipc-approval-broker.js";

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

function makeReq(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: overrides.id ?? "req-1",
    invocation: {
      id: "tu-1",
      name: "write",
      input: { path: "src/api.ts" },
      tier: "T2",
    },
    tier: "T2",
    reason: "write src/api.ts",
    ...overrides,
  };
}

function getRequestFrame(output: string): { v: string; id: string; type: string; payload: any } {
  const lines = output.split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const f = JSON.parse(line);
      if (f.type === "request" && f.payload?.kind === "approval") return f;
    } catch {
      // ignore
    }
  }
  throw new Error(`no approval request frame in output: ${output}`);
}

describe("IpcApprovalBroker — D40 protocol", () => {
  let s: TestStreams;
  let broker: IpcApprovalBroker;

  beforeEach(() => {
    s = makeStreams();
    broker = new IpcApprovalBroker({ in: s.in, out: s.out });
  });

  afterEach(() => {
    broker.close();
  });

  it("emits request/approval frame with payload", async () => {
    const decisionPromise = broker.decide(makeReq({ id: "id-emit", timeoutMs: 1000 }));

    // Simulate host approval
    s.push(JSON.stringify({
      v: "1",
      id: "id-emit",
      type: "response",
      payload: { kind: "approval", status: "approved", at: Date.now() },
    }));

    const decision = await decisionPromise;
    expect(decision.status).toBe("approved");

    const frame = getRequestFrame(s.output());
    expect(frame.v).toBe("1");
    expect(frame.id).toBe("id-emit");
    expect(frame.payload.kind).toBe("approval");
    expect(frame.payload.tier).toBe("T2");
    expect(frame.payload.toolName).toBe("write");
    expect(frame.payload.summary).toBe("write src/api.ts");
    expect(frame.payload.timeoutMs).toBe(1000);
  });

  it("approved → status approved", async () => {
    const p = broker.decide(makeReq({ id: "id-app", timeoutMs: 1000 }));
    s.push(JSON.stringify({
      v: "1", id: "id-app", type: "response",
      payload: { kind: "approval", status: "approved", at: 12345 },
    }));
    const d = await p;
    expect(d).toEqual({ status: "approved", at: 12345 });
  });

  it("denied → status denied + reason", async () => {
    const p = broker.decide(makeReq({ id: "id-den", timeoutMs: 1000 }));
    s.push(JSON.stringify({
      v: "1", id: "id-den", type: "response",
      payload: { kind: "approval", status: "denied", reason: "user clicked deny", at: 12346 },
    }));
    const d = await p;
    expect(d.status).toBe("denied");
    if (d.status === "denied") {
      expect(d.reason).toBe("user clicked deny");
      expect(d.at).toBe(12346);
    }
  });

  it("timeout → status timeout", async () => {
    const p = broker.decide(makeReq({ id: "id-to", timeoutMs: 50 }));
    const d = await p;
    expect(d.status).toBe("timeout");
  }, 1000);

  it("approval_cancel event → denied with cancel reason (M1 SIGINT)", async () => {
    const p = broker.decide(makeReq({ id: "id-cancel", timeoutMs: 5000 }));
    s.push(JSON.stringify({
      v: "1", id: "id-cancel", type: "event",
      payload: { kind: "approval_cancel", reason: "user_sigint" },
    }));
    const d = await p;
    expect(d.status).toBe("denied");
    if (d.status === "denied") {
      expect(d.reason).toContain("cancelled");
      expect(d.reason).toContain("user_sigint");
    }
  });

  it("T0 → immediately approved (no IPC roundtrip)", async () => {
    const d = await broker.decide(makeReq({ id: "id-t0", tier: "T0", invocation: { id: "tu", name: "ls", input: {}, tier: "T0" } }));
    expect(d.status).toBe("approved");
    // No frame should be emitted for T0
    expect(s.output()).toBe("");
  });

  it("multiple concurrent approvals routed by id", async () => {
    const p1 = broker.decide(makeReq({ id: "id-a", timeoutMs: 1000 }));
    const p2 = broker.decide(makeReq({ id: "id-b", timeoutMs: 1000 }));
    const p3 = broker.decide(makeReq({ id: "id-c", timeoutMs: 1000 }));

    expect(broker.pendingCount()).toBe(3);

    // Respond out of order
    s.push(JSON.stringify({ v: "1", id: "id-b", type: "response", payload: { kind: "approval", status: "denied", reason: "b", at: 1 } }));
    s.push(JSON.stringify({ v: "1", id: "id-c", type: "response", payload: { kind: "approval", status: "approved", at: 2 } }));
    s.push(JSON.stringify({ v: "1", id: "id-a", type: "response", payload: { kind: "approval", status: "approved", at: 3 } }));

    const [d1, d2, d3] = await Promise.all([p1, p2, p3]);
    expect(d1.status).toBe("approved");
    expect(d2.status).toBe("denied");
    expect(d3.status).toBe("approved");
    expect(broker.pendingCount()).toBe(0);
  });

  it("'always' is silently dropped — D40 fresh-per-tier (only approved/denied/timeout settle)", async () => {
    const p = broker.decide(makeReq({ id: "id-always", timeoutMs: 80 }));
    // Inject illegal "always" status — broker must NOT settle (will timeout)
    s.push(JSON.stringify({
      v: "1", id: "id-always", type: "response",
      payload: { kind: "approval", status: "always", at: 1 },
    }));
    const d = await p;
    expect(d.status).toBe("timeout"); // "always" was rejected → timed out
  }, 1000);

  it("stale response (unknown id) → silently dropped (P2-2)", async () => {
    // No pending request — push response anyway
    s.push(JSON.stringify({
      v: "1", id: "stale-id", type: "response",
      payload: { kind: "approval", status: "approved", at: 1 },
    }));
    // Allow IO loop tick
    await new Promise((r) => setTimeout(r, 10));
    expect(broker.pendingCount()).toBe(0);
  });

  it("malformed frame → drop + no crash", async () => {
    s.push("not-json-at-all");
    s.push("{\"missing\":\"shape\"}");
    s.push(JSON.stringify({ v: "1", id: "x", type: "response" })); // missing payload
    await new Promise((r) => setTimeout(r, 10));
    // Broker should still be alive — issue a real request
    const p = broker.decide(makeReq({ id: "id-mal", timeoutMs: 50 }));
    const d = await p;
    expect(d.status).toBe("timeout");
  }, 1000);

  it("prototype pollution attempt — drop kind '__proto__'", async () => {
    const p = broker.decide(makeReq({ id: "id-proto", timeoutMs: 80 }));
    s.push(JSON.stringify({
      v: "1", id: "id-proto", type: "response",
      payload: { kind: "__proto__", status: "approved", at: 1 },
    }));
    const d = await p;
    expect(d.status).toBe("timeout"); // dropped — pending stayed
  }, 1000);

  it("close() settles all pending as denied (agent crash recovery)", async () => {
    const p1 = broker.decide(makeReq({ id: "id-x", timeoutMs: 5000 }));
    const p2 = broker.decide(makeReq({ id: "id-y", timeoutMs: 5000 }));
    expect(broker.pendingCount()).toBe(2);

    broker.close();

    const [d1, d2] = await Promise.all([p1, p2]);
    expect(d1.status).toBe("denied");
    expect(d2.status).toBe("denied");
    if (d1.status === "denied") {
      expect(d1.reason).toBe("broker closed");
    }
    expect(broker.pendingCount()).toBe(0);
  });

  it("decide() after close() → immediately denied", async () => {
    broker.close();
    const d = await broker.decide(makeReq({ id: "id-z" }));
    expect(d.status).toBe("denied");
    if (d.status === "denied") {
      expect(d.reason).toBe("broker closed");
    }
  });

  it("input stream end → close() (denied all pending)", async () => {
    const p = broker.decide(makeReq({ id: "id-eos", timeoutMs: 5000 }));
    s.in.push(null); // EOF
    const d = await p;
    expect(d.status).toBe("denied");
  });
});

describe("IpcApprovalBroker — tier default timeouts (D40)", () => {
  it("T1 default = 60_000ms (override applied for fast test)", async () => {
    const s = makeStreams();
    const broker = new IpcApprovalBroker({
      in: s.in,
      out: s.out,
      defaultTimeoutMs: { T1: 30 },
    });
    try {
      const p = broker.decide(makeReq({
        id: "t1",
        tier: "T1",
        invocation: { id: "tu", name: "x", input: {}, tier: "T1" },
      }));
      const d = await p;
      expect(d.status).toBe("timeout");
      const frame = getRequestFrame(s.output());
      expect(frame.payload.timeoutMs).toBe(30);
    } finally {
      broker.close();
    }
  }, 500);

  it("T3 default override 50ms", async () => {
    const s = makeStreams();
    const broker = new IpcApprovalBroker({
      in: s.in,
      out: s.out,
      defaultTimeoutMs: { T3: 50 },
    });
    try {
      const p = broker.decide(makeReq({
        id: "t3",
        tier: "T3",
        invocation: { id: "tu", name: "delete", input: {}, tier: "T3" },
      }));
      const d = await p;
      expect(d.status).toBe("timeout");
    } finally {
      broker.close();
    }
  }, 500);

  it("explicit timeoutMs overrides tier default", async () => {
    const s = makeStreams();
    const broker = new IpcApprovalBroker({ in: s.in, out: s.out });
    try {
      const p = broker.decide(makeReq({ id: "ovr", timeoutMs: 40 }));
      const d = await p;
      expect(d.status).toBe("timeout");
      const frame = getRequestFrame(s.output());
      expect(frame.payload.timeoutMs).toBe(40);
    } finally {
      broker.close();
    }
  }, 500);
});

describe("isValidKind — Paranoid P1-1 whitelist", () => {
  it("allowed kinds pass", () => {
    expect(isValidKind("approval")).toBe(true);
    expect(isValidKind("chat")).toBe(true);
    expect(isValidKind("handshake")).toBe(true);
  });

  it("__proto__ / constructor / prototype rejected", () => {
    expect(isValidKind("__proto__")).toBe(false);
    expect(isValidKind("constructor")).toBe(false);
    expect(isValidKind("prototype")).toBe(false);
  });

  it("unknown kind rejected", () => {
    expect(isValidKind("unknown_kind")).toBe(false);
    expect(isValidKind("")).toBe(false);
  });

  it("non-string rejected", () => {
    expect(isValidKind(undefined)).toBe(false);
    expect(isValidKind(null)).toBe(false);
    expect(isValidKind(42)).toBe(false);
    expect(isValidKind({})).toBe(false);
  });
});
