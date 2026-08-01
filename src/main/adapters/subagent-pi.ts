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
  NAIA_PI_PROVIDER, buildNaiaPiChildEnv, ensureNaiaPiConfig, isNaiaPiModel,
} from "./naia-pi-provider.js";
import {
  DEFAULT_HARD_KILL_DEADLINE_MS, defaultSpawn, spawnSubprocessSession, endedSession,
  type SpawnFn, type ResolvedBin, pickSpawnableBin, resolveSpawnableBin, resolveFallbackCommand,
} from "./subprocess-session.js";

export type { SpawnFn, ResolvedBin };

export interface SubAgentPiOptions {
  /** --provider 로 전달(옵셔널). */
  readonly provider?: string;
  /** --model 로 전달(옵셔널). TaskSpec.model 보다 우선(어댑터 고정 모델). */
  readonly model?: string;
  readonly noTools?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly piConfigDir?: string;
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
    resolve(thisDir, "../../../node_modules/.bin/pi.cmd"),
    resolve(thisDir, "../../../node_modules/.bin/pi"),
    resolve(thisDir, "../../../../node_modules/.bin/pi.cmd"),
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
  if (inNodeModules) return resolveSpawnableBin(inNodeModules);
  const inPath = findPiInPath();
  if (inPath) return resolveSpawnableBin(inPath);
  const fb = resolveFallbackCommand("npx");
  return { command: fb.command, prefixArgs: [...fb.prefixArgs, "--yes", "@earendil-works/pi-coding-agent@0.83.0"] };
}

// ── pi NDJSON 파싱 (구 adapter-pi/event-parser.ts 의 필요 부분만) ─────────────

interface RawPiEvent {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    provider?: string;
    model?: string;
    usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } };
  };
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
  const events = piLineToEvents(line);
  return events.length > 0 ? events[0]! : null;
}

/** A Pi message_end carries both visible text and the provider/model/usage evidence. */
export function piLineToEvents(
  line: string,
  expected?: { provider: string; model: string },
): readonly SubAgentEvent[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  let raw: RawPiEvent;
  try {
    raw = JSON.parse(trimmed) as RawPiEvent;
  } catch {
    return [];
  }
  if (typeof raw.type !== "string") return [];

  switch (raw.type) {
    case "session_start":
    case "agent_start":
      return [{ kind: "planning" }];
    case "message_end": {
      if (raw.message?.role === "user" || raw.message?.role === "toolResult") return [];
      const text = extractMessageText(raw.message);
      const events: SubAgentEvent[] = [];
      if (text.length > 0) events.push({ kind: "text_delta", text });
      const m = raw.message;
      if (m && typeof m.provider === "string" && typeof m.model === "string" && m.usage) {
        const usage = validPiUsage(m.usage);
        const evidence = {
          provider: m.provider,
          selectedModel: m.model,
          modelEvidenceSource: "provider_reported" as const,
          usageAvailable: Boolean(usage),
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          ...(usage && typeof m.usage.cost?.total === "number" && Number.isFinite(m.usage.cost.total) && m.usage.cost.total >= 0
            ? { piEstimatedCost: m.usage.cost.total } : {}),
        };
        events.push({ kind: "model_evidence", evidence });
        if (expected && (m.provider !== expected.provider || m.model !== expected.model)) {
          events.push({ kind: "session_end", ok: false, reason: `pi model mismatch: expected ${expected.provider}/${expected.model}, Pi reported ${m.provider}/${m.model}` });
        }
      } else if (expected) {
        events.push({ kind: "session_end", ok: false, reason: "pi model evidence missing from message_end" });
      }
      return events;
    }
    case "tool_execution_start": {
      const tool = typeof raw.toolName === "string" ? raw.toolName : "unknown";
      return [{ kind: "tool_use_start", tool }];
    }
    case "tool_execution_end": {
      const tool = typeof raw.toolName === "string" ? raw.toolName : "unknown";
      return [{ kind: "tool_use_end", tool, ok: raw.isError !== true }];
    }
    default:
      return [];
  }
}

function validPiUsage(value: NonNullable<RawPiEvent["message"]>["usage"]): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  if (!value) return undefined;
  const fields = [value.input, value.output, value.totalTokens];
  if (fields.some((field) => typeof field !== "number" || !Number.isSafeInteger(field) || field < 0)) return undefined;
  const [inputTokens, outputTokens, totalTokens] = fields as number[];
  if (totalTokens < inputTokens + outputTokens) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

/** SubAgentPort 의 pi 구현. pi CLI 1회 실행을 sub-agent 세션으로 spawn. */
export function makePiSubAgent(opts: SubAgentPiOptions = {}): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? DEFAULT_HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const resolveBin = opts.resolveBin ?? resolvePiBin;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      const sourceEnv = opts.env ?? process.env;
      const model = opts.model ?? task.model;
      const naiaModel = isNaiaPiModel(model);
      const provider = opts.provider ?? (naiaModel ? NAIA_PI_PROVIDER : undefined);
      if (naiaModel && provider !== NAIA_PI_PROVIDER) {
        return endedSession(`Naia model '${model}' cannot use direct provider '${provider}'`);
      }
      if (model === "deepseek-v4-pro" && opts.noTools !== true) {
        return endedSession("deepseek-v4-pro is analysis-only; rerun with --no-tools");
      }
      let childEnv: NodeJS.ProcessEnv | undefined;
      if (naiaModel) {
        const key = (sourceEnv["NAIA_API_KEY"] ?? sourceEnv["NAIA_ANYLLM_API_KEY"])?.trim();
        if (!key) return endedSession("NAIA_API_KEY is required; run 'naia-agent login --provider naia'");
        try {
          const configDir = ensureNaiaPiConfig({
            ...(opts.piConfigDir ? { dir: opts.piConfigDir } : {}),
            baseUrl: sourceEnv["NAIA_ANYLLM_BASE_URL"] ?? sourceEnv["NAIA_GATEWAY_URL"],
          });
          childEnv = buildNaiaPiChildEnv(sourceEnv, configDir, key);
        } catch (e) {
          return endedSession(`naia pi configuration failed: ${(e as Error).message}`);
        }
      }
      // bin 해석(PI_BIN 부적합 등) 실패는 throw 가 아니라 정직한 session_end{ok:false}(AC6).
      let bin: ResolvedBin;
      try {
        bin = resolveBin();
      } catch (e) {
        return endedSession(`pi unavailable: ${(e as Error).message}`);
      }
      const args: string[] = ["-p", task.prompt, "--mode", "json", "--no-session"];
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);
      if (opts.noTools === true) args.push("--no-tools");
      return spawnSubprocessSession({
        spawnFn, bin, args, cwd: task.workdir, ...(childEnv ? { env: childEnv } : {}), hardKillMs,
        lineToEvent: naiaModel ? (line) => piLineToEvents(line, { provider: NAIA_PI_PROVIDER, model }) : piLineToEvent,
        label: "pi", diagnostics: true,
      });
    },
  };
}
