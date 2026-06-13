// adapters/agent-browser-skills — UC6(환경 조작-browser) ToolExecutorPort. agent-local skill 이식.
// old skills/built-in/agent-browser.ts(agent-browser CLI subprocess 래퍼) 패턴 이식.
// ⚠️ external = injected runCli(agent-browser CLI + 실 browser). 미주입=정직 unsupported.
// §E 동일 규약(github/UC8): no-throw 경계, abort 가드, arg 검증, timeout-bound. tier="ask"(환경 조작→UC13 승인).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

/** external CLI 실행(agent-browser <cmd> <args>). 미주입 시 browser 불가(정직). timeout=deadline. */
export type BrowserCliRun = (cmd: string, args: readonly string[], opts: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
export interface BrowserDeps { runCli?: BrowserCliRun; defaultTimeoutMs?: number; }

const DEFAULT_TIMEOUT_MS = 30_000;
// old agent-browser CLI 하위명령(open/snapshot/click/fill/press/screenshot/pdf/...) — 화이트리스트(임의 cmd 주입 방지).
const ALLOWED_CMDS = new Set(["open", "snapshot", "click", "dblclick", "fill", "type", "press", "hover", "check", "uncheck", "select", "scroll", "upload", "get", "screenshot", "pdf", "close"]);

const TOOLS: readonly ToolSpec[] = [
  {
    name: "agent_browser",
    description: "브라우저 조작(agent-browser). cmd: open/snapshot/click/fill/press/screenshot/... (사용자가 웹페이지 탐색·클릭·입력을 원할 때). 인자: {cmd, args?:string[], timeoutMs?}",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: `하위명령(${[...ALLOWED_CMDS].slice(0, 8).join("/")}...)` },
        args: { type: "array", items: { type: "string" }, description: "cmd 인자(예: open <url>, click <selector>)" },
        timeoutMs: { type: "number", description: "타임아웃(기본 30000)" },
      },
      required: ["cmd"],
    },
    tier: "ask", // 환경 조작 → UC13 승인
  },
];

const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "tool error"; }
}

export function makeAgentBrowserExecutor(deps: BrowserDeps = {}): ToolExecutorPort {
  const timeoutDefault = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined;
      let aborted = false;
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard();
        if (!deps.runCli) return err("browser unavailable (agent-browser CLI 미주입 — external)");
        if (!isObj(call.args)) return err("args must be object");
        const a = call.args;
        const cmd = a.cmd;
        if (typeof cmd !== "string" || !ALLOWED_CMDS.has(cmd)) return err(`cmd invalid (allowed: ${[...ALLOWED_CMDS].join("/")})`); // 화이트리스트(임의 cmd 차단)
        // args = string[] 만(임의 객체/인젝션 방지)
        const rawArgs = a.args;
        const cliArgs: string[] = Array.isArray(rawArgs) ? rawArgs.filter((x): x is string => typeof x === "string") : [];
        if (Array.isArray(rawArgs) && cliArgs.length !== rawArgs.length) return err("args must be string[]");
        const timeoutMs = typeof a.timeoutMs === "number" && Number.isFinite(a.timeoutMs) && a.timeoutMs > 0 ? a.timeoutMs : timeoutDefault;

        const r = await deps.runCli(cmd, cliArgs, { timeoutMs, ...(signal ? { signal } : {}) });
        abortGuard(); // await 후 가드
        return r.ok ? ok(r.stdout) : err(r.stderr.trim() || `agent-browser ${cmd} failed`);
      } catch (e) {
        if (aborted || isAborted(signal)) throw new Error("aborted"); // abort만 reject(no-throw 경계)
        return err(`agent_browser 실패: ${safeMsg(e)}`);
      }
    },
  };
}
