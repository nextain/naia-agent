import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDurableSupervisorStore } from "../main/adapters/sqlite-durable-supervisor-store.js";
import { DurableSupervisor } from "../main/app/durable-supervisor.js";
import { wireDurableSupervisorRuntime } from "../main/composition/durable-supervisor.js";
import type { DurableDispatchCommand } from "../main/domain/durable-supervisor.js";
import type { DurableCommandDispatcher, DurableSupervisorScheduler } from "../main/ports/durable-supervisor.js";

class FakeWorker implements DurableCommandDispatcher {
  readonly deliveries: DurableDispatchCommand[] = [];
  readonly effects = new Set<string>();
  effectApplications = 0;

  async dispatch(command: DurableDispatchCommand): Promise<void> {
    this.deliveries.push(command);
    if (!this.effects.has(command.idempotencyKey)) {
      this.effects.add(command.idempotencyKey);
      this.effectApplications += 1;
    }
  }
}

class ManualScheduler implements DurableSupervisorScheduler {
  callback: (() => void) | undefined;
  cancelled = false;
  every(_intervalMs: number, callback: () => void): { cancel(): void } {
    this.callback = callback;
    return { cancel: () => { this.cancelled = true; } };
  }
}

describe("durable supervisor SQLite vertical slice", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function databasePath(): string {
    const dir = mkdtempSync(join(tmpdir(), "naia-supervisor-"));
    dirs.push(dir);
    return join(dir, "supervisor.sqlite");
  }

  it("replays the same outbox command after process reopen and the worker applies one idempotent effect", async () => {
    const path = databasePath();
    const worker = new FakeWorker();
    let now = 1_000;
    const first = new SqliteDurableSupervisorStore(path, { leaseMs: 100, baseRetryMs: 20, now: () => now });
    first.startRun({ runId: "run-restart", task: "implement issue" });

    const claimed = first.claimCommand();
    expect(claimed?.kind).toBe("execute");
    await worker.dispatch(claimed!); // external accept happened, DB ack did not: simulated crash window
    first.close();

    now = 1_001;
    const restarted = new SqliteDurableSupervisorStore(path, { leaseMs: 100, baseRetryMs: 20, now: () => now });
    const supervisor = new DurableSupervisor(restarted, worker);
    await supervisor.recover();

    const snapshot = restarted.snapshot("run-restart");
    expect(worker.deliveries).toHaveLength(2);
    expect(worker.effects.size).toBe(1);
    expect(worker.effectApplications).toBe(1);
    expect(snapshot.outbox[0]?.state).toBe("acked");
    expect(snapshot.attempts[0]?.state).toBe("running");
    expect(snapshot.attempts[0]?.leaseToken).toBe(claimed?.payload.leaseToken);
    expect(snapshot.eventTypes).toContain("dispatch_recovered");
    restarted.close();
  });

  it("rejects every stale worker event, times out to exponential backoff, then dispatches one retry", async () => {
    const path = databasePath();
    const worker = new FakeWorker();
    let now = 2_000;
    const store = new SqliteDurableSupervisorStore(path, { leaseMs: 100, baseRetryMs: 20, now: () => now });
    const supervisor = new DurableSupervisor(store, worker);
    supervisor.startRun({ runId: "run-timeout", task: "test issue" });
    await supervisor.pump();
    const running = store.snapshot("run-timeout").attempts[0]!;

    const stale = {
      runId: "run-timeout", attemptId: running.attemptId, executionId: running.executionId,
      leaseToken: running.leaseToken!,
    };
    now = 2_100;
    expect(supervisor.heartbeat(stale)).toBe(false);
    expect(supervisor.complete({ ...stale, ok: true })).toBe(false);

    await supervisor.pump();
    let snapshot = store.snapshot("run-timeout");
    expect(snapshot.attempts.map((attempt) => attempt.state)).toEqual(["timed_out", "queued"]);
    expect(snapshot.attempts[1]?.nextRetryAt).toBe(2_120);
    expect(worker.deliveries).toHaveLength(1);
    now = 2_119;
    await supervisor.pump();
    expect(worker.deliveries).toHaveLength(1);
    now = 2_120;
    await supervisor.pump();
    snapshot = store.snapshot("run-timeout");
    expect(worker.deliveries).toHaveLength(2);
    expect(snapshot.attempts[1]?.state).toBe("running");
    store.close();
  });

  it("persists every missed ten-minute report boundary across process reopen", async () => {
    const path = databasePath();
    const worker = new FakeWorker();
    let now = 0;
    const first = new SqliteDurableSupervisorStore(path, { reportIntervalMs: 600_000, now: () => now });
    const firstSupervisor = new DurableSupervisor(first, worker);
    firstSupervisor.startRun({ runId: "run-report", task: "long issue" });
    await firstSupervisor.pump();
    first.close();

    now = 1_800_000;
    const restarted = new SqliteDurableSupervisorStore(path, { reportIntervalMs: 600_000, now: () => now });
    const supervisor = new DurableSupervisor(restarted, worker);
    await supervisor.recover();
    await supervisor.pump();

    const reports = worker.deliveries.filter((command) => command.kind === "progress_report");
    expect(reports.map((command) => command.payload.dueAt)).toEqual([600_000, 1_200_000, 1_800_000]);
    expect(restarted.snapshot("run-report").nextReportAt).toBe(2_400_000);
    restarted.close();
  });

  it("production composition starts with recovery and owns a cancellable periodic pump", async () => {
    const path = databasePath();
    let now = 5_000;
    const interrupted = new SqliteDurableSupervisorStore(path, { now: () => now });
    interrupted.startRun({ runId: "run-composed", task: "resume composed runtime" });
    const command = interrupted.claimCommand();
    expect(command?.kind).toBe("execute");
    interrupted.close();

    now = 5_001;
    const worker = new FakeWorker();
    const scheduler = new ManualScheduler();
    const composed = wireDurableSupervisorRuntime({
      databasePath: path, dispatcher: worker, scheduler, now: () => now, pumpIntervalMs: 10,
    });
    await composed.runtime.start();
    expect(worker.effectApplications).toBe(1);
    expect(composed.store.snapshot("run-composed").outbox[0]?.state).toBe("acked");
    expect(scheduler.callback).toBeTypeOf("function");
    composed.close();
    expect(scheduler.cancelled).toBe(true);
  });
});
