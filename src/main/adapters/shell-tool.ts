// adapters/shell-tool — UC-FS-TOOLS: 에이전트 직접 셸도구(shell_exec) ToolExecutorPort. tier "shell"(상위 승인).
//
// ★ 보안 정직성(중요): shell_exec 은 **argv 스펙**(command:string[]) 으로 셸 문자열 보간을 0 으로 막아 injection
//   은 차단하지만, **path-sandbox 가 아니다**. cwd 검증/realpath 재검증은 *작업 디렉터리* 만 allow-root 로 제한할 뿐,
//   **명령 자체는 워크스페이스-사용자 권한의 임의 코드 실행(파일시스템 전체 접근 가능)** 이다. powershell/node/python
//   등이 절대경로로 `.ssh`/`.env`/`data-private`/홈 디렉터리에 자유롭게 접근할 수 있다(cwd 와 무관). 이건 shell_exec
//   의 본질이며 path 격리로 막을 수 없다.
//   → 실효 통제 = **opt-in(기본 off, NAIA_SHELL_TOOL=1) + tier 승인 게이트 + 신뢰 컨텍스트에서만 활성화** 뿐.
//     path 격리(allow-root/denylist)는 fs-tools(read/list/write)에만 적용되며 shell_exec 명령에는 적용되지 않는다.
//   주입 exec 실행기는 **shell 없이 spawn**(subprocess-session 의 injection-safe 헬퍼 재사용 — pickSpawnableBin/
//   resolveSpawnableBin/resolveFallbackCommand). cwd 는 domain validatePath + realpath 재검증으로 allow-root 안만 허용
//   (cwd 자체의 symlink/junction 탈출 차단 — 단 위 한계대로 *명령의 파일 접근* 은 여전히 제한 못 함).
//
// no-throw 규약: 실패/거부/비-0 exit = { output, isError:true }(throw 금지). abort 시에만 reject. opt-in(NAIA_SHELL_TOOL=1).
//
// ⚠️ exec 실행기(child_process 메커니즘)는 compose-agent-deps 가 주입(코어 순수). 이 어댑터는 argv·정책만 소유.
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { validatePath, type SandboxPolicy } from "../domain/fs-sandbox.js";
import { isAborted } from "./signal-util.js";

/** argv 실행기 결과 — stdout/stderr/exit. shell 없이 spawn(주입). */
export interface ShellExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
}
/**
 * argv(command[0]=bin, 나머지=인자)를 **shell 없이** 실행하는 주입 실행기. cwd 는 검증된 절대경로.
 * 실패(spawn throw·timeout)는 result 로(throw 지양) — 어댑터가 no-throw 로 감쌈. abort 시 child kill 후 reject.
 */
export type ShellExecFn = (
  argv: readonly string[],
  opts: { cwd: string; signal?: AbortSignal; timeoutMs: number; maxBytes: number },
) => Promise<ShellExecResult>;

export interface ShellToolDeps {
  readonly exec: ShellExecFn;
  /** allow-root(절대 adkPath). cwd 가 이 하위여야 함. */
  readonly allowRoots: readonly string[];
  /**
   * 실제 경로 resolve(symlink/junction 해소) — **cwd realpath 재검증의 핵심**. fs-tools 의 resolveSafe 와 동형:
   * cwd 가 문자열상 allow-root 안이어도 링크/정션이 밖을 가리키면 거부(cwd 탈출 차단). 부재/실패 시 throw → 거부.
   */
  readonly realpath: (p: string) => string;
  /** per-call deadline(미주입=120s). */
  readonly timeoutMs?: number;
  /** 출력 상한(미주입=64KB). */
  readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_ARGV = 256;        // argv 항목 수 상한.
const MAX_ARG_LEN = 32_768;  // 항목당 길이 상한.

const ok = (output: string): { output: string } => ({ output });
const err = (output: string): { output: string; isError: boolean } => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "shell error"; }
}

const TOOLS: readonly ToolSpec[] = [
  {
    name: "shell_exec",
    description: "⚠️ 임의 명령 실행(파일시스템 전체 접근 가능, 승인 필요). 워크스페이스 밖/민감파일도 명령으로 접근될 수 있음 — 신뢰 시에만. 인자: {command: string[] (argv — [0]=실행파일, 나머지=인자; 셸 문자열 아님), cwd?: 워크스페이스 내 작업 디렉터리}. cwd 만 워크스페이스로 제한될 뿐 명령 자체의 파일 접근은 제한되지 않음. 셸 보간/파이프/리다이렉트 없음(argv 직접 spawn).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "array", items: { type: "string" }, description: "argv (셸 문자열 아님)" },
        cwd: { type: "string", description: "워크스페이스 내 작업 디렉터리(생략=allow-root)" },
      },
      required: ["command"],
    },
    tier: "shell", // 상위 승인 — chat-turn-handler 의 기존 ApprovalPort 게이트가 자동 발화.
  },
];

/**
 * UC-FS-TOOLS shell_exec ToolExecutorPort. argv 스펙(보간 없음) + cwd allow-root 검증(+ realpath 재검증) + 주입 exec.
 *
 * ⚠️ 정직: cwd 만 sandbox 다 — **명령 자체는 파일시스템 전체 접근 가능**(path 격리 아님, 헤더 주석 참조).
 *   실효 통제 = opt-in(기본 off) + tier 승인 + 신뢰 컨텍스트뿐.
 * @future per-request capability — opt-in 은 env-var 게이트(GLM: 약함). injection 은 argv 로 차단하나 path 격리는 cwd 한정.
 */
export function makeShellTool(deps: ShellToolDeps): ToolExecutorPort {
  const { exec, allowRoots, realpath } = deps;
  const policy: SandboxPolicy = { allowRoots };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  // 기본 cwd = 첫 allow-root(정규화). cwd 미지정 시 사용.
  const defaultCwd = allowRoots.length > 0 ? allowRoots[0] : "";

  /**
   * cwd 를 검증된 *실제* 절대경로로 해소(fs-tools.resolveSafe 와 동형). validatePath → realpath → validatePath 재검증.
   * cwd 가 문자열상 allow-root 안이어도 링크/정션이 밖을 가리키면 거부(cwd 탈출 차단). 기본 cwd(allow-root)도 재검증
   * (allow-root 자체가 링크일 가능성). 반환: { ok, real } | { ok:false, reason }(no-throw 상위에서 err).
   */
  const resolveCwd = (raw: string): { ok: true; real: string } | { ok: false; reason: string } => {
    const v1 = validatePath(raw, policy);
    if (!v1.ok) return { ok: false, reason: v1.reason };
    let real: string;
    try { real = realpath(v1.normalized); } catch (e) { return { ok: false, reason: `cwd realpath failed: ${e instanceof Error ? e.message : String(e)}` }; }
    const v2 = validatePath(real, policy); // realpath 재검증 — 링크가 allow-root 밖이면 거부
    if (!v2.ok) return { ok: false, reason: `cwd realpath rejected: ${v2.reason}` };
    return { ok: true, real: v2.normalized };
  };

  return {
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined;
      let aborted = false;
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard(); // (진입 가드)
        if (call.name !== "shell_exec") return err(`unknown tool: ${call.name}`);
        if (!isObj(call.args)) return err("args must be object");
        const a = call.args;

        // argv 검증 — 반드시 string[](셸 문자열 거부). 항목 수/길이/널바이트/비어있음 가드.
        const cmd = a.command;
        if (!Array.isArray(cmd)) return err("command must be an array of strings (argv, not a shell string)");
        if (cmd.length === 0) return err("command must be non-empty argv");
        if (cmd.length > MAX_ARGV) return err(`command argv too long (>${MAX_ARGV})`);
        for (const part of cmd) {
          if (typeof part !== "string") return err("command argv items must be strings");
          if (part.includes("\0")) return err("command contains null byte");
          if (part.length > MAX_ARG_LEN) return err("command argv item too long");
        }
        const argv = cmd as string[];
        if (argv[0].trim() === "") return err("command[0] (executable) must be non-empty");

        // cwd 검증 — 지정 시 allow-root 컨테인먼트(domain) + realpath 재검증. 미지정=기본 allow-root(도 realpath 재검증).
        //   ⚠️ cwd 만 sandbox 다 — 명령 자체의 파일 접근은 cwd 와 무관(헤더 주석: shell_exec ≠ path-sandbox).
        const rawCwd = a.cwd === undefined ? defaultCwd : a.cwd;
        if (typeof rawCwd !== "string") return err("cwd must be string");
        if (!rawCwd) return err("no allow-root configured for cwd");
        const cwdRes = resolveCwd(rawCwd);
        if (!cwdRes.ok) return err(`cwd denied: ${cwdRes.reason}`);
        const cwd = cwdRes.real;

        abortGuard(); // (exec 전 가드)
        // 주입 exec — shell 없이 argv spawn(injection-safe). abort/timeout/maxBytes bound.
        const r = await exec(argv, { cwd, ...(signal ? { signal } : {}), timeoutMs, maxBytes });
        abortGuard(); // (exec 후 가드)
        if (!r || typeof r.stdout !== "string" || typeof r.stderr !== "string") return err("malformed exec result");

        const out = [
          r.stdout ? r.stdout : "",
          r.stderr ? `\n[stderr]\n${r.stderr}` : "",
          `\n[exit ${r.code === null ? "signal/null" : r.code}]`,
        ].join("").trim();
        const isError = r.code !== 0; // 비-0 exit = isError(LLM 복구), 출력은 그대로.
        return isError ? err(out || `[exit ${r.code}]`) : ok(out || "(출력 없음)");
      } catch (e) {
        if (aborted || isAborted(signal)) throw e instanceof Error ? e : new Error("aborted"); // abort → reject
        return err(safeMsg(e)); // 비-abort = isError(no-throw)
      }
    },
  };
}
