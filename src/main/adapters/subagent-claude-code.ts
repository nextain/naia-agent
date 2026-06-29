// adapters/subagent-claude-code — SubAgentPort 의 **claude-code** 구현 (UC-014 / SPEC-010 확장, 2026-06-29).
//
// `claude -p "<prompt>" --output-format stream-json --verbose [...]` 를 sub-agent 로 spawn →
// claude stream-json NDJSON → SubAgentEvent. 세션 머신(스트림·cancel·가드)은 공유 subprocess-session 에.
// 여기엔 claude 고유의 (1) bin 해석 (2) args (3) line parser 만.
//
// bin 미해결/ENOENT = 정직한 session_end{ok:false}(throw 금지, AC6). spawnFn 주입 seam.
//
// ⚠️ pi/opencode 어댑터는 **무상태** `lineToEvent`(줄 1개 → event 1개) 를 쓰나, claude stream-json 은
//    assistant 메시지의 `tool_use`(id+name) 완료 후 **별도 줄** 의 user 메시지 `tool_result`(tool_use_id) 로
//    짝지어져 돌아온다 — tool_use_end 에 name 을 복원하려면 id→name 매핑 상태가 필요하다. 그래서 claude 만
//    **상태ful parser factory**(createClaudeLineParser, spawn 마다 1개) 를 쓴다. 동시 세션 격리 보장(모듈
//    전역 상태 아님). terminal session_end 는 여전히 process close(code) 가 단일 발생(pi/opencode 동일).
//
// RT-verified(2026-06-29, claude 2.1.156): init/assistant(text·tool_use)/user(tool_result)/result(is_error)
// 이벤트 shape 실측. 단 rate_limit(weekly) hit 로 본문 생성은 못했으나 shape 는 전부 확보됨.
import { execSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";
import {
  DEFAULT_HARD_KILL_DEADLINE_MS, defaultSpawn, spawnSubprocessSession, endedSession,
  type SpawnFn, type ResolvedBin, type LineToEvent, pickSpawnableBin, resolveSpawnableBin, resolveFallbackCommand,
} from "./subprocess-session.js";

export type { SpawnFn, ResolvedBin };

export interface SubAgentClaudeCodeOptions {
  /** --model 로 전달(옵셔널). TaskSpec.model 보다 우선(어댑터 고정 모델). */
  readonly model?: string;
  /** --dangerously-skip-permissions(기본 false). sub-agent 자율 구동 시 true 권장. */
  readonly skipPermissions?: boolean;
  readonly hardKillDeadlineMs?: number;
  /** bin 해석 주입(테스트/override). 미주입 = resolveClaudeCodeBin(env→PATH→npx). */
  readonly resolveBin?: () => ResolvedBin;
  readonly spawnFn?: SpawnFn;
}

// ── bin resolution (pi/opencode 동형 패턴: env 절대경로 검증 → PATH → npx fallback) ──

function validateClaudeCodeBin(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.includes("\0")) throw new Error(`CLAUDE_BIN contains null byte — refusing to spawn (injection guard)`);
  if (!isAbsolute(trimmed)) {
    throw new Error(`CLAUDE_BIN must be an absolute path (got: ${trimmed.slice(0, 60)}) — set full path e.g. /usr/local/bin/claude`);
  }
  return trimmed;
}

function findClaudeCodeInPath(): string | null {
  const cmd = process.platform === "win32" ? `where claude` : `which claude`;
  try {
    const result = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return pickSpawnableBin(result.split(/\r?\n/));
  } catch {
    return null;
  }
}

export function resolveClaudeCodeBin(): ResolvedBin {
  const validated = validateClaudeCodeBin(process.env["CLAUDE_BIN"]);
  if (validated) return { command: validated, prefixArgs: [] };
  const inPath = findClaudeCodeInPath();
  if (inPath) return resolveSpawnableBin(inPath);
  const fb = resolveFallbackCommand("npx");
  return { command: fb.command, prefixArgs: [...fb.prefixArgs, "--yes", "@anthropic-ai/claude-code"] };
}

// ── claude stream-json NDJSON 파싱 ──────────────────────────────────────────
// stream-json 이벤트(claude 2.1.156 실측):
//   {"type":"system","subtype":"init",...}                              → planning(시작 신호)
//   {"type":"assistant","message":{"content":[{type:"text",text},{type:"tool_use",id,name,input},...]}}
//                                                                       → text_delta(text 있을 때) / tool_use_start(name)
//   {"type":"user","message":{"content":[{type:"tool_result",tool_use_id,is_error}]}}
//                                                                       → tool_use_end(id→name 상태 매핑)
//   {"type":"result","is_error":...}                                    → 무시(terminal=close)
//   그 외(stream_event/rate_limit_event/partial 등)                     → 무시

interface RawContentBlock { type?: string; text?: string; id?: string; name?: string; }
interface RawAssistantMessage { content?: RawContentBlock[]; }
interface RawUserMessage { content?: Array<{ type?: string; tool_use_id?: string; is_error?: boolean }> }
interface RawClaudeEvent {
  type?: string;
  subtype?: string;
  message?: RawAssistantMessage | RawUserMessage;
  [k: string]: unknown;
}

/** assistant content 에서 text 블록 텍스트를 모아 합친다(순수). */
function extractAssistantText(msg: RawAssistantMessage | undefined): string {
  if (!msg || !Array.isArray(msg.content)) return "";
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
  }
  return parts.join("");
}

/**
 * claude stream-json 용 **상태ful** line parser(spawn 마다 1개 생성). id→name 맵으로 tool_use_start 의 name 을
 * tool_use_end 에 복원. terminal(session_end) 은 반환하지 않는다(close 가 단일 발생). malformed/무관 type = null 드롭.
 */
export function createClaudeLineParser(): LineToEvent {
  const toolNames = new Map<string, string>(); // tool_use_id → name
  return (line: string): SubAgentEvent | null => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    let raw: RawClaudeEvent;
    try {
      raw = JSON.parse(trimmed) as RawClaudeEvent;
    } catch {
      return null; // malformed JSON 관용.
    }
    if (typeof raw.type !== "string") return null;

    switch (raw.type) {
      case "system":
        return raw.subtype === "init" ? { kind: "planning" } : null;
      case "assistant": {
        const msg = raw.message as RawAssistantMessage | undefined;
        const text = extractAssistantText(msg);
        if (text.length > 0) return { kind: "text_delta", text };
        // text 없으면 첫 tool_use 를 start 로(한 줄에 여러 tool_use 드묾 — 단일 표현).
        const tu = msg?.content?.find((b) => b?.type === "tool_use" && typeof b.name === "string");
        if (tu && typeof tu.id === "string" && typeof tu.name === "string") {
          toolNames.set(tu.id, tu.name);
          return { kind: "tool_use_start", tool: tu.name };
        }
        return null;
      }
      case "user": {
        const msg = raw.message as RawUserMessage | undefined;
        const tr = msg?.content?.find((b) => b?.type === "tool_result");
        if (!tr || typeof tr.tool_use_id !== "string") return null;
        const name = toolNames.get(tr.tool_use_id) ?? "claude-tool";
        toolNames.delete(tr.tool_use_id);
        return { kind: "tool_use_end", tool: name, ok: tr.is_error !== true };
      }
      default:
        return null; // result/stream_event/rate_limit_event 등 = 무시.
    }
  };
}

/** SubAgentPort 의 claude-code 구현. claude CLI 1회 실행을 sub-agent 세션으로 spawn. */
export function makeClaudeCodeSubAgent(opts: SubAgentClaudeCodeOptions = {}): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? DEFAULT_HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const resolveBin = opts.resolveBin ?? resolveClaudeCodeBin;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      let bin: ResolvedBin;
      try {
        bin = resolveBin();
      } catch (e) {
        return endedSession(`claude-code unavailable: ${(e as Error).message}`);
      }
      const model = opts.model ?? task.model;
      // -p <prompt> --output-format stream-json --verbose [--model X] [--dangerously-skip-permissions]
      const args: string[] = ["-p", task.prompt, "--output-format", "stream-json", "--verbose"];
      if (model) args.push("--model", model);
      if (opts.skipPermissions) args.push("--dangerously-skip-permissions");
      return spawnSubprocessSession({
        spawnFn, bin, args, cwd: task.workdir, hardKillMs,
        lineToEvent: createClaudeLineParser(), label: "claude-code",
      });
    },
  };
}
