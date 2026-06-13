// adapters/cron-skills — 예약 작업 ToolExecutorPort(schedule/list/cancel). old cron.ts 패턴 이식.
// ⚠️ external = injected CronStorePort(영속 job store + 실 스케줄러). 미주입=정직 unsupported.
// 순수 도메인: parseSchedule(at/every/cron). §E 규약(no-throw/abort/arg검증). tier="ask"(예약=환경 변경 → UC13).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

export type Schedule =
  | { readonly type: "at"; readonly date: string }
  | { readonly type: "every"; readonly intervalMs: number }
  | { readonly type: "cron"; readonly expression: string };

export interface CronJob { readonly id: string; readonly schedule: Schedule; readonly prompt: string; }
/** external 영속 store + 스케줄러(주입). 미주입=예약 불가. */
export interface CronStorePort {
  schedule(schedule: Schedule, prompt: string): Promise<string>; // → jobId
  list(): Promise<readonly CronJob[]>;
  cancel(id: string): Promise<boolean>;
}
export interface CronDeps { store?: CronStorePort; }

/** 순수: scheduleType+value → Schedule | null(검증). old parseSchedule 충실. */
export function parseSchedule(scheduleType: unknown, scheduleValue: unknown): Schedule | null {
  if (typeof scheduleValue !== "string" || !scheduleValue.trim()) return null;
  switch (scheduleType) {
    case "at": return { type: "at", date: scheduleValue };
    case "every": {
      const ms = Number.parseInt(scheduleValue, 10);
      return Number.isFinite(ms) && ms > 0 ? { type: "every", intervalMs: ms } : null;
    }
    case "cron": return { type: "cron", expression: scheduleValue };
    default: return null;
  }
}

const ACTIONS = ["schedule", "list", "cancel"] as const;
const TOOLS: readonly ToolSpec[] = [
  {
    name: "cron",
    description: "예약 작업. schedule(scheduleType:at/every/cron, scheduleValue, prompt) / list / cancel(id). 사용자가 작업 예약/반복을 원할 때.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        scheduleType: { type: "string", enum: ["at", "every", "cron"] },
        scheduleValue: { type: "string", description: "at=ISO date / every=ms / cron=expr" },
        prompt: { type: "string", description: "예약 시 실행할 지시" },
        id: { type: "string", description: "cancel 대상 job id" },
      },
      required: ["action"],
    },
    tier: "ask", // 예약=환경 변경 → 승인
  },
];

const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter */ }
  try { return String(e); } catch { return "tool error"; }
}

export function makeCronExecutor(deps: CronDeps = {}): ToolExecutorPort {
  return {
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined;
      let aborted = false;
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard();
        if (!deps.store) return err("cron unavailable (store 미주입 — external)");
        if (!isObj(call.args)) return err("args must be object");
        const a = call.args;
        const action = a.action;
        if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) return err(`unknown action (allowed: ${ACTIONS.join("/")})`);

        if (action === "list") {
          const jobs = await deps.store.list();
          return ok(jobs.length ? jobs.map((j) => `${j.id}: ${j.schedule.type} — ${j.prompt}`).join("\n") : "예약 없음");
        }
        if (action === "cancel") {
          const id = a.id;
          if (typeof id !== "string" || !id) return err("id required for cancel");
          return (await deps.store.cancel(id)) ? ok(`취소: ${id}`) : err(`job 없음: ${id}`);
        }
        // schedule
        const schedule = parseSchedule(a.scheduleType, a.scheduleValue);
        if (!schedule) return err("scheduleType(at/every/cron)+scheduleValue 유효해야");
        const prompt = a.prompt;
        if (typeof prompt !== "string" || !prompt.trim()) return err("prompt required for schedule");
        const id = await deps.store.schedule(schedule, prompt);
        abortGuard();
        return ok(`예약됨: ${id} (${schedule.type})`);
      } catch (e) {
        if (aborted || isAborted(signal)) throw new Error("aborted");
        return err(`cron 실패: ${safeMsg(e)}`);
      }
    },
  };
}
