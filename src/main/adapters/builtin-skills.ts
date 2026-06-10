// adapters/builtin-skills — UC5 실 스킬 ToolExecutorPort (계약 §E). S20 time / S21 weather / S22 memo.
// 통합 no-throw 경계(arg/dep/format 단일 try, abort만 reject, fail-safe msg), abort 3가드(진입/await후/mutate전).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";

export interface MemoStore {
  save(title: string, content: string): void;
  list(): readonly string[];
  get(title: string): string | null;
}
export function makeInMemoryMemoStore(): MemoStore {
  const m = new Map<string, string>();
  return { save: (t, c) => { m.set(t, c); }, list: () => [...m.keys()], get: (t) => (m.has(t) ? m.get(t)! : null) };
}

export interface SkillDeps {
  clock?: () => Date;
  fetchWeather?: (lat: number, lon: number, signal?: AbortSignal) => Promise<{ tempC: number; code: number }>;
  memo?: MemoStore; // 미주입 시 in-memory 기본(항상 가용, §E.1)
}

const TOOLS: readonly ToolSpec[] = [
  { name: "get_time", description: "현재 시각(ISO/UTC; timezone 주면 해당 지역). 인자: {timezone?}", parameters: { type: "object", properties: { timezone: { type: "string" } } } },
  { name: "get_weather", description: "위경도 현재 날씨. 인자: {latitude, longitude}", parameters: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" } }, required: ["latitude", "longitude"] } },
  { name: "memo_list", description: "저장된 메모 제목 목록.", parameters: { type: "object", properties: {} } },
  { name: "memo_get", description: "제목으로 메모 내용 조회. 인자: {title}", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  { name: "memo_save", description: "메모 저장(승인 필요). 인자: {title, content}", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] }, tier: "ask" },
];

const ok = (output: string): { output: string } => ({ output });
const err = (output: string): { output: string; isError: boolean } => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  // Error 든 plain {message} 든 string message 우선(getter throw 격리), 그 다음 String(e), 최종 고정.
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* message getter throw → 다음 단계 */ }
  try { return String(e); } catch { return "tool error"; }
}

/** §E ToolExecutorPort 구현. deps 주입(테스트성). memo 기본 in-memory. */
export function makeBuiltinSkillsExecutor(deps: SkillDeps = {}): ToolExecutorPort {
  const memo = deps.memo ?? makeInMemoryMemoStore();
  return {
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      const signal = opts.signal;
      if (signal?.aborted) throw new Error("aborted"); // (진입 가드) → reject
      try {
        if (!isObj(call.args)) return err("args must be object"); // §E.2 plain-object 계약(§C 가 이미 보장; 방어)
        const a = call.args;
        switch (call.name) {
          case "get_time": {
            if (!deps.clock) return err("get_time unavailable");
            let tz: string | undefined;
            if (a.timezone !== undefined) { if (typeof a.timezone !== "string") return err("timezone must be string"); tz = a.timezone; }
            const d = deps.clock();
            if (!(d instanceof Date) || Number.isNaN(d.getTime())) return err("invalid clock");
            if (tz === undefined) return ok(d.toISOString());
            const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", era: "short" }).formatToParts(d);
            const part = (t: string): string | undefined => parts.find((p) => p.type === t)?.value;
            if (part("era") !== "AD") return err("unsupported era (BCE/expanded year out of bound)");
            const y = Number(part("year"));
            if (!Number.isInteger(y) || y < 1 || y > 9999) return err("year out of range (1..9999 CE)");
            return ok(`${String(y).padStart(4, "0")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} (${tz})`);
          }
          case "get_weather": {
            if (!deps.fetchWeather) return err("get_weather unavailable");
            // args 는 객체 보장(진입 검사)
            const lat = a.latitude, lon = a.longitude;
            if (!Number.isFinite(lat) || (lat as number) < -90 || (lat as number) > 90) return err("latitude must be finite number in -90..90");
            if (!Number.isFinite(lon) || (lon as number) < -180 || (lon as number) > 180) return err("longitude must be finite number in -180..180");
            const w = await deps.fetchWeather(lat as number, lon as number, signal);
            if (signal?.aborted) throw new Error("aborted"); // (await 후 가드) → reject
            if (!w || !Number.isFinite(w.tempC) || !Number.isFinite(w.code)) return err("malformed weather response");
            return ok(`기온 ${w.tempC}°C, 코드 ${w.code}`);
          }
          case "memo_list": {
            const list = memo.list();
            if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) return err("malformed memo list");
            return ok(list.length ? list.join("\n") : "(없음)");
          }
          case "memo_get": {
            if (typeof a.title !== "string") return err("title must be string");
            const v = memo.get(a.title);
            if (v !== null && typeof v !== "string") return err("malformed memo get");
            return ok(v ?? "(없음)");
          }
          case "memo_save": {
            if (typeof a.title !== "string" || typeof a.content !== "string") return err("title/content must be string");
            if (signal?.aborted) throw new Error("aborted"); // (mutate 전 가드) → reject
            memo.save(a.title, a.content);
            return ok(`저장됨: ${a.title}`);
          }
          default:
            return err(`unknown tool: ${call.name}`);
        }
      } catch (e) {
        if (signal?.aborted) throw e instanceof Error ? e : new Error("aborted"); // abort → reject(루프가 cancelled)
        return err(safeMsg(e)); // 비-abort = isError(no-throw)
      }
    },
  };
}
