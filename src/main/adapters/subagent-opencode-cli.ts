// adapters/subagent-opencode-cli — SubAgentPort 의 **opencode** 구현 (구 adapter-opencode-cli 이식, 단계 2b).
//
// `opencode run --format json --dir <workdir> [...] <prompt>` 를 sub-agent 로 spawn → opencode NDJSON → SubAgentEvent.
// 세션 머신(스트림·cancel·가드)은 공유 subprocess-session 에. 여기엔 opencode 고유의 bin·args·lineToEvent 만.
// bin 미해결/ENOENT = 정직한 session_end{ok:false}(throw 금지, AC6). spawnFn 주입 seam.
import { execSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";
import {
  DEFAULT_HARD_KILL_DEADLINE_MS, defaultSpawn, spawnSubprocessSession, endedSession,
  type SpawnFn, type ResolvedBin,
} from "./subprocess-session.js";

export interface SubAgentOpencodeOptions {
  /** -m 으로 전달(옵셔널). TaskSpec.model 보다 우선. */
  readonly model?: string;
  /** opencode --dangerously-skip-permissions(기본 false). */
  readonly skipPermissions?: boolean;
  readonly hardKillDeadlineMs?: number;
  /** bin 해석 주입(테스트/override). 미주입 = resolveOpencodeBin(env→PATH→npx). */
  readonly resolveBin?: () => ResolvedBin;
  readonly spawnFn?: SpawnFn;
}

// ── bin resolution (구 adapter-opencode-cli/resolve-bin.ts 이식: env → PATH → npx) ──

function validateOpencodeBin(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  const trimmed = raw.trim();
  if (trimmed.includes("\0")) throw new Error(`OPENCODE_BIN contains null byte — refusing to spawn (injection guard)`);
  if (!isAbsolute(trimmed)) {
    throw new Error(`OPENCODE_BIN must be an absolute path (got: ${trimmed.slice(0, 60)}) — set full path e.g. /usr/local/bin/opencode`);
  }
  return trimmed;
}

function findOpencodeInPath(): string | null {
  const cmd = process.platform === "win32" ? `where opencode` : `which opencode`;
  try {
    const result = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const first = result.split(/\r?\n/)[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

export function resolveOpencodeBin(): ResolvedBin {
  const validated = validateOpencodeBin(process.env["OPENCODE_BIN"]);
  if (validated) return { command: validated, prefixArgs: [] };
  const inPath = findOpencodeInPath();
  if (inPath) return { command: inPath, prefixArgs: [] };
  return { command: "npx", prefixArgs: ["--yes", "opencode-ai@1.14.25"] }; // 구판 핀 버전.
}

// ── opencode NDJSON 파싱 (구 event-parser.ts: text/tool_use/step_start) ────────

interface RawToolState { status?: string }
interface RawPart { text?: string; tool?: string; state?: RawToolState }
interface RawOpencodeEvent { type?: string; part?: RawPart; [key: string]: unknown }

/** 단일 NDJSON 줄 → SubAgentEvent 0~1개. malformed/빈줄/무관 type = null(드롭). */
export function opencodeLineToEvent(line: string): SubAgentEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: RawOpencodeEvent;
  try {
    raw = JSON.parse(trimmed) as RawOpencodeEvent;
  } catch {
    return null; // malformed JSON 관용.
  }
  if (typeof raw.type !== "string") return null;

  switch (raw.type) {
    case "step_start":
      return { kind: "planning" };
    case "text": {
      const text = typeof raw.part?.text === "string" ? raw.part.text : "";
      return text.length > 0 ? { kind: "text_delta", text } : null;
    }
    case "tool_use": {
      const tool = raw.part?.tool ?? "unknown";
      const status = raw.part?.state?.status ?? "running";
      // running/pending → start. completed/error → end(ok = !error). 그 외 status = start 로 간주.
      if (status === "completed" || status === "error") {
        return { kind: "tool_use_end", tool, ok: status !== "error" };
      }
      return { kind: "tool_use_start", tool };
    }
    // step_finish(토큰 집계 경계) 등 = 2a 대응 kind 없음 → 드롭.
    default:
      return null;
  }
}

/** SubAgentPort 의 opencode 구현. opencode run 1회를 sub-agent 세션으로 spawn. */
export function makeOpencodeSubAgent(opts: SubAgentOpencodeOptions = {}): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? DEFAULT_HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const resolveBin = opts.resolveBin ?? resolveOpencodeBin;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      let bin: ResolvedBin;
      try {
        bin = resolveBin();
      } catch (e) {
        return endedSession(`opencode unavailable: ${(e as Error).message}`);
      }
      const model = opts.model ?? task.model;
      // 구판: run --format json --dir <workdir> [-m model] [--dangerously-skip-permissions] <prompt>(prompt 가 마지막).
      const args: string[] = ["run", "--format", "json", "--dir", task.workdir];
      if (model) args.push("-m", model);
      if (opts.skipPermissions) args.push("--dangerously-skip-permissions");
      args.push(task.prompt);
      return spawnSubprocessSession({
        spawnFn, bin, args, cwd: task.workdir, hardKillMs, lineToEvent: opencodeLineToEvent, label: "opencode",
      });
    },
  };
}
