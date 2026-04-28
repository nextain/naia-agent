/**
 * Phase 5+ adversarial review fix - StdioDispatcher integration test.
 *
 * Adversarial review: stdio-dispatcher.test.ts (23) + ipc-approval-broker.test.ts
 * (21) = mock streams (Readable.from / Writable subclass). Real handshake
 * negotiation + dispatcher.start -> readline -> parseFrame -> handleFrame chain
 * via PassThrough (real stream events) was never exercised end-to-end.
 *
 * This test uses Node PassThrough streams (real stream events, no mock) for:
 *   - handshake gate enforces first-frame-handshake
 *   - handshake_ack frame emitted with fresh UUID id (Day 3 review fix)
 *   - protocolVersion mismatch -> exit (mocked)
 *   - kind routing to registered handlers (multi-frame batch)
 *   - dispatcher + IpcApprovalBroker dispatched mode end-to-end
 *   - skipHandshake bypass works
 */

import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IpcApprovalBroker,
  StdioDispatcher,
  type FrameHandler,
} from "../index.js";
import type { StdioFrame } from "@nextain/agent-protocol";

interface TestRig {
  inStream: PassThrough;
  outStream: PassThrough;
  capturedOut: string[];
  push: (line: string) => void;
  awaitOut: (predicate: (line: string) => boolean, timeoutMs?: number) => Promise<string>;
}

function makeRig(): TestRig {
  const inStream = new PassThrough();
  const outStream = new PassThrough();
  const capturedOut: string[] = [];
  let outBuffer = "";
  outStream.on("data", (chunk) => {
    outBuffer += chunk.toString("utf-8");
    const lines = outBuffer.split("\n");
    outBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) capturedOut.push(line);
    }
  });

  return {
    inStream,
    outStream,
    capturedOut,
    push: (line: string) => {
      inStream.write(`${line}\n`);
    },
    awaitOut: (predicate, timeoutMs = 1000) =>
      new Promise((resolve, reject) => {
        const start = Date.now();
        const checkInterval = setInterval(() => {
          const found = capturedOut.find(predicate);
          if (found !== undefined) {
            clearInterval(checkInterval);
            resolve(found);
            return;
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(checkInterval);
            reject(new Error(`awaitOut timeout (${timeoutMs}ms). Captured: ${JSON.stringify(capturedOut)}`));
          }
        }, 10);
      }),
  };
}

describe("StdioDispatcher integration - real PassThrough streams", () => {
  let rig: TestRig | null = null;
  let dispatcher: StdioDispatcher | null = null;

  afterEach(() => {
    if (dispatcher) dispatcher.close();
    dispatcher = null;
    if (rig) {
      rig.inStream.end();
      rig.outStream.end();
    }
    rig = null;
  });

  it("handshake gate: first frame MUST be handshake (real readline event)", async () => {
    rig = makeRig();
    dispatcher = new StdioDispatcher({
      in: rig.inStream,
      out: rig.outStream,
      handshakeTimeoutMs: 500,
    });
    let approvalRouted = false;
    dispatcher.register("approval", () => { approvalRouted = true; });
    dispatcher.start();

    // Push non-handshake frame first - should be dropped
    rig.push(JSON.stringify({
      v: "1", id: "early", type: "response",
      payload: { kind: "approval", status: "approved", at: 1 },
    }));
    await new Promise((r) => setTimeout(r, 50));
    expect(approvalRouted).toBe(false);
    expect(dispatcher.handshakeComplete).toBe(false);
  });

  it("handshake -> handshake_ack with fresh UUID (Day 3 P0-NEW-1 fix)", async () => {
    rig = makeRig();
    dispatcher = new StdioDispatcher({
      in: rig.inStream,
      out: rig.outStream,
      agentCapabilities: ["test_capability"],
    });
    dispatcher.start();

    rig.push(JSON.stringify({
      v: "1", id: "hs-1", type: "request",
      payload: { kind: "handshake", protocolVersion: 1 },
    }));

    const ackLine = await rig.awaitOut((l) => l.includes('"kind":"handshake_ack"'));
    const ack = JSON.parse(ackLine) as StdioFrame<{ kind: string; agentCapabilities: string[] }>;
    expect(ack.payload.kind).toBe("handshake_ack");
    expect(ack.payload.agentCapabilities).toEqual(["test_capability"]);
    // Day 3 P0-NEW-1 fix: id MUST be freshly generated (not echoed from request)
    expect(ack.id).not.toBe("hs-1");
    expect(ack.id).toMatch(/^handshake-ack-[0-9a-f-]+$/);
    expect(dispatcher.handshakeComplete).toBe(true);
  });

  it("protocolVersion mismatch triggers exit(3) (real readline event)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      rig = makeRig();
      dispatcher = new StdioDispatcher({ in: rig.inStream, out: rig.outStream });
      dispatcher.start();
      rig.push(JSON.stringify({
        v: "1", id: "hs-bad", type: "request",
        payload: { kind: "handshake", protocolVersion: "99" },
      }));
      await new Promise((r) => setTimeout(r, 50));
      expect(exitSpy).toHaveBeenCalledWith(3);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("post-handshake: multi-frame batch routed by kind", async () => {
    rig = makeRig();
    dispatcher = new StdioDispatcher({ in: rig.inStream, out: rig.outStream, skipHandshake: true });
    const events: Array<{ kind: string; id: string }> = [];
    const recorder: FrameHandler = (f) => {
      const payload = f.payload as { kind: string };
      events.push({ kind: payload.kind, id: f.id });
    };
    dispatcher.register("approval", recorder);
    dispatcher.register("chat", recorder);
    dispatcher.register("panel_install", recorder);
    dispatcher.start();

    rig.push(JSON.stringify({ v: "1", id: "1", type: "response", payload: { kind: "approval", status: "approved", at: 0 } }));
    rig.push(JSON.stringify({ v: "1", id: "2", type: "request", payload: { kind: "chat", messages: [] } }));
    rig.push(JSON.stringify({ v: "1", id: "3", type: "request", payload: { kind: "panel_install", source: "x" } }));
    await new Promise((r) => setTimeout(r, 50));

    expect(events.length).toBe(3);
    expect(events[0]?.kind).toBe("approval");
    expect(events[1]?.kind).toBe("chat");
    expect(events[2]?.kind).toBe("panel_install");
  });

  it("dispatched IpcApprovalBroker end-to-end (real PassThrough)", async () => {
    rig = makeRig();
    dispatcher = new StdioDispatcher({ in: rig.inStream, out: rig.outStream, skipHandshake: true });
    const broker = new IpcApprovalBroker({ out: rig.outStream, mode: "dispatched" });
    try {
      broker.attachToDispatcher(dispatcher);
      dispatcher.start();

      const decisionPromise = broker.decide({
        id: "dispatched-1",
        invocation: { id: "tu", name: "write", input: { path: "x.ts" }, tier: "T2" },
        tier: "T2",
        timeoutMs: 1000,
      });

      // Wait for outbound approval request frame
      const reqLine = await rig.awaitOut((l) => l.includes('"kind":"approval"') && l.includes('"type":"request"'));
      const reqFrame = JSON.parse(reqLine) as StdioFrame;
      expect(reqFrame.id).toBe("dispatched-1");

      // Push response back via real readline event
      rig.push(JSON.stringify({
        v: "1", id: "dispatched-1", type: "response",
        payload: { kind: "approval", status: "approved", at: 12345 },
      }));

      const decision = await decisionPromise;
      expect(decision.status).toBe("approved");
      if (decision.status === "approved") {
        expect(decision.at).toBe(12345);
      }
    } finally {
      broker.close();
    }
  });

  it("approval_cancel event via real readline -> denied with cancel reason", async () => {
    rig = makeRig();
    dispatcher = new StdioDispatcher({ in: rig.inStream, out: rig.outStream, skipHandshake: true });
    const broker = new IpcApprovalBroker({ out: rig.outStream, mode: "dispatched" });
    try {
      broker.attachToDispatcher(dispatcher);
      dispatcher.start();

      const decisionPromise = broker.decide({
        id: "cancel-1",
        invocation: { id: "tu", name: "x", input: {}, tier: "T2" },
        tier: "T2",
        timeoutMs: 5000,
      });

      // Wait for outbound request
      await rig.awaitOut((l) => l.includes('"id":"cancel-1"'));

      // Send cancel event
      rig.push(JSON.stringify({
        v: "1", id: "cancel-1", type: "event",
        payload: { kind: "approval_cancel", reason: "user_sigint" },
      }));

      const decision = await decisionPromise;
      expect(decision.status).toBe("denied");
      if (decision.status === "denied") {
        expect(decision.reason).toContain("user_sigint");
      }
    } finally {
      broker.close();
    }
  });

  it("malformed JSON line handled gracefully (no crash, valid frames continue)", async () => {
    rig = makeRig();
    dispatcher = new StdioDispatcher({ in: rig.inStream, out: rig.outStream, skipHandshake: true });
    const events: string[] = [];
    dispatcher.register("approval", () => events.push("approval"));
    dispatcher.start();

    rig.push("not-json-at-all");
    rig.push("{garbage}");
    rig.push(JSON.stringify({
      v: "1", id: "valid-after-bad", type: "response",
      payload: { kind: "approval", status: "approved", at: 1 },
    }));
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(["approval"]);
  });

  it("invalid kind dropped silently (no handler invoked)", async () => {
    rig = makeRig();
    dispatcher = new StdioDispatcher({ in: rig.inStream, out: rig.outStream, skipHandshake: true });
    let routed = false;
    dispatcher.register("approval", () => { routed = true; });
    dispatcher.start();

    rig.push(JSON.stringify({
      v: "1", id: "x", type: "response",
      payload: { kind: "totally_unknown_kind" },
    }));
    rig.push(JSON.stringify({
      v: "1", id: "y", type: "response",
      payload: { kind: "__proto__" },
    }));
    await new Promise((r) => setTimeout(r, 50));
    expect(routed).toBe(false);
  });
});
