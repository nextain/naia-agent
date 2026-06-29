// adapters/subagent-pi — SubAgentPort 의 **pi 코딩 에이전트** 구현 (구 adapter-pi/pi-run-adapter.ts 이식, 단계 2b).
//
// `pi -p "<prompt>" --mode json --no-session` 를 sub-agent 로 spawn → pi NDJSON 이벤트 → SubAgentEvent.
// 세션 머신(스트림·cancel·가드)은 공유 subprocess-session 에. 여기엔 pi 고유의 (1) bin 해석 (2) args (3) lineToEvent 만.
// bin 미해결/ENOENT = 정직한 session_end{ok:false}(throw 금지, AC6). spawnFn 주입 seam(테스트 fake child).
//
// 구판(SubAgentAdapter)과의 차이(2b, SubAgentPort 인터페이스 맞춤):
//   - 구 session_start/turn_start/interrupt/status/pause/resume/inject → 2a semantic 이벤트만(planning/tool_use_*/text_delta/session_end).
//   - 구 redactString(@nextain/agent-observability) 제거 — 2a 비범위(시크릿 리댁션은 후속).
//   - 구 SpawnContext(signal/health/capabilities) 제거 — 취소는 cancel() 단일 경로. 구 Promise<Session> → 동기 반환(포트 계약).
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";
import {
  DEFAULT_HARD_KILL_DEADLINE_MS, defaultSpawn, spawnSubprocessSession, endedSession,
  type SpawnFn, type ResolvedBin, pickSpawnableBin, resolveSpawnableBin,
} from "./subprocess-session.js";

export type { SpawnFn, ResolvedBin };

export interface SubAgentPiOptions {
  /** --provider 로 전달(옵셔널). */
  readonly provider?: string;
  /** --model 로 전달(옵셔널). TaskSpec.model 보다 우선(어댑터 고정 모델). */
  readonly model?: string;
  /** hard-kill 유예(ms) override. 기본 500. 테스트가 단축. */
  readonly hardKillDeadlineMs?: number;
  /** bin 해석 주입(테스트/override). 미주입 = resolvePiBin(env→node_modules→PATH→npx). */
  readonly resolveBin?: () => ResolvedBin;
  /** spawn 주입(테스트 fake child). 미주입 = node:child_process.spawn. */
  readonly spawnFn?: SpawnFn;
}

// ── bin resolution (구 adapter-pi/resolve-bin.ts 이식) ────────────────────────
//   1. PI_BIN env(명시; 절대경로 검증) → 2. workspace node_modules/.bin/pi → 3. PATH(where/which) → 4. npx fallback.

function validatePiBin(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.includes("\0")) throw new Error(`PI_BIN contains null byte — refusing to spawn (injection guard)`);
  if (!isAbsolute(trimmed)) {
    throw new Error(`PI_BIN must be an absolute path (got: ${trimmed.slice(0, 60)}) — set full path e.g. /usr/local/bin/pi`);
  }
  return trimmed;
}

/** workspace-local node_modules 에서 pi 탐색(pnpm hoisting 대응). */
function findPiInNodeModules(): string | null {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(thisDir, "../../../node_modules/.bin/pi"),
    resolve(thisDir, "../../../../node_modules/.bin/pi"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** 크로스플랫폼 PATH 조회(where/which). 없으면 null. */
function findPiInPath(): string | null {
  const cmd = process.platform === "win32" ? `where pi` : `which pi`;
  try {
    const result = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return pickSpawnableBin(result.split(/\r?\n/));
  } catch {
    return null;
  }
}

/** pi 바이너리 해석(env → node_modules → PATH → npx fallback). PI_BIN 부적합 시 throw(spawn 이 honest end 로 흡수). */
export function resolvePiBin(): ResolvedBin {
  const validated = validatePiBin(process.env["PI_BIN"]);
  if (validated) return { command: validated, prefixArgs: [] };
  const inNodeModules = findPiInNodeModules();
  if (inNodeModules) return { command: inNodeModules, prefixArgs: [] };
  const inPath = findPiInPath();
  if (inPath) return resolveSpawnableBin(inPath);
  return { command: "npx", prefixArgs: ["--yes", "@earendil-works/pi-coding-agent"] }; // 미설치 시 첫 사용에 설치.
}

// ── pi NDJSON 파싱 (구 adapter-pi/event-parser.ts 의 필요 부분만) ─────────────

interface RawPiEvent {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  toolName?: string;
  isError?: boolean;
  [key: string]: unknown;
}

/** pi message content 블록에서 text 추출(구 extractMessageText). */
function extractMessageText(message: RawPiEvent["message"]): string {
  if (!message || !Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
  }
  return parts.join("");
}

/** 단일 NDJSON 줄 → SubAgentEvent 0~1개. malformed/빈줄/무관 type = null(드롭, no crash). */
export function piLineToEvent(line: string): SubAgentEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: RawPiEvent;
  try {
    raw = JSON.parse(trimmed) as RawPiEvent;
  } catch {
    return null; // malformed JSON 관용(crash 금지)
  }
  if (typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "session_start":
    case "agent_start":
      return { kind: "planning" }; // 계획/진행 표지(2a 별 kind 없음 → planning).
    case "message_end": {
      const text = extractMessageText(raw.message);
      return text.length > 0 ? { kind: "text_delta", text } : null;
    }
    case "tool_call": {
      const tool = typeof raw.toolName === "string" ? raw.toolName : "unknown";
      return { kind: "tool_use_start", tool };
    }
    case "tool_result": {
      const tool = typeof raw.toolName === "string" ? raw.toolName : "unknown";
      return { kind: "tool_use_end", tool, ok: raw.isError !== true }; // 구 toolUseId/elapsedMs 는 2a 비범위 드롭.
    }
    default:
      return null; // turn_start/turn_end/agent_end/message_start/compaction_* 등 = 2a 대응 kind 없음 → 드롭.
  }
}

/** SubAgentPort 의 pi 구현. pi CLI 1회 실행을 sub-agent 세션으로 spawn. */
export function makePiSubAgent(opts: SubAgentPiOptions = {}): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? DEFAULT_HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const resolveBin = opts.resolveBin ?? resolvePiBin;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      // bin 해석(PI_BIN 부적합 등) 실패는 throw 가 아니라 정직한 session_end{ok:false}(AC6).
      let bin: ResolvedBin;
      try {
        bin = resolveBin();
      } catch (e) {
        return endedSession(`pi unavailable: ${(e as Error).message}`);
      }
      const model = opts.model ?? task.model;
      const args: string[] = ["-p", task.prompt, "--mode", "json", "--no-session"];
      if (opts.provider) args.push("--provider", opts.provider);
      if (model) args.push("--model", model);
      return spawnSubprocessSession({
        spawnFn, bin, args, cwd: task.workdir, hardKillMs, lineToEvent: piLineToEvent, label: "pi",
      });
    },
  };
}
