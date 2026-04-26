import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  NaiaStreamChunk,
  SubAgentAdapter,
  SubAgentSession,
  SubAgentStatus,
  Verifier,
  VerificationResult,
  VerifierContext,
  WorkspaceWatcher,
} from "@nextain/agent-types";
import { Phase1Supervisor } from "../supervisor.js";

let workdir = "";

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "naia-supe-"));
});
afterEach(() => {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

class FakeSession implements SubAgentSession {
  readonly id = "fake-1";
  readonly adapterId = "fake";
  readonly startedAt = Date.now();
  readonly #events: NaiaStreamChunk[];
  readonly #delayMs: number;
  constructor(events: NaiaStreamChunk[], delayMs = 0) {
    this.#events = events;
    this.#delayMs = delayMs;
  }
  events(): AsyncIterable<NaiaStreamChunk> {
    const evs = this.#events;
    const d = this.#delayMs;
    return (async function* () {
      for (const e of evs) {
        if (d > 0) await new Promise((r) => setTimeout(r, d));
        yield e;
      }
    })();
  }
  async cancel(): Promise<void> {
    /* noop */
  }
  async pause(): Promise<void> {
    throw new Error("Unsupported");
  }
  async resume(): Promise<void> {
    throw new Error("Unsupported");
  }
  async inject(): Promise<void> {
    throw new Error("Unsupported");
  }
  status(): SubAgentStatus {
    return { phase: "ended", reason: "completed", durationMs: 1 };
  }
}

class FakeAdapter implements SubAgentAdapter {
  readonly id = "fake";
  readonly name = "FakeAdapter";
  readonly version = "0.0.0";
  readonly capabilities = ["text_chat" as const];
  readonly #events: NaiaStreamChunk[];
  readonly #delayMs: number;
  constructor(events: NaiaStreamChunk[], delayMs = 0) {
    this.#events = events;
    this.#delayMs = delayMs;
  }
  async spawn(): Promise<SubAgentSession> {
    return new FakeSession(this.#events, this.#delayMs);
  }
}

class FakeVerifier implements Verifier {
  readonly id: "test" | "lint" | "build" | "type_check";
  readonly defaultCommand = "echo";
  readonly #pass: boolean;
  readonly #stats: VerificationResult["stats"];
  constructor(id: FakeVerifier["id"], pass: boolean, stats: VerificationResult["stats"] = {}) {
    this.id = id;
    this.#pass = pass;
    this.#stats = stats;
  }
  async run(_workdir: string, _ctx: VerifierContext): Promise<VerificationResult> {
    return {
      runner: this.id,
      pass: this.#pass,
      stats: this.#stats,
      durationMs: 10,
    };
  }
}

class FakeWatcher implements WorkspaceWatcher {
  readonly #files: { path: string; kind: "add" | "modify" | "delete" }[];
  readonly #stats: { additions: number; deletions: number };
  constructor(files: FakeWatcher["#files"], stats: FakeWatcher["#stats"]) {
    this.#files = files;
    this.#stats = stats;
  }
  watch(_workdir: string, signal: AbortSignal): AsyncIterable<{ path: string; kind: "add" | "modify" | "delete"; timestamp: number }> {
    const files = this.#files;
    return (async function* () {
      for (const f of files) {
        if (signal.aborted) break;
        await new Promise((r) => setTimeout(r, 5));
        yield { ...f, timestamp: Date.now() };
      }
    })();
  }
  async diff(): Promise<string | null> {
    return null;
  }
  async stats(): Promise<{ additions: number; deletions: number }> {
    return this.#stats;
  }
}

const SAMPLE_EVENTS: NaiaStreamChunk[] = [
  { type: "session_start", sessionId: "fake-1", adapterId: "fake", taskSummary: "test", workdir: "/tmp" },
  { type: "session_progress", sessionId: "fake-1", phase: "planning" },
  { type: "text_delta", sessionId: "fake-1", text: "hi" },
  { type: "session_end", sessionId: "fake-1", reason: "completed" },
];

describe("Phase1Supervisor — minimal flow", () => {
  it("yields session_start..session_end + report + end", async () => {
    const supe = new Phase1Supervisor({
      adapter: new FakeAdapter(SAMPLE_EVENTS),
      noVerify: true,
    });
    const out: NaiaStreamChunk[] = [];
    for await (const c of supe.run("test prompt", workdir, new AbortController().signal)) {
      out.push(c);
    }
    const types = out.map((c) => c.type);
    expect(types).toContain("session_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("session_end");
    expect(types).toContain("session_aggregated");
    expect(types).toContain("report");
    expect(types[types.length - 1]).toBe("end");
  });

  it("noVerify=true skips verification phase", async () => {
    const supe = new Phase1Supervisor({
      adapter: new FakeAdapter(SAMPLE_EVENTS),
      verifiers: [new FakeVerifier("test", true, { passed: 5, total: 5 })],
      noVerify: true,
    });
    const out: NaiaStreamChunk[] = [];
    for await (const c of supe.run("p", workdir, new AbortController().signal)) out.push(c);
    expect(out.find((c) => c.type === "verification_start")).toBeUndefined();
    expect(out.find((c) => c.type === "verification_result")).toBeUndefined();
  });

  it("verifier results are emitted as verification_result chunks", async () => {
    const supe = new Phase1Supervisor({
      adapter: new FakeAdapter(SAMPLE_EVENTS),
      verifiers: [
        new FakeVerifier("test", true, { passed: 5, total: 5 }),
        new FakeVerifier("type_check", true),
      ],
    });
    const out: NaiaStreamChunk[] = [];
    for await (const c of supe.run("p", workdir, new AbortController().signal)) out.push(c);
    const results = out.filter((c) => c.type === "verification_result");
    expect(results.length).toBe(2);
    expect(out.find((c) => c.type === "report")?.type).toBe("report");
  });

  it("workspace_change events are interleaved into the merged stream", async () => {
    writeFileSync(path.join(workdir, "x.txt"), "hi");
    const watcher = new FakeWatcher(
      [{ path: "x.txt", kind: "add" }],
      { additions: 1, deletions: 0 },
    );
    // adapter delay 20ms per event so watcher (5ms) wins race for at least one
    const supe = new Phase1Supervisor({
      adapter: new FakeAdapter(SAMPLE_EVENTS, 20),
      watcher,
      noVerify: true,
    });
    const out: NaiaStreamChunk[] = [];
    for await (const c of supe.run("p", workdir, new AbortController().signal)) out.push(c);
    const wc = out.filter((c) => c.type === "workspace_change");
    expect(wc.length).toBeGreaterThan(0);
    expect(wc.some((c) => c.type === "workspace_change" && c.path === "x.txt")).toBe(true);
  });

  it("report.stats reflects watcher additions/deletions", async () => {
    const watcher = new FakeWatcher(
      [{ path: "a.ts", kind: "add" }],
      { additions: 12, deletions: 3 },
    );
    const supe = new Phase1Supervisor({
      adapter: new FakeAdapter(SAMPLE_EVENTS),
      watcher,
      noVerify: true,
    });
    const out: NaiaStreamChunk[] = [];
    for await (const c of supe.run("p", workdir, new AbortController().signal)) out.push(c);
    const report = out.find((c) => c.type === "report");
    expect(report?.type === "report" && report.stats.additions).toBe(12);
    expect(report?.type === "report" && report.stats.deletions).toBe(3);
  });
});
