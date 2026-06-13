// cron skill 테스트 — agent-local(parseSchedule 순수 + action + injected store mock). 외부 스케줄러 불요.
import { describe, it, expect } from "vitest";
import { makeCronExecutor, parseSchedule, type CronDeps, type CronJob } from "../main/adapters/cron-skills.js";
import type { ToolCall } from "../main/domain/chat.js";

const call = (args: Record<string, unknown>): ToolCall => ({ id: "1", name: "cron", args });

function mk(jobs: CronJob[] = []): { deps: CronDeps; scheduled: Array<{ schedule: unknown; prompt: string }>; cancelled: string[] } {
  const scheduled: Array<{ schedule: unknown; prompt: string }> = [];
  const cancelled: string[] = [];
  const deps: CronDeps = {
    store: {
      schedule: async (schedule, prompt) => { scheduled.push({ schedule, prompt }); return "job-1"; },
      list: async () => jobs,
      cancel: async (id) => { cancelled.push(id); return jobs.some((j) => j.id === id); },
    },
  };
  return { deps, scheduled, cancelled };
}

describe("parseSchedule (순수)", () => {
  it("at/every/cron 파싱 + 검증", () => {
    expect(parseSchedule("at", "2026-01-01")).toEqual({ type: "at", date: "2026-01-01" });
    expect(parseSchedule("every", "5000")).toEqual({ type: "every", intervalMs: 5000 });
    expect(parseSchedule("cron", "0 9 * * *")).toEqual({ type: "cron", expression: "0 9 * * *" });
    expect(parseSchedule("every", "0")).toBeNull(); // 비양수
    expect(parseSchedule("every", "abc")).toBeNull();
    expect(parseSchedule("sms", "x")).toBeNull(); // unknown type
    expect(parseSchedule("at", "")).toBeNull();
  });
});

describe("cron skill", () => {
  it("tier=ask(예약=환경변경 승인)", () => {
    expect(makeCronExecutor().specs().find((s) => s.name === "cron")?.tier).toBe("ask");
  });
  it("schedule → store.schedule + jobId", async () => {
    const { deps, scheduled } = mk();
    const r = await makeCronExecutor(deps).execute(call({ action: "schedule", scheduleType: "every", scheduleValue: "1000", prompt: "ping" }), {});
    expect(r.output).toMatch(/job-1/);
    expect(scheduled).toEqual([{ schedule: { type: "every", intervalMs: 1000 }, prompt: "ping" }]);
  });
  it("list → 작업 목록 / 빈 경우", async () => {
    expect((await makeCronExecutor(mk().deps).execute(call({ action: "list" }), {})).output).toBe("예약 없음");
    const r = await makeCronExecutor(mk([{ id: "j1", schedule: { type: "at", date: "d" }, prompt: "p" }]).deps).execute(call({ action: "list" }), {});
    expect(r.output).toMatch(/j1.*at.*p/);
  });
  it("cancel → 존재/부재 정직", async () => {
    const { deps } = mk([{ id: "j1", schedule: { type: "at", date: "d" }, prompt: "p" }]);
    expect((await makeCronExecutor(deps).execute(call({ action: "cancel", id: "j1" }), {})).isError).toBeUndefined();
    expect((await makeCronExecutor(deps).execute(call({ action: "cancel", id: "nope" }), {})).isError).toBe(true);
  });
  it("store 미주입 → unsupported / 잘못 schedule → isError", async () => {
    expect((await makeCronExecutor().execute(call({ action: "list" }), {})).isError).toBe(true);
    const { deps } = mk();
    expect((await makeCronExecutor(deps).execute(call({ action: "schedule", scheduleType: "bad", scheduleValue: "x", prompt: "p" }), {})).isError).toBe(true);
    expect((await makeCronExecutor(deps).execute(call({ action: "schedule", scheduleType: "at", scheduleValue: "d" }), {})).isError).toBe(true); // prompt 없음
  });
});
