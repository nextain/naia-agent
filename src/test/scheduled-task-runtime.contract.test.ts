import { describe, expect, it } from "vitest";
import { ScheduledTaskRuntime, makeMemoryScheduledTaskStore, nextCronAt, validCron } from "../main/adapters/scheduled-task-runtime.js";

describe("ScheduledTaskRuntime", () => {
  it("stores a provider-neutral periodic report and delivers each occurrence once", async () => {
    let now = 1_000_000; const delivered: string[] = [];
    const runtime = new ScheduledTaskRuntime({ store: makeMemoryScheduledTaskStore(), ids: () => "report_1", now: () => now, runner: { run: async () => "Codex report" }, delivery: { send: async ({ content }) => { delivered.push(content); return { messageId: "1" }; } } });
    await runtime.create({ prompt: "report", destinationId: "owner", schedule: { kind: "every", intervalMs: 60_000 } });
    now += 60_000; await runtime.runDue(); await runtime.runDue();
    expect(delivered).toEqual(["Codex report"]);
    expect((await runtime.list())[0]?.occurrence).toBe(1);
  });
  it("persists an unknown result instead of replaying ambiguous delivery after restart", async () => {
    let now = 1_000_000; const store = makeMemoryScheduledTaskStore();
    const first = new ScheduledTaskRuntime({ store, ids: () => "report_1", now: () => now, runner: { run: async () => "report" }, delivery: { send: async () => { throw new Error("network"); } } });
    await first.create({ prompt: "report", destinationId: "owner", schedule: { kind: "every", intervalMs: 60_000 } });
    now += 60_000; await first.runDue();
    const second = new ScheduledTaskRuntime({ store, ids: () => "report_2", now: () => now + 60_000, runner: { run: async () => "unexpected" }, delivery: { send: async () => ({ messageId: "2" }) } });
    await second.runDue();
    expect((await second.list())[0]?.active).toBe(false);
  });
  it("validates bounded five-field timezone cron", () => {
    expect(validCron("0 9 * * 1,2,3,4,5")).toBe(true);
    expect(validCron("0 9 * * * *")).toBe(false);
    expect(nextCronAt("0 9 * * *", "Asia/Seoul", Date.parse("2026-01-01T00:00:00Z"))).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
  });
});
