// app/memory-surfacer — background small-LLM memory/knowledge surfacing (nextain/naia-shell#692).
import type { ChatMessage } from "../domain/chat.js";
import type { DiagnosticLog } from "../ports/uc1.js";
import type { MemoryPort } from "../ports/memory.js";
import type { SurfacingPort, SurfacingSnapshot } from "../ports/surfacing.js";
import {
  SURFACING_LIMITS,
  buildKnowledgeCandidates,
  buildMemoryCandidates,
  buildSurfacingMessages,
  formatSurfacedBlock,
  normalizeSurfacingTurns,
  parseSurfacingResponse,
  surfacingQuery,
  type SurfacingKnowledgeHit,
  type SurfacingTurn,
} from "../domain/surfacing.js";
import type { RecalledMemory } from "../domain/memory.js";

export interface SurfacingLlm {
  readonly provider: string;
  readonly model?: string;
  completeMessages(
    messages: readonly ChatMessage[],
    opts: {
      readonly signal?: AbortSignal;
      readonly authorizeAndDisclose?: (input: {
        workload: "sub_llm";
        provider: string;
        model: string;
        endpoint: string;
      }) => Promise<boolean>;
    },
  ): Promise<string>;
}

export interface SurfacingKnowledgeSource {
  search(query: string, k?: number): Promise<readonly SurfacingKnowledgeHit[]>;
}

export interface MemorySurfacerDeps {
  readonly memory: Pick<MemoryPort, "recall">;
  readonly knowledge?: SurfacingKnowledgeSource;
  /** Current small LLM, re-read on every schedule; undefined = surfacing off. */
  readonly llm: () => SurfacingLlm | undefined;
  readonly diag: DiagnosticLog;
  readonly now?: () => number; // default Date.now
  readonly timeoutMs?: number; // default 8000 (whole job)
  readonly ttlMs?: number; // default 15 * 60_000
  readonly modelUnavailableBackoffMs?: number; // default 10 * 60_000
  readonly maxSessions?: number; // default 32
}

export function isModelUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { status?: unknown; message?: unknown };
  let status: number | undefined = typeof err.status === "number" ? err.status : undefined;
  const message = typeof err.message === "string" ? err.message : "";
  if (status === undefined && message) {
    const m = /HTTP\s+(\d{3})/i.exec(message);
    if (m) status = Number(m[1]);
  }
  if (status === 404) return true;
  if (status === 400 || status === 422) {
    const hasModel = /model/i.test(message);
    const hasNotFound =
      /(not found|does not exist|unknown|unsupported|invalid|not available|no such|could not be inferred|missing a provider prefix|not deployed|no route)/i.test(
        message,
      );
    if (hasModel && hasNotFound) return true;
  }
  return false;
}

function raceSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort);
    p.then(
      (val) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    ).catch(() => {});
  });
}

export function makeMemorySurfacer(deps: MemorySurfacerDeps): SurfacingPort {
  let closed = false;
  const results = new Map<string, { snapshot: SurfacingSnapshot; at: number }>();
  const running = new Map<string, { controller: AbortController; gen: number; promise: Promise<void> }>();
  const generation = new Map<string, number>();
  let unavailableUntil = 0;
  let unavailableLogged = false;

  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? 8000;
  const ttlMs = deps.ttlMs ?? 15 * 60_000;
  const modelUnavailableBackoffMs = deps.modelUnavailableBackoffMs ?? 10 * 60_000;
  const maxSessions = deps.maxSessions ?? 32;

  function storeSnapshot(sessionId: string, gen: number, snapshot: SurfacingSnapshot): void {
    if (closed) return;
    if (generation.get(sessionId) !== gen) return;

    if (results.has(sessionId)) {
      results.delete(sessionId);
    } else if (results.size >= maxSessions) {
      const oldestKey = results.keys().next().value;
      if (oldestKey !== undefined) results.delete(oldestKey);
    }
    results.set(sessionId, { snapshot, at: now() });
  }

  return {
    active(): boolean {
      return !closed && deps.llm() !== undefined;
    },

    consume(sessionId: string): SurfacingSnapshot | undefined {
      try {
        const activeJob = running.get(sessionId);
        if (activeJob) {
          activeJob.controller.abort();
          running.delete(sessionId);
        }
        const nextGen = (generation.get(sessionId) ?? 0) + 1;
        generation.set(sessionId, nextGen);

        const stored = results.get(sessionId);
        if (!stored) return undefined;
        results.delete(sessionId);
        if (now() - stored.at > ttlMs) return undefined;
        return stored.snapshot;
      } catch {
        return undefined;
      }
    },

    schedule(input: { readonly sessionId: string; readonly turns: readonly SurfacingTurn[] }): void {
      try {
        if (closed) return;
        const llm = deps.llm();
        if (!llm) return;
        if (now() < unavailableUntil) return;

        const normalized = normalizeSurfacingTurns(input.turns);
        const query = surfacingQuery(normalized);
        if (!query) return;

        const activeJob = running.get(input.sessionId);
        if (activeJob) {
          activeJob.controller.abort();
          running.delete(input.sessionId);
        }
        const gen = (generation.get(input.sessionId) ?? 0) + 1;
        generation.set(input.sessionId, gen);
        results.delete(input.sessionId);

        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
        timer.unref?.();

        const signal = controller.signal;
        const started = now();

        const jobPromise = (async () => {
          try {
            let mem: RecalledMemory | undefined;
            try {
              mem = await raceSignal(deps.memory.recall(query), signal);
            } catch (e) {
              if (signal.aborted) throw e;
              mem = undefined;
              deps.diag.debug?.("memory surfacing: recall failed", e instanceof Error ? e.message : String(e));
            }

            let hits: readonly SurfacingKnowledgeHit[] = [];
            if (deps.knowledge) {
              try {
                hits = await raceSignal(
                  deps.knowledge.search(query, SURFACING_LIMITS.maxKnowledgeCandidates),
                  signal,
                );
              } catch (e) {
                if (signal.aborted) throw e;
                hits = [];
              }
            }

            if (signal.aborted) throw new Error("aborted");

            const rawTurns = (Array.isArray(input.turns) ? input.turns : []).slice(-SURFACING_LIMITS.maxTurns);
            const memoryCandidates = buildMemoryCandidates(mem, rawTurns);
            const knowledgeCandidates = buildKnowledgeCandidates(hits);
            const candidates = [...memoryCandidates, ...knowledgeCandidates];

            if (candidates.length === 0) {
              storeSnapshot(input.sessionId, gen, {
                block: "",
                judgedKeys: new Set(),
                surfacedCount: 0,
              });
              deps.diag.debug?.("memory surfacing: no candidates", { ms: now() - started });
              return;
            }

            const messages = buildSurfacingMessages(normalized, candidates);
            const raw = await llm.completeMessages(messages, {
              signal,
              authorizeAndDisclose: async () => true,
            });

            const parsed = parseSurfacingResponse(raw, candidates);
            if (!parsed.ok) {
              deps.diag.log("memory surfacing failed (next turn uses recall)", {
                provider: llm.provider,
                model: llm.model,
                error: parsed.error,
              });
              return;
            }

            const block = formatSurfacedBlock(parsed.items);
            const snapshot: SurfacingSnapshot = {
              block,
              judgedKeys: new Set(memoryCandidates.map((c) => c.key)),
              surfacedCount: parsed.items.length,
            };

            storeSnapshot(input.sessionId, gen, snapshot);
            deps.diag.debug?.("memory surfacing ready", {
              provider: llm.provider,
              model: llm.model,
              memoryCandidates: memoryCandidates.length,
              knowledgeCandidates: knowledgeCandidates.length,
              surfaced: parsed.items.length,
              ms: now() - started,
            });
            unavailableLogged = false;
          } catch (e) {
            if (signal.aborted) {
              if (timedOut) {
                deps.diag.log("memory surfacing failed (next turn uses recall)", {
                  provider: llm.provider,
                  model: llm.model,
                  error: `timeout after ${timeoutMs}ms`,
                });
              } else {
                deps.diag.debug?.("memory surfacing aborted", { sessionId: input.sessionId, gen });
              }
              return;
            }
            if (isModelUnavailableError(e)) {
              unavailableUntil = now() + modelUnavailableBackoffMs;
              if (!unavailableLogged) {
                deps.diag.log(
                  "memory surfacing paused: the small LLM model is not available on the gateway; recall injection continues",
                  { provider: llm.provider, model: llm.model, retryInMs: modelUnavailableBackoffMs },
                );
                unavailableLogged = true;
              }
            } else {
              const rawMsg = e instanceof Error ? e.message : String(e);
              const cleanMsg = rawMsg.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
              deps.diag.log("memory surfacing failed (next turn uses recall)", {
                provider: llm.provider,
                model: llm.model,
                error: cleanMsg,
              });
            }
          } finally {
            clearTimeout(timer);
            const current = running.get(input.sessionId);
            if (current && current.gen === gen) {
              running.delete(input.sessionId);
            }
          }
        })();

        running.set(input.sessionId, { controller, gen, promise: jobPromise });
      } catch (e) {
        deps.diag.log("memory surfacing schedule failed", e instanceof Error ? e.message : String(e));
      }
    },

    async close(): Promise<void> {
      closed = true;
      for (const { controller } of running.values()) {
        controller.abort();
      }
      const promises = Array.from(running.values()).map((r) => r.promise);
      await Promise.allSettled(promises);
      running.clear();
      results.clear();
      generation.clear();
    },
  };
}
