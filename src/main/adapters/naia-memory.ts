// adapters — MemoryPort 구현 (UC-memory FR-MEM-4). 실 @nextain/naia-memory 래핑.
// recall = 시맨틱/키워드 검색 결과의 *원문*(facts/episodes content)을 반환 — 프롬프트 프레이밍·예산
// 절단은 domain formatRecalledMemory 소유(adapter 는 데이터만). save = user/assistant encode.
import {
  buildLLMFactExtractor,
  buildLLMSummarizer,
  LocalAdapter,
  MemorySystem,
  NaiaGatewayEmbeddingProvider,
  OfflineEmbeddingProvider,
  OpenAICompatEmbeddingProvider,
} from "@nextain/naia-memory";
import type { CompactionSummarizer, EmbeddingProvider, ExtractedFact, FactExtractor } from "@nextain/naia-memory";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ManagedMemoryPort, MemoryRecallOptions } from "../ports/memory.js";
import type { CompactionPort, CompactionRequest, CompactionResult, HandoffBlob } from "../ports/compaction.js";
import { maskSecretShapes, type RecalledMemory } from "../domain/memory.js";

const QUERY_CAP = 4000;   // recall query 입력 상한(embedding 비용 bound).
const SAVE_CAP = 20000;   // save 원문(턴당, user/assistant 각각) 상한(디스크/flush 비용 bound).
const RECAP_CAP = 20000;  // recap(요약) 반환·영속 상한 — 거대 요약이 systemPrompt/디스크를 폭증시키는 것 차단.
const ANCHOR_MAX = 32;    // 영속 anchor 개수 상한.
const ANCHOR_CAP = 512;   // anchor 1개 길이 상한.
// must stay well below the chat turn's 5 s recall deadline (`MEM_RECALL_TIMEOUT_MS` in chat-turn-handler) so a turn during a long first-time preparation still answers quickly, while normal fast opens (keyword-only, already-indexed stores) are unaffected.
const MEMORY_PREPARING_GRACE_MS = 2000;
/** 입력 문자열 상한 절단(초과 시 표식). 거대 입력이 backend 비용을 폭증시키는 것 차단. */
function capInput(s: string, max: number): string {
  const t = String(s ?? "");
  return t.length <= max ? t : `${t.slice(0, max)} …[절단됨]`;
}

function describeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error ?? "");
  if (error && typeof error === "object" && "cause" in error) {
    const cause = (error as { cause: unknown }).cause;
    if (cause instanceof Error) {
      message += `; cause: ${cause.message}`;
    } else if (typeof cause === "string" && cause) {
      message += `; cause: ${cause}`;
    }
  }
  return message.replace(/\r?\n/g, " ").slice(0, 500);
}

/** naia-memory joins `${baseURL}chat/completions` without a separator — the base URL must end with exactly one "/". */
export function memoryLlmBaseUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/`;
}

/** FR-MEM-15 (#108, naia-shell#425): 로컬 기억 저장 경로의 명시 해석.
 *  비어있지 않은 `NAIA_HOME` 이 `~/.naia` 를 대체한다 — 격리된 dev 인스턴스(Naia Dev,
 *  NAIA_HOME=~/.naia-dev)의 agent 가 운영 기억(naia-memory.json)을 오염시키지 않도록,
 *  패키지 기본값에 맡기지 않고 agent 가 항상 명시 경로를 LocalAdapter 에 전달한다.
 *  미지정 기본값은 기존 패키지 기본(~/.naia/memory/naia-memory.json)과 동일(무회귀). */
export function naiaMemoryDefaultStorePath(
  overrideHome: string | undefined = process.env.NAIA_HOME,
): string {
  const trimmed = overrideHome?.trim();
  const home = trimmed ? trimmed : join(homedir(), ".naia");
  return join(home, "memory", "naia-memory.json");
}

export interface NaiaMemoryOpts {
  /** project 스코프(회상 격리) — **필수**. 한 agent 프로세스 = 한 사용자/워크스페이스. fallback "default"
   *  를 두면 project 누락 호출이 조용히 같은 키를 공유해 워크스페이스 간 교차 누설(FR-MEM-5/9 위반)되므로
   *  타입으로 강제한다. 진입점은 workspace(NAIA_ADK_PATH 정규화) 유도값을 넘긴다. */
  readonly project: string;
  /** 영속 store 경로. 미지정 시 naia-memory 기본(~/.naia/memory/...). 테스트는 temp 경로. */
  readonly storePath?: string;
  /** 세션 id(encode provenance). recall 정확성은 session 순서에 무관(content+project 기반). */
  readonly sessionId?: string;
  /** 회상 topK. */
  readonly topK?: number;
  /** 회상 스코프 모드. 기본 "strict" = project 경계로 격리(naia-memory 기본값 "soft" 는 타 project
   *  episode/fact 까지 누설하므로 격리 계약을 위반한다). cross-project 회상이 필요할 때만 "soft". */
  readonly scopeMode?: "strict" | "soft";
  /** 저장소 adapter. 미지정/"local" = LocalAdapter(JSON store, 기본·무회귀). "qdrant" = QdrantAdapter
   *  (외부 벡터DB, embedding 필수). issue #7: os 메모리 UI 의 memoryAdapter 선택을 런타임에 반영. */
  readonly adapter?: "local" | "qdrant";
  /** qdrant adapter 접속 URL(adapter="qdrant" 시 필수). */
  readonly qdrantUrl?: string;
  /** qdrant cloud API key(로컬 qdrant 는 불요). */
  readonly qdrantApiKey?: string;
  /** 임베딩 provider 설정. 미지정/provider="none" = 키워드-only(기존 동작). 지정 시 벡터 시맨틱 검색 활성.
   *  LocalAdapter 는 옵션(없으면 키워드-only), QdrantAdapter 는 필수. */
  readonly embedding?: MemoryEmbeddingConfig;
  /** 메모리 LLM(사실추출 factExtractor). 미지정/provider="none" = 휴리스틱 추출(기존 동작·무회귀).
   *  지정 시 LLM 기반 atomic 사실추출. compaction summarizer 는 별개(빌더 없음 → 결정론 recap 유지). issue #7. */
  readonly llm?: MemoryLlmConfig;
  /** Agent가 provider/auth를 해석해 만든 좁은 포트. 지정하면 legacy llm config보다 우선한다. */
  readonly factExtractor?: FactExtractor;
  readonly summarizer?: CompactionSummarizer;
  /** Test/advanced: skip MemoryEmbeddingConfig and inject a ready provider. */
  readonly embeddingProvider?: EmbeddingProvider;
  /** Observes product-path embedding reindex at adapter open. */
  readonly onEmbeddingReindex?: (event: {
    readonly phase: "start" | "done" | "failed";
    readonly reason: string;
    readonly error?: string;
  }) => void;
  /** Background consolidation (episode → fact extraction). Absent/false = never runs (default; tests and CLI).
   *  The product path enables it only when an LLM memory role is configured. */
  readonly consolidation?: false | { readonly initialDelayMs?: number; readonly intervalMs?: number };
  /** Observes each consolidation run (scheduled or manual). Never receives secrets. */
  readonly onConsolidation?: (event: MemoryConsolidationEvent) => void;
}

export type MemoryConsolidationEvent =
  | { readonly phase: "done"; readonly episodesProcessed: number; readonly factsCreated: number; readonly factsUpdated: number }
  | { readonly phase: "failed"; readonly error: string };
export const MEMORY_CONSOLIDATION_DEFAULT_INITIAL_DELAY_MS = 60_000;
export const MEMORY_CONSOLIDATION_DEFAULT_INTERVAL_MS = 30 * 60_000;

/** 메모리 LLM(사실추출) 선택 — os 메모리 UI(memoryLlmProvider 등). baseUrl/apiKey/model 은 provider 별로
 *  loadMemoryConfig 가 정규화(naia=게이트웨이, vllm/ollama=로컬). buildMemoryFactExtractor 는 OpenAI-compat 단일 경로. */
export interface MemoryLlmConfig {
  /** provider 선택은 Agent registry 소유. naia-memory에는 생성된 좁은 포트를 주입하는 방향으로 이행한다. */
  readonly provider: string;
  /** OpenAI-compat chat/completions base URL(provider!="none" 필수, /chat/completions 제외). */
  readonly baseUrl?: string;
  /** API key(로컬 서버는 빈 값 허용; naia=게이트웨이 키). */
  readonly apiKey?: string;
  /** OpenAI 호환 전송 인증. Naia/AnyLLM gateway는 x-anyllm, 나머지는 bearer. */
  readonly auth?: "bearer" | "x-anyllm";
  /** 모델명(provider!="none" 필수). */
  readonly model?: string;
}

/** MemoryLlmConfig → FactExtractor(또는 undefined=휴리스틱). 순수·테스트 가능. baseUrl·model 누락 = fail-closed
 *  throw(makeNaiaMemory 가 catch→기억 없이 격리). vllm/ollama/naia 모두 OpenAI-compat 단일 경로(buildLLMFactExtractor).
 *  failurePolicy: "throw" — a failed batch throws so consolidateNow does not mark those episodes consolidated; they are retried on the next cycle. */
export function buildMemoryFactExtractor(cfg?: MemoryLlmConfig): FactExtractor | undefined {
  if (!cfg || cfg.provider === "none") return undefined;
  if (!cfg.baseUrl?.trim() || !cfg.model?.trim()) {
    throw new Error(`memory llm(${cfg.provider}): baseUrl·model 은 필수다.`);
  }
  const options = {
    apiKey: cfg.apiKey ?? "",
    baseURL: memoryLlmBaseUrl(cfg.baseUrl),
    model: cfg.model,
    auth: cfg.auth ?? (cfg.provider === "naia" || cfg.provider === "nextain" ? "x-anyllm" : "bearer"),
    failurePolicy: "throw",
  } as Parameters<typeof buildLLMFactExtractor>[0] & { auth?: "bearer" | "x-anyllm" };
  return buildLLMFactExtractor(options);
}

/** MemoryLlmConfig → CompactionSummarizer(또는 undefined=결정론 recap). factExtractor 와 같은 small-LLM 설정
 *  사용 — 사용자 비전 "라이트 모델이 요약작업". compaction recap 을 LLM 으로 polish, 실패 시 결정론 폴백(무손실). */
export function buildMemorySummarizer(cfg?: MemoryLlmConfig): CompactionSummarizer | undefined {
  if (!cfg || cfg.provider === "none") return undefined;
  if (!cfg.baseUrl?.trim() || !cfg.model?.trim()) {
    throw new Error(`memory llm(${cfg.provider}): baseUrl·model 은 필수다(summarizer).`);
  }
  const options = {
    apiKey: cfg.apiKey ?? "",
    baseURL: memoryLlmBaseUrl(cfg.baseUrl),
    model: cfg.model,
    auth: cfg.auth ?? (cfg.provider === "naia" || cfg.provider === "nextain" ? "x-anyllm" : "bearer"),
  } as Parameters<typeof buildLLMSummarizer>[0] & { auth?: "bearer" | "x-anyllm" };
  return buildLLMSummarizer(options);
}

/** 임베딩 provider 선택 — os 메모리 UI(memoryEmbeddingProvider 등)에서 유도. */
export interface MemoryEmbeddingConfig {
  /** none=키워드-only / offline=로컬 transformers / vllm·ollama=OpenAI-compat / naia=게이트웨이. */
  readonly provider: "none" | "offline" | "vllm" | "ollama" | "naia";
  /** offline 모델(provider="offline"). 기본 all-MiniLM-L6-v2.
   *  다국어(한국어): multilingual-e5-large(1024d) · paraphrase-multilingual-MiniLM-L12-v2(384d, 경량). */
  readonly offlineModel?:
    | "all-MiniLM-L6-v2"
    | "all-mpnet-base-v2"
    | "multilingual-e5-large"
    | "paraphrase-multilingual-MiniLM-L12-v2";
  /** naia-embedded 컴퓨트 device(provider="offline" 만 의미). "cpu"=강제CPU / "gpu"=가용시GPU(없으면 CPU 폴백)
   *  / "auto"=자동. 미지정=transformers 기본. issue #7 후속(컴퓨트 선택). */
  readonly device?: "cpu" | "gpu" | "auto";
  /** OpenAI-compat base URL(provider="vllm"|"ollama" 필수). */
  readonly baseUrl?: string;
  /** OpenAI-compat API key(provider="vllm"|"ollama"; 로컬 서버는 보통 빈 값 허용). */
  readonly apiKey?: string;
  /** OpenAI-compat 임베딩 모델명(provider="vllm"|"ollama" 필수). */
  readonly model?: string;
  /** naia 게이트웨이 URL(provider="naia" 필수). */
  readonly naiaGatewayUrl?: string;
  /** naia 게이트웨이 키(provider="naia" 필수). */
  readonly naiaKey?: string;
}

/** MemoryEmbeddingConfig → EmbeddingProvider 인스턴스(또는 undefined=키워드-only). 순수·테스트 가능
 *  (adapter 선택과 분리). provider 별 필수 필드 누락은 fail-closed(throw) — 잘못 구성된 임베딩이 조용히
 *  키워드-only 로 축약돼 "벡터 검색 됨"으로 오인되는 것 차단(makeNaiaMemory 가 catch→격리). */
export function buildEmbeddingProvider(cfg?: MemoryEmbeddingConfig): EmbeddingProvider | undefined {
  if (!cfg || cfg.provider === "none") return undefined;
  switch (cfg.provider) {
    case "offline":
      // naia-memory runtime은 임의 Xenova/<modelName> 문자열과 384d fallback을 처리하지만 현재 생성자
      // declaration union이 paraphrase-multilingual을 아직 누락했다. 이 adapter의 검증된 closed union만
      // 넘기므로 declaration의 가장 넓은 384d member로 좁혀 타입 드리프트를 격리한다.
      return new OfflineEmbeddingProvider(
        (cfg.offlineModel ?? "all-MiniLM-L6-v2") as "all-MiniLM-L6-v2",
        cfg.device,
      );
    case "vllm":
    case "ollama": {
      if (!cfg.baseUrl?.trim() || !cfg.model?.trim()) {
        throw new Error(`memory embedding(${cfg.provider}): baseUrl·model 은 필수다.`);
      }
      return new OpenAICompatEmbeddingProvider(cfg.baseUrl, cfg.apiKey ?? "", cfg.model);
    }
    case "naia": {
      if (!cfg.naiaGatewayUrl?.trim() || !cfg.naiaKey?.trim()) {
        throw new Error("memory embedding(naia): naiaGatewayUrl·naiaKey 는 필수다.");
      }
      return new NaiaGatewayEmbeddingProvider(cfg.naiaGatewayUrl, cfg.naiaKey);
    }
    default:
      return undefined;
  }
}

/** MemoryPort 어댑터 + lifecycle close. */
export interface ReadyManagedMemoryPort extends ManagedMemoryPort, CompactionPort {
  ready(): Promise<void>;
  flush(): Promise<void>;
  /** Run one consolidation cycle now (single-flight with the scheduler). force=true skips naia-memory's 5-minute episode age gate. */
  consolidate(opts?: { force?: boolean }): Promise<MemoryConsolidationEvent>;
}

export function makeNaiaMemory(opts: NaiaMemoryOpts): ReadyManagedMemoryPort {
  let closed = false;
  const project = opts.project;
  // 타입(required string)만으론 ""·공백을 못 막는다 → 생성 경계에서 fail-closed(빈 project 가 backend
  // global/기본 scope 로 축약돼 격리를 우회하는 것 차단, FR-MEM-5/9).
  if (typeof project !== "string" || !project.trim()) {
    throw new Error("makeNaiaMemory: project 는 비어있지 않은 문자열이어야 한다(격리 키).");
  }
  const sessionId = opts.sessionId ?? "s1";
  // topK 는 외부 입력 → 유한 정수로 clamp(1..RAW_MAX_ITEMS). 거대/Infinity/NaN 이 backend 조회량·결과
  // 배열을 폭증시켜 formatter cap 전에 시간·메모리 bound 를 우회하는 것 차단. backend 호출·반환 slice 모두 사용.
  const RAW_MAX_ITEMS = 50;
  const rawTopK = Math.floor(Number(opts.topK ?? 5));
  const topK = Number.isFinite(rawTopK) ? Math.min(Math.max(1, rawTopK), RAW_MAX_ITEMS) : 5;
  const scopeMode = opts.scopeMode ?? "strict"; // project 경계 격리(누설 차단)
  // issue #7: os 메모리 UI 의 adapter/embedding 선택을 런타임에 반영(이전엔 LocalAdapter+키워드-only 하드코딩).
  // embedding 은 adapter 선택과 분리해 빌드(순수). provider 별 필수 누락 = throw(상위 entry 가 catch→기억 없이 격리).
  const embeddingProvider = opts.embeddingProvider ?? buildEmbeddingProvider(opts.embedding);
  const rawFactExtractor = opts.factExtractor ?? buildMemoryFactExtractor(opts.llm);
  const factExtractor: FactExtractor | undefined = rawFactExtractor
    ? async (episodes) => {
        const results: ExtractedFact[] = [];
        const CHUNK_SIZE = 10;
        for (let i = 0; i < episodes.length; i += CHUNK_SIZE) {
          if (closed) {
            throw new Error("memory closed during consolidation");
          }
          const chunk = episodes.slice(i, i + CHUNK_SIZE);
          const chunkResults = await rawFactExtractor(chunk);
          results.push(...chunkResults);
        }
        if (closed) {
          throw new Error("memory closed during consolidation");
        }
        return results;
      }
    : undefined;
  const summarizer = opts.summarizer ?? buildMemorySummarizer(opts.llm);
  let sys: MemorySystem;
  let localAdapter: LocalAdapter | null = null;
  if (opts.adapter === "qdrant") {
    // QdrantAdapter 는 embedding 필수(키워드-only 불가) — fail-closed.
    if (!embeddingProvider) {
      throw new Error("makeNaiaMemory: adapter='qdrant' 는 embedding 이 필수다(provider!='none').");
    }
    if (!opts.qdrantUrl?.trim()) {
      throw new Error("makeNaiaMemory: adapter='qdrant' 는 qdrantUrl 이 필수다.");
    }
    // collectionPrefix=project → qdrant collection 을 워크스페이스별 분리(격리, FR-MEM-5). MemorySystem 이
    // QdrantAdapter 생성 + initialize() 수행(qdrantOptions 경로).
    sys = new MemorySystem({
      qdrantOptions: {
        url: opts.qdrantUrl,
        ...(opts.qdrantApiKey ? { apiKey: opts.qdrantApiKey } : {}),
        collectionPrefix: project,
      },
      embeddingProvider,
      ...(factExtractor ? { factExtractor } : {}),
      ...(summarizer ? { summarizer } : {}),
    });
  } else {
    // local: storePath 제어 위해 LocalAdapter 직접 생성(MemorySystem 내부 빌드는 storePath 미지정). embeddingProvider
    // 는 LocalAdapter 에 직접 주입(MemorySystem 은 pre-built adapter 에 embedding 미전달 — index.ts:464 경로).
    localAdapter = new LocalAdapter({
      // FR-MEM-15: 항상 명시 storePath — NAIA_HOME 격리 존중(위 헬퍼 참조).
      storePath: opts.storePath ?? naiaMemoryDefaultStorePath(),
      ...(embeddingProvider
        ? { embeddingProvider, reindexEmbeddingsOnMismatch: true }
        : {}),
    });
    sys = new MemorySystem({
      adapter: localAdapter,
      ...(factExtractor ? { factExtractor } : {}),
      ...(summarizer ? { summarizer } : {}),
    });
  }
  // QdrantAdapter 는 비동기 initialize() 필요(recall/encode 는 내부적으로 _initPromise 대기 안 함).
  // LocalAdapter 는 즉시 열리지만, 제품 경로는 임베딩 공간 불일치 시 open 에서 재색인을 기다린다.
  // 재색인 실패는 ready 를 깨지 않는다 — 저장소가 빈 것이 아니므로 memory 를 끄지 않는다.
  const ready = (async () => {
    // init also awaits automatic reindex; capture the reason before it clears.
    const mismatchAtOpen = localAdapter?.getEmbeddingSpaceMismatch();
    if (mismatchAtOpen) opts.onEmbeddingReindex?.({ phase: "start", reason: mismatchAtOpen });
    await sys.init();
    if (!localAdapter) return;
    if (!mismatchAtOpen) {
      await localAdapter.whenReady();
      return;
    }
    await localAdapter.whenReady();
    if (localAdapter.getEmbeddingSpaceMismatch()) {
      const reindexError = (localAdapter as LocalAdapter & { getEmbeddingReindexError?: () => string | null }).getEmbeddingReindexError?.() ?? undefined;
      opts.onEmbeddingReindex?.({
        phase: "failed",
        reason: mismatchAtOpen,
        ...(reindexError ? { error: reindexError } : {}),
      });
      return;
    }
    opts.onEmbeddingReindex?.({ phase: "done", reason: mismatchAtOpen });
  })();
  let readySettled = false;
  ready.then(() => { readySettled = true; }, () => { readySettled = true; });
  ready.catch(() => {}); // floating unhandledRejection 차단 — 실패는 첫 작업의 await ready 에서 표면화(호출측 격리).

  let inFlight: Promise<MemoryConsolidationEvent> | undefined;
  const runConsolidation = (force: boolean): Promise<MemoryConsolidationEvent> => {
    if (inFlight) return inFlight;
    let run!: Promise<MemoryConsolidationEvent>;
    run = (async (): Promise<MemoryConsolidationEvent | undefined> => {
      try {
        await ready;
        if (closed) return undefined;
        const r = await sys.consolidateNow(force);
        if (closed) return undefined;
        return {
          phase: "done",
          episodesProcessed: Number(r?.episodesProcessed ?? 0),
          factsCreated: Number(r?.factsCreated ?? 0),
          factsUpdated: Number(r?.factsUpdated ?? 0),
        };
      } catch (error) {
        if (closed) return undefined;
        return { phase: "failed", error: describeError(error) };
      }
    })().then((event): MemoryConsolidationEvent => {
      if (!event) return { phase: "failed", error: "memory closed" };
      try { opts.onConsolidation?.(event); } catch { /* observer must not break memory */ }
      return event;
    }).finally(() => {
      if (inFlight === run) inFlight = undefined;
    });
    inFlight = run;
    return run;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.consolidation && typeof opts.consolidation === "object") {
    const rawInitial = opts.consolidation.initialDelayMs;
    const initialDelayMs =
      typeof rawInitial === "number" && Number.isFinite(rawInitial) && rawInitial >= 0
        ? Math.max(0, Math.floor(rawInitial))
        : MEMORY_CONSOLIDATION_DEFAULT_INITIAL_DELAY_MS;
    const rawInterval = opts.consolidation.intervalMs;
    const intervalMs =
      typeof rawInterval === "number" && Number.isFinite(rawInterval) && rawInterval >= 0
        ? Math.max(1_000, Math.floor(rawInterval))
        : MEMORY_CONSOLIDATION_DEFAULT_INTERVAL_MS;

    const tick = async () => {
      if (closed) return;
      try {
        await runConsolidation(false);
      } catch {
        /* runConsolidation already catches errors, but guard against unhandled */
      }
      if (closed) return;
      timer = setTimeout(tick, intervalMs);
      timer?.unref?.();
    };

    const start = () => {
      if (closed) return;
      timer = setTimeout(tick, initialDelayMs);
      timer?.unref?.();
    };

    ready.then(start, () => {});
  }

  return {
    async ready(): Promise<void> {
      await ready;
    },

    async flush(): Promise<void> {
      await ready;
      const flush = (sys as MemorySystem & { flush?: () => Promise<void> }).flush;
      if (typeof flush === "function") await flush.call(sys);
    },

    async recall(query: string, opts?: MemoryRecallOptions): Promise<RecalledMemory> {
      // 빈/공백 query = 회상 신호 없음 → backend 호출 없이 빈 결과(empty query 가 전체/임의 top-K 를
      // 끌어와 무관한 민감정보를 빈 턴에 주입하는 것 방지). FR-MEM-1 의 "content='' 도 정상 입력"은
      // recall *호출 시도* 를 뜻하며, 의미 있는 결과가 없으면 빈 회상이 정상.
      if (!query || !query.trim()) return { facts: [], episodes: [] };
      if (!readySettled) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ready,
            new Promise<void>((_, reject) => {
              timer = setTimeout(() => {
                reject(
                  Object.assign(new Error("memory is preparing (model load / reindex in progress)"), {
                    name: "MemoryPreparingError",
                    code: "MEMORY_PREPARING",
                  }),
                );
              }, MEMORY_PREPARING_GRACE_MS);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      await ready; // adapter init(특히 qdrant initialize()) 완료 보장 — 미완 시 조회 누락/throw.
      // opts.topK 가 유한 정수면 1..RAW_MAX_ITEMS 로 clamp, 아니면 인스턴스 기본 topK.
      const reqTopK = opts?.topK !== undefined ? Math.floor(Number(opts.topK)) : topK;
      const k = Number.isFinite(reqTopK) ? Math.min(Math.max(1, reqTopK), RAW_MAX_ITEMS) : topK;
      // query 입력도 상한 — 거대 query 가 backend embedding/조회 비용을 폭증시키는 것 차단.
      const result = await sys.recall(capInput(query, QUERY_CAP), {
        topK: k,
        project,
        scopeMode,
        ...(opts?.touch === false ? { touch: false } : {}),
      });
      // 포트 반환 상한(방어): 항목 수 k·각 content RAW_ITEM_CAP 자로 bound — 거대 반환이 동기 처리에서
      // 루프/메모리를 고갈시키는 것 차단(formatter 도 별도 cap). RAW_ITEM_CAP > formatter maxItemChars 기본.
      // ⚠️ 절단 시 **표식**(…[절단됨]) 부착 — 무표식 절단은 문장 후반(조건·부정·출처)을 소리없이 잘라 기억
      // 의미를 반전시킬 수 있다. recall 반환은 "원문"이 아니라 *bounded excerpt*(절단 표식 보존)임을 명시.
      const RAW_ITEM_CAP = 4000;
      const cap = (s: unknown): string => capInput(s as string, RAW_ITEM_CAP);
      const rawFacts = Array.isArray(result?.facts) ? result.facts.slice(0, k) : [];
      const facts = rawFacts.map((f) => cap(maskSecretShapes(String(f?.content ?? ""))));
      const factScores = rawFacts.map((f) => {
        const score = Number(f?.vectorScore);
        return Number.isFinite(score) ? score : undefined;
      });
      // episode 의 role(provenance), score(vectorScore), timestamp 보존 — assistant 생성물이 사용자 사실로 강화되는 것 방지.
      const episodes = Array.isArray(result?.episodes)
        ? result.episodes.slice(0, k).map((e) => {
            const score = Number(e?.vectorScore);
            const ts = Number(e?.timestamp);
            return {
              content: cap(maskSecretShapes(String(e?.content ?? ""))),
              ...(e?.role ? { role: e.role } : {}) ,
              ...(Number.isFinite(score) ? { score } : {}),
              ...(Number.isFinite(ts) ? { timestamp: ts } : {}),
            };
          })
        : [];
      // T0b: procedural 학습 교정(Reflection {task,failure,analysis,correction})을 회상에 surface.
      // codex 적대리뷰 → **correction-ONLY**: raw failure/analysis 는 물론 task 도 표면화하지 않는다.
      // task 는 실패 서술/주입문을 다시 실어 negative-capture(T0) 하드닝을 우회할 수 있으므로, 가장
      // 안전한 렌더는 "다음에 다르게 할 것(correction)" 단독이다. string 타입만 수용(Symbol 등 방어).
      // cap·경계표식 무력화·프레이밍은 facts 와 동일(domain formatter). procedural store 가 비어 있으면
      // (아직 producer 없음) 빈 배열 → domain formatter 가 블록에서 생략(무회귀).
      const reflections = Array.isArray((result as { reflections?: unknown })?.reflections)
        ? (result as { reflections: ReadonlyArray<{ correction?: unknown }> }).reflections
            .slice(0, k)
            .map((r) => (typeof r?.correction === "string" ? cap(maskSecretShapes(r.correction.trim())) : ""))
            .filter((s) => s.length > 0)
        : [];
      return { facts, factScores, episodes, reflections };
    },

    async save(
      userText: string,
      assistantText: string,
      opts?: { idempotencyKey?: string; durable?: boolean },
    ): Promise<void> {
      await ready; // adapter init 완료 보장.
      // 저장 원문도 상한(턴당) — 거대 턴이 embedding/디스크/flush 시간을 폭증시키는 것 차단. 초과분 절단 표식.
      await sys.encode({
        content: capInput(userText, SAVE_CAP),
        role: "user",
        ...(opts?.idempotencyKey
          ? { idempotencyKey: `${opts.idempotencyKey}:user` }
          : {}),
      }, { project, sessionId });
      if (assistantText.trim()) {
        await sys.encode({
          content: capInput(assistantText, SAVE_CAP),
          role: "assistant",
          ...(opts?.idempotencyKey
            ? { idempotencyKey: `${opts.idempotencyKey}:assistant` }
            : {}),
        }, { project, sessionId });
      }
      if (opts?.durable) {
        const flush = (sys as MemorySystem & { flush?: () => Promise<void> }).flush;
        if (typeof flush !== "function") {
          throw new Error("naia-memory durable flush is unavailable");
        }
        await flush.call(sys);
      }
    },

    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      await inFlight?.catch(() => undefined);
      await sys.close();
    },

    async consolidate(o?: { force?: boolean }): Promise<MemoryConsolidationEvent> {
      return runConsolidation(o?.force === true);
    },

    // ── CompactionPort (UC-compaction) — 같은 MemorySystem 위임 ──
    async compact(req: CompactionRequest): Promise<CompactionResult> {
      // 입력 메시지를 {role,content}로 정규화(상한 절단) — toolCalls/toolCallId 는 요약 대상 아님.
      const messages = req.messages.map((m) => ({ role: m.role, content: capInput(m.content, SAVE_CAP) }));
      await ready; // adapter init 완료 보장.
      const r = await sys.compact({
        messages,
        keepTail: Math.max(0, Math.floor(req.keepTail)),
        targetTokens: Math.max(1, Math.floor(req.targetTokens)),
        sessionId,
      });
      // recap 반환 상한(systemPrompt 폭증 차단). droppedCount = 요약에 흡수된 메시지 수(MemorySystem 계약).
      return { recap: capInput(r?.summary?.content ?? "", RECAP_CAP), droppedCount: Number(r?.droppedCount ?? 0) };
    },

    async attachHandoff(blob: HandoffBlob): Promise<void> {
      await ready; // adapter init 완료 보장.
      await sys.attachHandoff({
        version: 1,
        sessionId: (blob.sessionId && String(blob.sessionId).trim()) || sessionId,
        createdAt: Date.now(),
        turnCount: Math.max(0, Math.floor(Number(blob.turnCount) || 0)),
        totalTokens: Math.max(0, Math.floor(Number(blob.totalTokens) || 0)),
        trigger: String(blob.trigger ?? "compact"),
        recap: { role: "assistant", content: capInput(blob.recap ?? "", RECAP_CAP) },
        anchors: (Array.isArray(blob.anchors) ? blob.anchors : []).slice(0, ANCHOR_MAX).map((a) => capInput(String(a ?? ""), ANCHOR_CAP)),
      });
    },
  };
}
