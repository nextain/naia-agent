// adapters/subagent-codex — SubAgentPort 의 **codex** 구현 (UC-014 / SPEC-010 확장, 2026-06-29).
//
// `codex exec "<prompt>" --json [...]` 를 sub-agent 로 spawn → codex JSONL → SubAgentEvent.
// 세션 머신(스트림·cancel·가드)은 공유 subprocess-session 에. 여기엔 codex 고유의 (1) bin 해석 (2) args
// (3) line parser (4) Naia 8종·로컬 모델 루프백 브리지 배선만.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";
import { prepareManagedCodexHomeSync } from "./codex-app-server-provider.js";
import {
  CODEX_NO_TOOLS_CONFIG_FLAGS,
  NAIA_MODEL_METADATA,
  NAIA_PI_PROVIDER,
  buildCodexModelCatalogEntry,
  ensureNaiaPiConfig,
  estimateNaiaModelCostUsd,
  normalizeNaiaGatewayBaseUrl,
  normalizeNaiaGatewayModel,
  writeCodexModelCatalogFile,
} from "./naia-pi-provider.js";
import {
  initializeNaiaPiReceiptJournal,
  readNaiaPiReceiptJournal,
  startCodexResponsesLoopbackBridge,
  sumGatewayCustomerCost,
  type CodexResponsesBridgeHandle,
  type CodexResponsesBridgeOptions,
  type GatewayRequestBudgetPolicy,
} from "./naia-pi-versioned-billing.js";
import {
  DEFAULT_HARD_KILL_DEADLINE_MS, defaultSpawn, spawnSubprocessSession, endedSession,
  type SpawnFn, type ResolvedBin, type ResolveCommandOptions, resolveFallbackCommand,
  buildIsolatedSubprocessEnv,
} from "./subprocess-session.js";
import {
  ensureUserOwnedPiConfig,
  isBuiltInLocalProvider,
  isUserOwnedPiBinding,
  normalizeLoopbackBaseUrl,
  resolveLocalEngineBaseUrl,
  type UserOwnedPiProvider,
} from "./user-owned-pi-provider.js";

export type { SpawnFn, ResolvedBin, ResolveCommandOptions };

export interface SubAgentCodexOptions {
  /** 프로바이더 식별자 ("codex" | "openai-codex" | "naia" | "nextain" | "local" | "ollama" | "vllm" | "lmstudio" | "local-*"). */
  readonly provider?: string;
  /** -m/--model 로 전달(옵셔널). TaskSpec.model 보다 우선. */
  readonly model?: string;
  /** --no-tools 지정 시 읽기 전용 샌드박스(--sandbox read-only) 및 도구 비활성화로 실행. */
  readonly noTools?: boolean;
  /** Codex CLI model_reasoning_effort. Kept separate from the model id so role profiles remain explicit. */
  readonly reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  /** --skip-git-repo-check(기본 true — sub-agent 가 비-git workdir 도 동작하도록). */
  readonly skipGitRepoCheck?: boolean;
  readonly hardKillDeadlineMs?: number;
  readonly resolveBin?: () => ResolvedBin;
  readonly spawnFn?: SpawnFn;
  readonly beforeSpawn?: () => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly baseUrl?: string;
  readonly codexHome?: string;
  readonly workspaceRoot?: string;
  readonly codexConfigDir?: string;
  readonly piConfigDir?: string;
  readonly maxOutputTokens?: number;
  readonly thinkingLevel?: string;
  readonly userOwnedProvider?: UserOwnedPiProvider;
  readonly gatewayBudget?: { readonly path: string; readonly policy: GatewayRequestBudgetPolicy };
  readonly gatewayBillingMode?: "required" | "unavailable";
  readonly fetch?: typeof globalThis.fetch;
  readonly priceUsdPerMillion?: {
    readonly uncachedInput: number;
    readonly cachedInput: number;
    readonly output: number;
  };
  /** Maximum input-token count to which the pinned price snapshot applies. */
  readonly maximumPricedInputTokens?: number;
}

export interface CodexWorkerEnvOptions {
  readonly codexHome?: string;
  readonly workspaceRoot?: string;
  readonly targetDir?: string;
  readonly bridgeEnvKey?: string;
  readonly bridgeToken?: string;
  readonly allowBridgeEnvKey?: boolean;
}

/**
 * A Naia-owned worker must never join a parent Codex app-server thread or
 * inherit its thread identity. Its own CLI arguments define the requested
 * workspace-write/approval boundary, but an outer OS sandbox remains
 * authoritative and cannot be widened by a child process.
 * Always provisions a managed CODEX_HOME (empty config.toml + symlinked auth.json)
 * unless an explicit codexHome override is supplied via opts.
 */
export function codexWorkerEnv(
  source: NodeJS.ProcessEnv = process.env,
  opts?: CodexWorkerEnvOptions,
): NodeJS.ProcessEnv {
  const extraAllowed: string[] = ["CODEX_HOME"];
  const envSource: NodeJS.ProcessEnv = { ...source };
  const codexHome = opts?.codexHome ?? prepareManagedCodexHomeSync({
    ...(opts?.workspaceRoot && existsSync(opts.workspaceRoot) ? { workspaceRoot: opts.workspaceRoot } : {}),
    ...(opts?.targetDir ? { targetDir: opts.targetDir } : {}),
    sourceEnv: source,
  });
  envSource.CODEX_HOME = codexHome;
  if (opts?.bridgeEnvKey) {
    if (opts.allowBridgeEnvKey !== false && opts.bridgeToken !== undefined && opts.bridgeToken.length > 0) {
      envSource[opts.bridgeEnvKey] = opts.bridgeToken;
      extraAllowed.push(opts.bridgeEnvKey);
    } else {
      delete envSource[opts.bridgeEnvKey];
    }
  }
  return buildIsolatedSubprocessEnv(envSource, extraAllowed);
}

// ── bin resolution (탐색 순서: CODEX_BIN → 패키지 내부 node_modules/.bin/codex → 시스템 PATH; 무버전 npx 폴백 금지) ──

export function resolveCodexBin(opts?: ResolveCommandOptions): ResolvedBin {
  return resolveFallbackCommand("codex", opts);
}

// ── codex JSONL 파싱 ─────────────────────────────────────────────────────────
interface RawCodexItem { type?: string; text?: string; [k: string]: unknown }
interface RawCodexEvent {
  type?: string;
  item?: RawCodexItem;
  error?: unknown;
  message?: unknown;
  thread_id?: unknown;
  usage?: { input_tokens?: unknown; cached_input_tokens?: unknown; output_tokens?: unknown };
  [k: string]: unknown;
}

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
    case "turn.completed":
      return { kind: "session_end", ok: true, reason: "codex turn.completed" };
    case "turn.failed":
    case "error":
      return { kind: "session_end", ok: false, reason: `codex ${raw.type}: ${codexFailureClass(raw)}` };
    case "item.completed": {
      const item = raw.item;
      if (!item || typeof item.type !== "string") return null;
      if (item.type === "agent_message") {
        const text = typeof item.text === "string" ? item.text : "";
        return text.length > 0 ? { kind: "text_delta", text } : null;
      }
      if (item.type === "command_execution" || item.type === "file_change" || item.type === "file_edit" || item.type === "mcp_tool_call") {
        return { kind: "tool_use_end", tool: item.type, ok: true };
      }
      return null;
    }
    default:
      return null;
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
      try {
        opts.beforeSpawn?.();
      } catch (error) {
        return endedSession(`Codex pre-spawn integrity gate failed: ${(error as Error).message}`);
      }
      const sourceEnv = opts.env ?? process.env;
      const rawModel = opts.model ?? task.model;
      const naiaCanonical = normalizeNaiaGatewayModel(rawModel);
      const isNaiaModel = naiaCanonical !== undefined;
      const rawProvider = opts.provider?.trim();
      const providerLower = rawProvider?.toLowerCase();

      const liveNaiaKey = () =>
        (opts.env?.["NAIA_API_KEY"] ?? opts.env?.["NAIA_ANYLLM_API_KEY"] ?? process.env["NAIA_API_KEY"] ?? process.env["NAIA_ANYLLM_API_KEY"])?.trim();

      const isExplicitNaiaProvider = providerLower === "naia" || providerLower === "nextain";
      const isNaiaRoute = isExplicitNaiaProvider || (isNaiaModel && rawProvider === undefined && Boolean(liveNaiaKey()));

      if (isNaiaModel && !isNaiaRoute) {
        if (rawProvider !== undefined && !isExplicitNaiaProvider) {
          return endedSession(
            `codex model rejected before spawn: Naia gateway model '${rawModel}' cannot use direct provider '${rawProvider}'`,
          );
        }
        return endedSession(
          `codex model rejected before spawn: Naia gateway model '${rawModel}' cannot be passed directly to OpenAI Codex CLI`,
        );
      }
      if (isExplicitNaiaProvider && !isNaiaModel) {
        return endedSession(
          `codex model rejected before spawn: Model '${rawModel ?? ""}' is not registered for Naia provider`,
        );
      }
      if (isNaiaRoute && opts.env !== undefined && !liveNaiaKey()) {
        return endedSession("NAIA_API_KEY is required; run 'naia-agent login --provider naia'");
      }

      const isUserOwnedRoute = rawProvider !== undefined && rawModel !== undefined
        ? isUserOwnedPiBinding(opts.userOwnedProvider, { provider: rawProvider, model: rawModel })
        : false;
      if (opts.userOwnedProvider && rawProvider === opts.userOwnedProvider.id && !isUserOwnedRoute) {
        return endedSession(`user-owned model '${rawModel ?? ""}' is not in the declared local catalog`);
      }
      const isLocalEngineRoute = !isUserOwnedRoute && isBuiltInLocalProvider(rawProvider);
      const isBridgedRoute = isNaiaRoute || isUserOwnedRoute || isLocalEngineRoute;

      let bin: ResolvedBin;
      try {
        bin = resolveBin();
      } catch (e) {
        return endedSession(`codex unavailable: ${(e as Error).message}`);
      }

      const executionId = randomUUID();
      const effectiveModel = isNaiaRoute ? naiaCanonical! : rawModel;
      const effectiveNoTools = opts.noTools === true;
      const configDirBase = opts.codexConfigDir ?? opts.piConfigDir;
      const managedCodexHome = opts.codexHome ?? prepareManagedCodexHomeSync({
        ...(opts.workspaceRoot && existsSync(opts.workspaceRoot) ? { workspaceRoot: opts.workspaceRoot } : {}),
        ...(configDirBase ? { targetDir: join(configDirBase, "codex-home") } : {}),
        sourceEnv,
      });

      let bridgeOptions: CodexResponsesBridgeOptions | undefined;
      let baseUrlConfigKey: string | undefined;
      let receiptPath: string | undefined;
      let childEnv: NodeJS.ProcessEnv = codexWorkerEnv(sourceEnv, { codexHome: managedCodexHome });
      const bridgeConfigArgs: string[] = [];

      if (isNaiaRoute) {
        try {
          const upstreamBaseUrl = normalizeNaiaGatewayBaseUrl(
            opts.baseUrl ?? sourceEnv["NAIA_ANYLLM_BASE_URL"] ?? sourceEnv["NAIA_GATEWAY_URL"],
          );
          const configDir = ensureNaiaPiConfig({
            ...(configDirBase ? { dir: configDirBase } : {}),
            baseUrl: upstreamBaseUrl,
            ...(opts.maxOutputTokens ? { maxTokens: opts.maxOutputTokens } : {}),
            noTools: effectiveNoTools,
          });
          const catalogPath = join(
            configDir,
            effectiveNoTools ? "codex-model-catalog-notools.json" : "codex-model-catalog.json",
          );
          const reservedOutputTokens = opts.maxOutputTokens
            ?? (effectiveModel === "motif-3" ? 8_192 : 4_096);
          const gatewayBudget = opts.gatewayBudget ?? {
            path: join(configDir, "gateway-budgets", `${executionId}.db`),
            policy: {
              maxGatewayCalls: 8,
              maxUsd: 0.2,
              maxInputTokens: 32_000,
              maxOutputTokens: reservedOutputTokens * 8,
              requestAllowance: { reservedUsd: 0.025, reservedInputTokens: 4_000, reservedOutputTokens },
            },
          };
          let billing: {
            readonly executionId: string;
            readonly journalPath: string;
            readonly gatewayBudget: { readonly path: string; readonly policy: GatewayRequestBudgetPolicy };
          } | undefined;
          if (opts.gatewayBillingMode !== "unavailable") {
            receiptPath = join(configDir, "receipts", `${executionId}.json`);
            initializeNaiaPiReceiptJournal(receiptPath, executionId);
            billing = { executionId, journalPath: receiptPath, gatewayBudget };
          }
          const bridgeToken = `naia-bridge-${randomUUID()}`;
          bridgeOptions = {
            provider: NAIA_PI_PROVIDER,
            expectedModel: effectiveModel!,
            upstreamBaseUrl,
            bridgeToken,
            getApiKey: liveNaiaKey,
            noTools: effectiveNoTools,
            ...(opts.maxOutputTokens !== undefined
              ? { maxOutputTokens: opts.maxOutputTokens }
              : effectiveModel === "motif-3"
                ? { maxOutputTokens: 8_192 }
                : {}),
            ...(billing ? { billing } : {}),
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          };
          baseUrlConfigKey = "model_providers.naia.base_url";
          childEnv = codexWorkerEnv(sourceEnv, {
            codexHome: managedCodexHome,
            bridgeEnvKey: "NAIA_BRIDGE_TOKEN",
            bridgeToken,
            allowBridgeEnvKey: true,
          });
          bridgeConfigArgs.push(
            "-c", 'model_provider="naia"',
            "-c", 'model_providers.naia.name="Naia Gateway"',
            "-c", 'model_providers.naia.wire_api="responses"',
            "-c", 'model_providers.naia.env_key="NAIA_BRIDGE_TOKEN"',
            "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`,
            "-c", "features.memory_tool=false",
          );
          if (effectiveModel === "motif-3") {
            bridgeConfigArgs.push("-c", `model_context_window=${NAIA_MODEL_METADATA["motif-3"].contextWindow}`);
          }
        } catch (e) {
          return endedSession(`naia codex configuration failed: ${(e as Error).message}`);
        }
      } else if (isUserOwnedRoute && opts.userOwnedProvider) {
        try {
          const userOwned = opts.userOwnedProvider;
          const declaredModel = userOwned.models.find((m) => m.id === effectiveModel)!;
          const configDir = ensureUserOwnedPiConfig(userOwned, configDirBase, { noTools: effectiveNoTools });
          const catalogPath = join(
            configDir,
            effectiveNoTools ? "codex-model-catalog-notools.json" : "codex-model-catalog.json",
          );
          const upstreamBaseUrl = normalizeLoopbackBaseUrl(userOwned.baseUrl);
          const finalUpstream = upstreamBaseUrl.endsWith("/v1") ? upstreamBaseUrl : `${upstreamBaseUrl}/v1`;
          bridgeOptions = {
            provider: userOwned.id,
            expectedModel: effectiveModel!,
            upstreamBaseUrl: finalUpstream,
            noTools: effectiveNoTools,
            maxOutputTokens: opts.maxOutputTokens ?? declaredModel.maxTokens,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          };
          baseUrlConfigKey = `model_providers.${userOwned.id}.base_url`;
          bridgeConfigArgs.push(
            "-c", `model_provider=${JSON.stringify(userOwned.id)}`,
            "-c", `model_providers.${userOwned.id}.name=${JSON.stringify(userOwned.id)}`,
            "-c", `model_providers.${userOwned.id}.wire_api="responses"`,
            "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`,
            "-c", "features.memory_tool=false",
          );
        } catch (e) {
          return endedSession(`user-owned codex configuration failed: ${(e as Error).message}`);
        }
      } else if (isLocalEngineRoute) {
        try {
          const modelSlug = effectiveModel ?? "local-default";
          const upstreamBaseUrl = resolveLocalEngineBaseUrl(rawProvider!, opts.baseUrl, sourceEnv);
          const configDir = configDirBase ?? join(task.workdir, ".naia-codex-local");
          const catalogPath = writeCodexModelCatalogFile(
            configDir,
            {
              models: [
                buildCodexModelCatalogEntry({
                  slug: modelSlug,
                  contextWindow: 65_536,
                  noTools: effectiveNoTools,
                }),
              ],
            },
            effectiveNoTools ? "codex-local-catalog-notools.json" : "codex-local-catalog.json",
          );
          bridgeOptions = {
            provider: providerLower!,
            expectedModel: modelSlug,
            upstreamBaseUrl,
            noTools: effectiveNoTools,
            ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
            ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
          };
          baseUrlConfigKey = "model_providers.local.base_url";
          bridgeConfigArgs.push(
            "-c", 'model_provider="local"',
            "-c", 'model_providers.local.name="Local Engine"',
            "-c", 'model_providers.local.wire_api="responses"',
            "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`,
            "-c", "features.memory_tool=false",
          );
        } catch (e) {
          return endedSession(`local codex configuration failed: ${(e as Error).message}`);
        }
      } else if (effectiveNoTools) {
        // 비브리지 openai-codex 경로에서도 noTools: true 요청 시 모델 카탈로그(shell_type:"disabled",
        // apply_patch_tool_type:null)와 8개 도구 비활성화 플래그를 함께 주입하여 도구 0개를 강제한다.
        try {
          const tmpBase = sourceEnv.TMPDIR || sourceEnv.TMP || sourceEnv.TEMP || tmpdir();
          const configDir = configDirBase ?? join(tmpBase, "naia-codex-catalog");
          const slugs = Array.from(new Set([effectiveModel ?? "gpt-5.4", "gpt-5.4", "codex-default"]));
          const catalogPath = writeCodexModelCatalogFile(
            configDir,
            {
              models: slugs.map((slug) =>
                buildCodexModelCatalogEntry({
                  slug,
                  contextWindow: 200_000,
                  noTools: true,
                }),
              ),
            },
            "codex-openai-catalog-notools.json",
          );
          bridgeConfigArgs.push(
            "-c", `model_catalog_json=${JSON.stringify(catalogPath)}`,
            "-c", "features.memory_tool=false",
          );
        } catch (e) {
          return endedSession(`codex noTools catalog configuration failed: ${(e as Error).message}`);
        }
      }

      if (effectiveNoTools) {
        bridgeConfigArgs.push(...CODEX_NO_TOOLS_CONFIG_FLAGS);
      }

      let threadId: string | undefined;
      const reconcileBridgeFailure = (reason: string): SubAgentEvent | readonly SubAgentEvent[] => {
        if (isNaiaRoute && receiptPath) {
          try {
            const journal = readNaiaPiReceiptJournal(receiptPath, executionId);
            if (journal.entries.length > 0) {
              const gatewayBillingReceipts = journal.entries.map((entry) => entry.receipt);
              const measuredCostUsd = sumGatewayCustomerCost(gatewayBillingReceipts);
              const inputTokens = gatewayBillingReceipts.reduce((s, r) => s + r.inputTokens, 0);
              const cachedInputTokens = gatewayBillingReceipts.reduce((s, r) => s + r.cachedInputTokens, 0);
              const outputTokens = gatewayBillingReceipts.reduce((s, r) => s + r.outputTokens, 0);
              const totalTokens = gatewayBillingReceipts.reduce((s, r) => s + r.totalTokens, 0);
              const selectedModel = gatewayBillingReceipts.at(-1)?.responseModel ?? (effectiveModel ?? "codex-default");
              const estimatedCostUsd = estimateNaiaModelCostUsd(
                selectedModel,
                inputTokens,
                cachedInputTokens,
                outputTokens,
              );
              const evidence: import("../domain/orchestration.js").SubAgentModelEvidence = {
                provider: NAIA_PI_PROVIDER,
                selectedModel,
                modelEvidenceSource: "provider_reported",
                ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
                inputTokens,
                cachedInputTokens,
                outputTokens,
                totalTokens,
                usageAvailable: true,
                sessionId: threadId ?? executionId,
                executionId,
                ...(estimatedCostUsd !== undefined ? { estimatedCostUsd, piEstimatedCost: estimatedCostUsd } : {}),
                measuredCostUsd,
                gatewayBillingReceipts,
              };
              return [
                { kind: "model_evidence", evidence },
                { kind: "session_end", ok: false, reason, evidence },
              ];
            }
          } catch {
            /* preserve original failure reason if receipt journal cannot be read */
          }
        }
        return { kind: "session_end", ok: false, reason };
      };

      const makeLineToEvent = (bridge?: CodexResponsesBridgeHandle) => (line: string): SubAgentEvent | readonly SubAgentEvent[] | null => {
        let raw: RawCodexEvent | undefined;
        try { raw = JSON.parse(line) as RawCodexEvent; } catch { /* base parser handles malformed input */ }
        if (raw?.type === "thread.started" && typeof raw.thread_id === "string") threadId = raw.thread_id;
        if ((raw?.type === "turn.failed" || raw?.type === "error") && isBridgedRoute && bridge) {
          const defaultReason = `codex ${raw.type}: ${codexFailureClass(raw)}`;
          const reason = bridge.lastError ? `codex bridge error: ${bridge.lastError}` : defaultReason;
          return reconcileBridgeFailure(reason);
        }
        if (raw?.type === "turn.completed") {
          const usage = validUsage(raw.usage);
          let inputTokens = usage?.inputTokens ?? 0;
          let cachedInputTokens = usage?.cachedInputTokens ?? 0;
          let outputTokens = usage?.outputTokens ?? 0;
          let totalTokens = inputTokens + outputTokens;

          if (isBridgedRoute && bridge) {
            if (bridge.lastError) {
              return reconcileBridgeFailure(`codex bridge error: ${bridge.lastError}`);
            }
            const reportedProvider = isNaiaRoute
              ? NAIA_PI_PROVIDER
              : isUserOwnedRoute && opts.userOwnedProvider
                ? opts.userOwnedProvider.id
                : (providerLower ?? "local");
            const expectedModelName = effectiveModel ?? "codex-default";
            let gatewayBillingReceipts: readonly import("../domain/orchestration.js").GatewayBillingReceipt[] | undefined;
            let measuredCostUsd: number | undefined;

            if (bridge.turns.length > 0) {
              for (const turn of bridge.turns) {
                if (turn.responseModel.toLowerCase() !== expectedModelName.toLowerCase()) {
                  return {
                    kind: "session_end",
                    ok: false,
                    reason: `codex model mismatch: expected ${reportedProvider}/${expectedModelName}, provider reported ${turn.responseModel}`,
                  };
                }
              }
              const bridgeUncachedInput = bridge.turns.reduce((s, t) => s + t.inputTokens, 0);
              const bridgeCachedInput = bridge.turns.reduce((s, t) => s + t.cachedInputTokens, 0);
              const bridgeOutput = bridge.turns.reduce((s, t) => s + t.outputTokens, 0);
              const bridgeTotal = bridge.turns.reduce((s, t) => s + t.totalTokens, 0);
              if (!usage) {
                inputTokens = bridgeUncachedInput;
                cachedInputTokens = bridgeCachedInput;
                outputTokens = bridgeOutput;
                totalTokens = bridgeTotal;
              } else {
                inputTokens = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
                cachedInputTokens = usage.cachedInputTokens;
                outputTokens = usage.outputTokens;
                totalTokens = usage.inputTokens + usage.outputTokens;
              }
            }

            if (isNaiaRoute && receiptPath) {
              try {
                const journal = readNaiaPiReceiptJournal(receiptPath, executionId);
                if (bridge.turns.length > 0 || journal.entries.length > 0) {
                  if (journal.entries.length !== bridge.turns.length) {
                    throw new Error("receipt count does not match Codex provider turns");
                  }
                  const latest = journal.entries.at(-1)!.receipt;
                  if (latest.provider !== NAIA_PI_PROVIDER || latest.model !== expectedModelName) {
                    throw new Error("receipt route does not match Codex model evidence");
                  }
                  gatewayBillingReceipts = journal.entries.map((entry) => entry.receipt);
                  measuredCostUsd = sumGatewayCustomerCost(gatewayBillingReceipts);
                }
              } catch (error) {
                return {
                  kind: "session_end",
                  ok: false,
                  reason: `Naia billing receipt unavailable: ${error instanceof Error ? error.message : String(error)}`,
                };
              }
            }

            const selectedModel = bridge.turns.at(-1)?.responseModel ?? expectedModelName;
            const estimatedCostUsd = isNaiaRoute
              ? estimateNaiaModelCostUsd(selectedModel, inputTokens, cachedInputTokens, outputTokens)
              : 0;
            const evidence: import("../domain/orchestration.js").SubAgentModelEvidence = {
              provider: reportedProvider,
              selectedModel,
              modelEvidenceSource: bridge.turns.length > 0 ? "provider_reported" : "adapter_requested",
              ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
              inputTokens,
              cachedInputTokens,
              outputTokens,
              totalTokens,
              usageAvailable: Boolean(usage) || bridge.turns.length > 0,
              sessionId: threadId ?? executionId,
              executionId,
              ...(estimatedCostUsd !== undefined ? { estimatedCostUsd, piEstimatedCost: estimatedCostUsd } : {}),
              ...(measuredCostUsd !== undefined ? { measuredCostUsd } : {}),
              ...(gatewayBillingReceipts ? { gatewayBillingReceipts } : {}),
            };
            return [
              { kind: "model_evidence", evidence },
              { kind: "session_end", ok: true, reason: "codex turn.completed", evidence },
            ];
          }

          const measuredCostUsd = opts.priceUsdPerMillion && usage
            && (opts.maximumPricedInputTokens === undefined || inputTokens <= opts.maximumPricedInputTokens)
            ? ((Math.max(0, inputTokens - cachedInputTokens) * opts.priceUsdPerMillion.uncachedInput)
              + (cachedInputTokens * opts.priceUsdPerMillion.cachedInput)
              + (outputTokens * opts.priceUsdPerMillion.output)) / 1_000_000
            : undefined;
          return {
            kind: "session_end", ok: true, reason: "codex turn.completed",
            evidence: {
              provider: rawProvider ?? "openai-codex", selectedModel: effectiveModel ?? "codex-default",
              modelEvidenceSource: "adapter_requested",
              ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
              inputTokens, cachedInputTokens, outputTokens, totalTokens,
              usageAvailable: Boolean(usage),
              sessionId: threadId ?? executionId, executionId,
              ...(measuredCostUsd !== undefined ? { measuredCostUsd } : {}),
            },
          };
        }
        return codexLineToEvent(line);
      };

      const sandbox =
        effectiveNoTools || task.filesystemAccess === "read_only"
          ? "read-only"
          : "workspace-write";
      const buildSpawnArgs = (extraConfigArgs: readonly string[]): string[] => {
        // 관리형 CODEX_HOME(빈 config.toml + auth.json 심볼릭 링크)과 --ignore-user-config를 함께 강제해
        // 사용자 ~/.codex/config.toml(MCP 서버·모델 덮어쓰기 등)이 섞이지 않게 한다.
        const args: string[] = [
          "exec", "--json",
          "--ignore-user-config",
          "--sandbox", sandbox,
          "--config", 'approval_policy="never"',
          "--ephemeral",
        ];
        if (skipGit) args.push("--skip-git-repo-check");
        if (effectiveModel) args.push("--model", effectiveModel);
        if (opts.reasoningEffort) args.push("--config", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
        if (extraConfigArgs.length > 0) args.push(...extraConfigArgs);
        args.push("--cd", task.workdir);
        args.push(task.prompt);
        return args;
      };

      if (!isBridgedRoute || !bridgeOptions || !baseUrlConfigKey) {
        return spawnSubprocessSession({
          spawnFn,
          bin,
          args: buildSpawnArgs(bridgeConfigArgs),
          cwd: task.workdir,
          env: childEnv,
          hardKillMs,
          lineToEvent: makeLineToEvent(undefined),
          label: "codex",
          diagnostics: true,
          terminateOnProtocolEnd: true,
        });
      }

      const routeLabel = isNaiaRoute ? "naia" : isUserOwnedRoute ? "user-owned" : "local";
      const pending = (async (): Promise<
        | { readonly ok: true; readonly session: SubAgentSession; readonly bridge: CodexResponsesBridgeHandle }
        | { readonly ok: false; readonly session: SubAgentSession }
      > => {
        let activeBridge: CodexResponsesBridgeHandle | undefined;
        try {
          activeBridge = await startCodexResponsesLoopbackBridge(bridgeOptions);
          const finalBridgeConfigArgs = [
            ...bridgeConfigArgs,
            "-c", `${baseUrlConfigKey}=${JSON.stringify(activeBridge.baseUrl)}`,
          ];
          const session = spawnSubprocessSession({
            spawnFn,
            bin,
            args: buildSpawnArgs(finalBridgeConfigArgs),
            cwd: task.workdir,
            env: childEnv,
            hardKillMs,
            lineToEvent: makeLineToEvent(activeBridge),
            label: "codex",
            diagnostics: true,
            terminateOnProtocolEnd: true,
          });
          return { ok: true, session, bridge: activeBridge };
        } catch (e) {
          activeBridge?.close();
          return {
            ok: false,
            session: endedSession(`${routeLabel} codex configuration failed: ${(e as Error).message}`),
          };
        }
      })();

      return {
        events: {
          async *[Symbol.asyncIterator](): AsyncIterator<SubAgentEvent> {
            const started = await pending;
            if (!started.ok) {
              for await (const ev of started.session.events) {
                yield ev;
              }
              return;
            }
            try {
              for await (const ev of started.session.events) {
                yield ev;
              }
            } finally {
              started.bridge.close();
            }
          },
        },
        async cancel(reason?: string): Promise<void> {
          const started = await pending;
          if (!started.ok) {
            await started.session.cancel(reason ?? "cancelled");
            return;
          }
          try {
            await started.session.cancel(reason ?? "cancelled");
          } finally {
            started.bridge.close();
          }
        },
      };
    },
  };
}

function validUsage(value: RawCodexEvent["usage"]): { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined {
  if (!value) return undefined;
  const fields = [value.input_tokens, value.cached_input_tokens, value.output_tokens];
  if (fields.some((field) => typeof field !== "number" || !Number.isSafeInteger(field) || field < 0)) return undefined;
  const [inputTokens, cachedInputTokens, outputTokens] = fields as number[];
  if (cachedInputTokens > inputTokens) return undefined;
  return { inputTokens, cachedInputTokens, outputTokens };
}
