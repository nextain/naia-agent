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
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";
import {
	NAIA_PI_PROVIDER, buildIsolatedPiChildEnv, buildNaiaPiChildEnv, ensureNaiaPiConfig,
	isNaiaPiModel,
} from "./naia-pi-provider.js";
import {
  buildUserOwnedPiChildEnv, ensureUserOwnedPiConfig, isUserOwnedPiBinding, type UserOwnedPiProvider,
} from "./user-owned-pi-provider.js";
import { initializeNaiaPiReceiptJournal, readNaiaPiReceiptJournal,
  type GatewayRequestBudgetPolicy } from "./naia-pi-versioned-billing.js";
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
  /** Explicit Pi built-in tool allowlist. Use this to exclude shell access from credential-bearing runs. */
  readonly toolAllowlist?: readonly ("read" | "write" | "edit" | "grep" | "find" | "ls")[];
  /** Synchronous integrity gate executed immediately before every Pi child spawn. */
  readonly beforeSpawn?: () => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly piConfigDir?: string;
  /** Provider-enforced maximum output tokens per model response when using the Naia custom catalog. */
  readonly maxOutputTokens?: number;
  /** Explicit loopback-only user-owned OpenAI-compatible provider catalog. */
  readonly userOwnedProvider?: UserOwnedPiProvider;
  /** Optional shared durable request-level ceiling, enforced inside the Naia billing fetch before network I/O. */
  readonly gatewayBudget?: { readonly path: string; readonly policy: GatewayRequestBudgetPolicy };
  /**
   * `required` keeps request-level gateway billing fail-closed. `unavailable` is an explicit
   * operational fallback for gateways that currently omit versioned settlement metadata.
   */
  readonly gatewayBillingMode?: "required" | "unavailable";
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
    const result = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
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
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
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
  identity?: { sessionId: string; executionId: string },
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
          cachedInputTokens: usage?.cachedInputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          ...(identity ?? {}),
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

function validPiUsage(value: NonNullable<RawPiEvent["message"]>["usage"]): { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  if (!value) return undefined;
  const fields = [value.input, value.output, value.totalTokens, value.cacheRead ?? 0, value.cacheWrite ?? 0];
  if (fields.some((field) => typeof field !== "number" || !Number.isSafeInteger(field) || field < 0)) return undefined;
  const [input, outputTokens, totalTokens, cacheRead, cacheWrite] = fields as number[];
  if (totalTokens < input + outputTokens + cacheRead + cacheWrite) return undefined;
  return { inputTokens: input + cacheWrite, cachedInputTokens: cacheRead, outputTokens, totalTokens };
}

export function makeCumulativePiLineParser(
  expected?: { provider: string; model: string }, identity?: { sessionId: string; executionId: string },
  receiptPath?: string,
): (line: string) => readonly SubAgentEvent[] {
  let inputTokens = 0; let cachedInputTokens = 0; let outputTokens = 0; let totalTokens = 0;
  let estimatedCost = 0; let usageComplete = true; let pricedComplete = true;
  let providerTurns = 0;
  return (line) => {
    const output: SubAgentEvent[] = [];
    for (const event of piLineToEvents(line, expected, identity)) {
      if (event.kind !== "model_evidence") { output.push(event); continue; }
      const current = event.evidence;
      providerTurns += 1;
      let gatewayBillingReceipts = current.gatewayBillingReceipts;
      let measuredCostUsd = current.measuredCostUsd;
      if (receiptPath && identity && expected?.provider === NAIA_PI_PROVIDER) {
        try {
          const journal = readNaiaPiReceiptJournal(receiptPath, identity.executionId);
          if (journal.entries.length !== providerTurns) throw new Error("receipt count does not match Pi provider turns");
          const latest = journal.entries.at(-1)!.receipt;
          if (latest.provider !== expected.provider || latest.model !== expected.model
            || latest.inputTokens + latest.cachedInputTokens !== current.inputTokens + (current.cachedInputTokens ?? 0)
            || latest.outputTokens !== current.outputTokens || latest.totalTokens !== current.totalTokens) {
            throw new Error("receipt route or token usage does not match Pi message evidence");
          }
          gatewayBillingReceipts = journal.entries.map((entry) => entry.receipt);
          measuredCostUsd = sumGatewayCustomerCost(gatewayBillingReceipts);
        } catch (error) {
          output.push(event, { kind: "session_end", ok: false,
            reason: `Naia Pi billing receipt unavailable: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
      }
      usageComplete &&= current.usageAvailable === true;
      pricedComplete &&= current.piEstimatedCost !== undefined;
      inputTokens += current.inputTokens; cachedInputTokens += current.cachedInputTokens ?? 0;
      outputTokens += current.outputTokens; totalTokens += current.totalTokens;
      estimatedCost += current.piEstimatedCost ?? 0;
      output.push({ kind: "model_evidence", evidence: { ...current,
        usageAvailable: usageComplete, inputTokens, cachedInputTokens, outputTokens, totalTokens,
        ...(pricedComplete ? { piEstimatedCost: estimatedCost } : {}),
        ...(measuredCostUsd !== undefined ? { measuredCostUsd } : {}),
        ...(gatewayBillingReceipts ? { gatewayBillingReceipts } : {}) } });
    }
    return output;
  };
}

function sumGatewayCustomerCost(receipts: readonly import("../domain/orchestration.js").GatewayBillingReceipt[]): number {
  let units = 0n;
  for (const receipt of receipts) {
    const [whole, fraction = ""] = receipt.customerCostDecimal.split(".");
    units += BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0"));
  }
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("gateway customer-cost aggregate exceeds safe range");
  return Number(units) / 100_000_000;
}

/** SubAgentPort 의 pi 구현. pi CLI 1회 실행을 sub-agent 세션으로 spawn. */
export function makePiSubAgent(opts: SubAgentPiOptions = {}): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? DEFAULT_HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const resolveBin = opts.resolveBin ?? resolvePiBin;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      try { opts.beforeSpawn?.(); }
      catch (error) { return endedSession(`Pi pre-spawn integrity gate failed: ${(error as Error).message}`); }
      const sourceEnv = opts.env ?? process.env;
      const model = opts.model ?? task.model;
      const naiaModel = isNaiaPiModel(model);
      const provider = opts.provider ?? (naiaModel ? NAIA_PI_PROVIDER : undefined);
      const userOwnedModel = provider && model
        ? isUserOwnedPiBinding(opts.userOwnedProvider, { provider, model }) : false;
      const identity = { sessionId: randomUUID(), executionId: randomUUID() };
      if (naiaModel && provider !== NAIA_PI_PROVIDER) {
        return endedSession(`Naia model '${model}' cannot use direct provider '${provider}'`);
      }
      if (opts.userOwnedProvider && provider === opts.userOwnedProvider.id && !userOwnedModel) {
        return endedSession(`user-owned Pi model '${model ?? ""}' is not in the declared local catalog`);
      }
      let childEnv = buildIsolatedPiChildEnv(sourceEnv, opts.piConfigDir);
      let receiptPath: string | undefined;
      if (naiaModel) {
        const key = (sourceEnv["NAIA_API_KEY"] ?? sourceEnv["NAIA_ANYLLM_API_KEY"])?.trim();
        if (!key) return endedSession("NAIA_API_KEY is required; run 'naia-agent login --provider naia'");
        try {
          const configDir = ensureNaiaPiConfig({
            ...(opts.piConfigDir ? { dir: opts.piConfigDir } : {}),
            baseUrl: sourceEnv["NAIA_ANYLLM_BASE_URL"] ?? sourceEnv["NAIA_GATEWAY_URL"],
            ...(opts.maxOutputTokens ? { maxTokens: opts.maxOutputTokens } : {}),
          });
          const reservedOutputTokens = opts.maxOutputTokens ?? 4_096;
          const gatewayBudget = opts.gatewayBudget ?? {
            path: join(configDir, "gateway-budgets", `${identity.executionId}.db`),
            policy: { maxGatewayCalls: 8, maxUsd: 0.2, maxInputTokens: 32_000,
              maxOutputTokens: reservedOutputTokens * 8,
              requestAllowance: { reservedUsd: 0.025, reservedInputTokens: 4_000, reservedOutputTokens } },
          };
          if (opts.gatewayBillingMode === "unavailable") {
            childEnv = buildNaiaPiChildEnv(sourceEnv, configDir, key);
          } else {
            receiptPath = join(configDir, "receipts", `${identity.executionId}.json`);
            initializeNaiaPiReceiptJournal(receiptPath, identity.executionId);
            childEnv = buildNaiaPiChildEnv(sourceEnv, configDir, key, { executionId: identity.executionId,
              receiptPath, gatewayBudget });
          }
        } catch (e) {
          return endedSession(`naia pi configuration failed: ${(e as Error).message}`);
        }
      } else if (userOwnedModel) {
        try {
          const configDir = ensureUserOwnedPiConfig(opts.userOwnedProvider!, opts.piConfigDir);
          childEnv = buildUserOwnedPiChildEnv(sourceEnv, configDir);
        } catch (e) {
          return endedSession(`user-owned pi configuration failed: ${(e as Error).message}`);
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
      if (naiaModel && opts.gatewayBillingMode !== "unavailable") {
        const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/pi/naia-versioned-billing-extension.mjs");
        if (!existsSync(extension)) return endedSession("Naia Pi billing extension is unavailable; run the packaged Agent build");
        args.push("--no-extensions", "--extension", extension);
      }
      if (provider) args.push("--provider", provider);
      if (model) args.push("--model", model);
      if (opts.noTools === true) args.push("--no-tools");
      else if (task.filesystemAccess === "read_only") args.push("--tools", "read,grep,find,ls");
      else if (opts.toolAllowlist) {
        if (opts.toolAllowlist.length === 0 || new Set(opts.toolAllowlist).size !== opts.toolAllowlist.length) {
          return endedSession("Pi tool allowlist must be nonempty and unique");
        }
        args.push("--tools", opts.toolAllowlist.join(","));
      }
      const expected = provider && model ? { provider, model } : undefined;
      const lineToEvent = makeCumulativePiLineParser(expected, identity, receiptPath);
      return spawnSubprocessSession({
        spawnFn, bin, args, cwd: task.workdir, env: childEnv, hardKillMs,
        lineToEvent,
        label: "pi", diagnostics: true,
      });
    },
  };
}
