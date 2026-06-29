// adapters/subagent-gemini — SubAgentPort 의 **gemini** 구현 (UC-014 / SPEC-010 확장, 2026-06-29).
//
// `gemini -p "<prompt>" --output-format stream-json [...]` 를 sub-agent 로 spawn → gemini JSONL → SubAgentEvent.
// 세션 머신(스트림·cancel·가드)은 공유 subprocess-session 에. 여기엔 gemini 고유의 (1) bin 해석 (2) args
// (3) line parser 만. bin 미해결/ENOENT = 정직한 session_end{ok:false}(throw 금지, AC6). spawnFn 주입 seam.
//
// ⚠️ **RUNTIME-UNVERIFIED (2026-06-29)**: dev 머신 gemini auth = IneligibleTierError(Gemini Code Assist for
//    individuals deprecated → Antigravity 마이그레이션 권고) 로 live 캡처 불가. 본 파서는 **문서 기반**
//    (bundle/docs/cli/headless.md @0.47.0: init/message/tool_use/tool_result/error/result) + bundle literal
//    (`tool_call_response` 변종 수용). **방어적 파싱**(무관/변형 type 드롭, crash 없음)으로 실출력 도착 시
//    자가수정. auth 복원(또는 별도 tier) 시 runtime smoke 필요 — 본 파일 헤더·roster note·progress 에 명시.
//
// terminal session_end 는 process close(code) 가 단일 발생(타 어댑터 동일). 본 lineToEvent 는 terminal 반환 X.
import { execSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";
import {
  DEFAULT_HARD_KILL_DEADLINE_MS, defaultSpawn, spawnSubprocessSession, endedSession,
  type SpawnFn, type ResolvedBin, pickSpawnableBin, resolveSpawnableBin, resolveFallbackCommand,
} from "./subprocess-session.js";

export type { SpawnFn, ResolvedBin };

export interface SubAgentGeminiOptions {
  /** -m/--model 로 전달(옵셔널). TaskSpec.model 보다 우선. */
  readonly model?: string;
  /** -y/--yolo(자동 승인, 기본 false). sub-agent 자율 구동 시 true 권장. */
  readonly yolo?: boolean;
  /** --skip-trust(신뢰 불가 workdir 통과, 기본 true — sub-agent 가 임의 workdir 동작). */
  readonly skipTrust?: boolean;
  readonly hardKillDeadlineMs?: number;
  readonly resolveBin?: () => ResolvedBin;
  readonly spawnFn?: SpawnFn;
}

// ── bin resolution (동형 패턴: env 절대경로 검증 → PATH → npx fallback) ────────

function validateGeminiBin(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.includes("\0")) throw new Error(`GEMINI_BIN contains null byte — refusing to spawn (injection guard)`);
  if (!isAbsolute(trimmed)) {
    throw new Error(`GEMINI_BIN must be an absolute path (got: ${trimmed.slice(0, 60)}) — set full path e.g. /usr/local/bin/gemini`);
  }
  return trimmed;
}

function findGeminiInPath(): string | null {
  const cmd = process.platform === "win32" ? `where gemini` : `which gemini`;
  try {
    const result = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return pickSpawnableBin(result.split(/\r?\n/));
  } catch {
    return null;
  }
}

export function resolveGeminiBin(): ResolvedBin {
  const validated = validateGeminiBin(process.env["GEMINI_BIN"]);
  if (validated) return { command: validated, prefixArgs: [] };
  const inPath = findGeminiInPath();
  if (inPath) return resolveSpawnableBin(inPath);
  const fb = resolveFallbackCommand("npx");
  return { command: fb.command, prefixArgs: [...fb.prefixArgs, "--yes", "@google/gemini-cli"] };
}

// ── gemini stream-json 파싱 (방어적 — runtime-unverified, 변형 수용) ────────────
// 문서(bundle/docs/cli/headless.md @0.47.0) 이벤트: init/message/tool_use/tool_result/error/result.
// bundle literal `tool_call_response` 도 tool_result 변종으로 수용. 필드명은 변형 가능성에 대비해 복수 후보.

interface RawGeminiEvent { type?: string; [k: string]: unknown }

/** 문자열 필드를 복수 키 후보에서 안전 추출(runtime-unverified 변형 대비). */
function pickStr(obj: Record<string, unknown> | undefined, keys: readonly string[]): string {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/** 단일 JSONL 줄 → SubAgentEvent 0~1개. malformed/빈줄/무관 type = null(드롭, no crash). */
export function geminiLineToEvent(line: string): SubAgentEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: RawGeminiEvent;
  try {
    raw = JSON.parse(trimmed) as RawGeminiEvent;
  } catch {
    return null; // malformed JSON 관용.
  }
  if (typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "init":
      return { kind: "planning" };
    case "message": {
      // text 후보: text / content / messageText. assistant chunks 만 관심(user chunk 드롭 허용 — 구분 불명확).
      const text = pickStr(raw, ["text", "content", "messageText"]);
      return text.length > 0 ? { kind: "text_delta", text } : null;
    }
    case "tool_use": {
      const tool = pickStr(raw, ["tool_name", "toolName", "name", "tool"]) || "gemini-tool";
      return { kind: "tool_use_start", tool };
    }
    case "tool_result":
    case "tool_call_response": {
      const tool = pickStr(raw, ["tool_name", "toolName", "name", "tool"]) || "gemini-tool";
      const isErr = raw["is_error"] === true || raw["isError"] === true || raw["error"] !== undefined;
      return { kind: "tool_use_end", tool, ok: !isErr };
    }
    default:
      return null; // error(비치명)/result(terminal=close) 등 = 무시.
  }
}

/** SubAgentPort 의 gemini 구현. gemini CLI 1회 실행을 sub-agent 세션으로 spawn. */
export function makeGeminiSubAgent(opts: SubAgentGeminiOptions = {}): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? DEFAULT_HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const resolveBin = opts.resolveBin ?? resolveGeminiBin;
  const skipTrust = opts.skipTrust ?? true;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      let bin: ResolvedBin;
      try {
        bin = resolveBin();
      } catch (e) {
        return endedSession(`gemini unavailable: ${(e as Error).message}`);
      }
      const model = opts.model ?? task.model;
      // -p <prompt> --output-format stream-json [--skip-trust] [--yolo] [--model X]
      const args: string[] = ["-p", task.prompt, "--output-format", "stream-json"];
      if (skipTrust) args.push("--skip-trust");
      if (opts.yolo) args.push("--yolo");
      if (model) args.push("--model", model);
      return spawnSubprocessSession({
        spawnFn, bin, args, cwd: task.workdir, hardKillMs, lineToEvent: geminiLineToEvent, label: "gemini",
      });
    },
  };
}
