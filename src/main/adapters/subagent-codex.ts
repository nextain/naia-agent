// adapters/subagent-codex — SubAgentPort 의 **codex** 구현 (UC-014 / SPEC-010 확장, 2026-06-29).
//
// `codex exec "<prompt>" --json [...]` 를 sub-agent 로 spawn → codex JSONL → SubAgentEvent.
// 세션 머신(스트림·cancel·가드)은 공유 subprocess-session 에. 여기엔 codex 고유의 (1) bin 해석 (2) args
// (3) line parser 만. bin 미해결/ENOENT = 정직한 session_end{ok:false}(throw 금지, AC6). spawnFn 주입 seam.
//
// ⚠️ codex `exec` 는 `-a/--ask-for-approval`(TUI 용) 미지원 — exec 는 본래 non-interactive.
//    위임 실행은 사용자 전역 config가 경계를 넓히지 못하게 `--ignore-user-config` +
//    `--sandbox workspace-write` + approval_policy=never를 매번 명시한다. cwd는 host가
//    realpath로 ADK 아래임을 검증하므로 Codex OS sandbox의 쓰기 root도 그 범위 안으로 고정된다.
//
// codex JSONL 은 item.completed = **완료 snapshot** 만 내보냄(start/end 경계 없음). 그래서 도구 항목은
// tool_use_end{ok:true}(완료됨) 로 표현한다(시작 경계가 없는 codex 포맷의 정직한 단일 표현). terminal
// session_end 는 process close(code) 가 단일 발생(pi/opencode/claude-code 동일).
//
// RT-verified(2026-06-29): thread.started/turn.started/item.completed(agent_message/command_execution)/
// turn.completed 이벤트 shape + `exec --json -a never` 거부(`-a` 미지원) 실측.
import { execSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";
import {
  DEFAULT_HARD_KILL_DEADLINE_MS, defaultSpawn, spawnSubprocessSession, endedSession,
  type SpawnFn, type ResolvedBin, pickSpawnableBin, resolveSpawnableBin, resolveFallbackCommand,
} from "./subprocess-session.js";

export type { SpawnFn, ResolvedBin };

export interface SubAgentCodexOptions {
  /** -m/--model 로 전달(옵셔널). TaskSpec.model 보다 우선. */
  readonly model?: string;
  /** --skip-git-repo-check(기본 true — sub-agent 가 비-git workdir 도 동작하도록). */
  readonly skipGitRepoCheck?: boolean;
  readonly hardKillDeadlineMs?: number;
  readonly resolveBin?: () => ResolvedBin;
  readonly spawnFn?: SpawnFn;
}

// ── bin resolution (동형 패턴: env 절대경로 검증 → PATH → npx fallback) ────────

function validateCodexBin(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.includes("\0")) throw new Error(`CODEX_BIN contains null byte — refusing to spawn (injection guard)`);
  if (!isAbsolute(trimmed)) {
    throw new Error(`CODEX_BIN must be an absolute path (got: ${trimmed.slice(0, 60)}) — set full path e.g. /usr/local/bin/codex`);
  }
  return trimmed;
}

function findCodexInPath(): string | null {
  const cmd = process.platform === "win32" ? `where codex` : `which codex`;
  try {
    const result = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return pickSpawnableBin(result.split(/\r?\n/));
  } catch {
    return null;
  }
}

export function resolveCodexBin(): ResolvedBin {
  const validated = validateCodexBin(process.env["CODEX_BIN"]);
  if (validated) return { command: validated, prefixArgs: [] };
  const inPath = findCodexInPath();
  if (inPath) return resolveSpawnableBin(inPath);
  const fb = resolveFallbackCommand("npx");
  return { command: fb.command, prefixArgs: [...fb.prefixArgs, "--yes", "@openai/codex"] };
}

// ── codex JSONL 파싱 ─────────────────────────────────────────────────────────
// codex exec --json 이벤트(실측):
//   {"type":"thread.started","thread_id":..}    → planning(시작 신호)
//   {"type":"turn.started"}                     → 무시(thread.started 로 족함)
//   {"type":"item.completed","item":{"type":"agent_message","text":..}} → text_delta
//   {"type":"item.completed","item":{"type":"command_execution"|"file_change"|"file_edit"|...}}
//                                               → tool_use_end{ok:true}(완료 snapshot, 경계 없음)
//   {"type":"turn.completed","usage":{...}}     → 무시(terminal=close)
//   그 외(reasoning/item.created 등)            → 무시

interface RawCodexItem { type?: string; text?: string; [k: string]: unknown }
interface RawCodexEvent { type?: string; item?: RawCodexItem; error?: unknown; message?: unknown; [k: string]: unknown }

function codexFailureClass(raw: RawCodexEvent): string {
  const text = JSON.stringify(raw.error ?? raw.message ?? "").toLowerCase();
  if (/auth|login|credential|api.?key|unauthori[sz]ed/.test(text)) return "authentication";
  if (/model.+(not found|unavailable)|unknown model/.test(text)) return "model";
  if (/permission|access denied|sandbox/.test(text)) return "permission";
  if (/rate.?limit|quota/.test(text)) return "rate_limited";
  return "unspecified";
}

/** 단일 JSONL 줄 → SubAgentEvent 0~1개. malformed/빈줄/무관 type = null(드롭, no crash). */
export function codexLineToEvent(line: string): SubAgentEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: RawCodexEvent;
  try {
    raw = JSON.parse(trimmed) as RawCodexEvent;
  } catch {
    return null; // malformed JSON 관용.
  }
  if (typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "thread.started":
      return { kind: "planning" };
    case "turn.failed":
    case "error":
      // Codex may report a structured failure on stdout and still close with
      // code zero. Preserve only a redacted category, never raw prompt data.
      return { kind: "session_end", ok: false, reason: `codex ${raw.type}: ${codexFailureClass(raw)}` };
    case "item.completed": {
      const item = raw.item;
      if (!item || typeof item.type !== "string") return null;
      if (item.type === "agent_message") {
        const text = typeof item.text === "string" ? item.text : "";
        return text.length > 0 ? { kind: "text_delta", text } : null;
      }
      // 도구 계열(command_execution/file_change/file_edit/...)은 완료 snapshot → tool_use_end.
      // tool label = item.type(honest, 정보 손실 없음). 경계 시작은 codex 포맷에 없음.
      if (item.type === "command_execution" || item.type === "file_change" || item.type === "file_edit" || item.type === "mcp_tool_call") {
        return { kind: "tool_use_end", tool: item.type, ok: true };
      }
      return null; // reasoning 등 = 무시.
    }
    default:
      return null; // turn.started/turn.completed/turn.failed/error 등 = 무시(terminal=close).
  }
}

/** SubAgentPort 의 codex 구현. codex exec 1회를 sub-agent 세션으로 spawn. */
export function makeCodexSubAgent(opts: SubAgentCodexOptions = {}): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? DEFAULT_HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const resolveBin = opts.resolveBin ?? resolveCodexBin;
  const skipGit = opts.skipGitRepoCheck ?? true;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      let bin: ResolvedBin;
      try {
        bin = resolveBin();
      } catch (e) {
        return endedSession(`codex unavailable: ${(e as Error).message}`);
      }
      const model = opts.model ?? task.model;
      // exec --json --ignore-user-config --sandbox workspace-write <prompt>
      //   -c approval_policy="never" --ephemeral [--skip-git-repo-check] [--model X]
      // Global config/add-dir 상속을 끊고 non-interactive workspace 경계를 fail-closed로 고정.
      const args: string[] = [
        "exec", "--json",
        "--ignore-user-config",
        "--sandbox", "workspace-write",
        "--config", 'approval_policy="never"',
        "--ephemeral",
      ];
      if (skipGit) args.push("--skip-git-repo-check");
      if (model) args.push("--model", model);
      // Keep the free-form request as the final positional argument.  Current
      // Codex CLI releases parse exec options before its optional prompt;
      // placing a multi-word task first can be interpreted as a command.
      args.push(task.prompt);
      return spawnSubprocessSession({
        spawnFn, bin, args, cwd: task.workdir, hardKillMs, lineToEvent: codexLineToEvent, label: "codex", diagnostics: true,
      });
    },
  };
}
