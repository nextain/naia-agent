import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "@nextain/agent-types";
import {
  AutoApproveApprovalBroker,
  AutoDenyApprovalBroker,
  CliApprovalBroker,
} from "../approval-broker.js";

function makeStreams(input: string): {
  in: Readable;
  out: Writable;
  output: () => string;
} {
  const inStream = Readable.from([input]);
  let captured = "";
  const outStream = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString("utf8");
      cb();
    },
  });
  return { in: inStream, out: outStream, output: () => captured };
}

const REQ: ApprovalRequest = {
  id: "req-1",
  invocation: { id: "tu-1", name: "write", input: {}, tier: "T2" },
  tier: "T2",
  reason: "write src/api.ts",
};

describe("CliApprovalBroker", () => {
  it("y → approved", async () => {
    const s = makeStreams("y\n");
    const broker = new CliApprovalBroker({ in: s.in, out: s.out, timeoutMs: 1000 });
    const decision = await broker.decide(REQ);
    expect(decision.status).toBe("approved");
    expect(s.output()).toContain("approval required (T2)");
    expect(s.output()).toContain("✓ approved");
  });

  it("yes → approved (case insensitive)", async () => {
    const s = makeStreams("YES\n");
    const broker = new CliApprovalBroker({ in: s.in, out: s.out, timeoutMs: 1000 });
    const decision = await broker.decide(REQ);
    expect(decision.status).toBe("approved");
  });

  it("n → denied", async () => {
    const s = makeStreams("n\n");
    const broker = new CliApprovalBroker({ in: s.in, out: s.out, timeoutMs: 1000 });
    const decision = await broker.decide(REQ);
    expect(decision.status).toBe("denied");
    expect(s.output()).toContain("✘ denied");
  });

  it("empty → denied (default-deny)", async () => {
    const s = makeStreams("\n");
    const broker = new CliApprovalBroker({ in: s.in, out: s.out, timeoutMs: 1000 });
    const decision = await broker.decide(REQ);
    expect(decision.status).toBe("denied");
  });

  it("P0-2 (Paranoid) — 'always' / 'all' / 'a' do NOT approve", async () => {
    for (const input of ["always\n", "all\n", "a\n", "always allow\n"]) {
      const s = makeStreams(input);
      const broker = new CliApprovalBroker({ in: s.in, out: s.out, timeoutMs: 1000 });
      const decision = await broker.decide(REQ);
      expect(decision.status).toBe("denied");
    }
  });

  it("P0-2 (Paranoid) — input close before line → denied (auto-deny on close)", async () => {
    // readline close before any input → settle as denied with "input closed".
    // Real-world timeout path uses process.stdin (always open) — exercised in E2E.
    const s = makeStreams("");
    const broker = new CliApprovalBroker({ in: s.in, out: s.out, timeoutMs: 5000 });
    const decision = await broker.decide(REQ);
    expect(decision.status).toBe("denied");
  });
});

describe("AutoDenyApprovalBroker", () => {
  it("always denies", async () => {
    const broker = new AutoDenyApprovalBroker();
    const decision = await broker.decide(REQ);
    expect(decision.status).toBe("denied");
  });
});

describe("AutoApproveApprovalBroker", () => {
  it("always approves (testing only)", async () => {
    const broker = new AutoApproveApprovalBroker();
    const decision = await broker.decide(REQ);
    expect(decision.status).toBe("approved");
  });
});
