// adapters — MemoryPort 구현 (UC-memory FR-MEM-4). 실 @nextain/naia-memory 래핑.
// recall = 시맨틱/키워드 검색 결과의 *원문*(facts/episodes content)을 반환 — 프롬프트 프레이밍·예산
// 절단은 domain formatRecalledMemory 소유(adapter 는 데이터만). save = user/assistant encode.
import { LocalAdapter, MemorySystem } from "@nextain/naia-memory";
import type { ManagedMemoryPort } from "../ports/memory.js";
import type { RecalledMemory } from "../domain/memory.js";

const QUERY_CAP = 4000;   // recall query 입력 상한(embedding 비용 bound).
const SAVE_CAP = 20000;   // save 원문(턴당, user/assistant 각각) 상한(디스크/flush 비용 bound).
/** 입력 문자열 상한 절단(초과 시 표식). 거대 입력이 backend 비용을 폭증시키는 것 차단. */
function capInput(s: string, max: number): string {
  const t = String(s ?? "");
  return t.length <= max ? t : `${t.slice(0, max)} …[절단됨]`;
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
}

/** MemoryPort 어댑터 + lifecycle close. */
export function makeNaiaMemory(opts: NaiaMemoryOpts): ManagedMemoryPort {
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
  const sys = new MemorySystem({
    adapter: new LocalAdapter(opts.storePath ? { storePath: opts.storePath } : {}),
  });

  return {
    async recall(query: string): Promise<RecalledMemory> {
      // 빈/공백 query = 회상 신호 없음 → backend 호출 없이 빈 결과(empty query 가 전체/임의 top-K 를
      // 끌어와 무관한 민감정보를 빈 턴에 주입하는 것 방지). FR-MEM-1 의 "content='' 도 정상 입력"은
      // recall *호출 시도* 를 뜻하며, 의미 있는 결과가 없으면 빈 회상이 정상.
      if (!query || !query.trim()) return { facts: [], episodes: [] };
      // query 입력도 상한 — 거대 query 가 backend embedding/조회 비용을 폭증시키는 것 차단.
      const result = await sys.recall(capInput(query, QUERY_CAP), { topK, project, scopeMode });
      // 포트 반환 상한(방어): 항목 수 topK·각 content RAW_ITEM_CAP 자로 bound — 거대 반환이 동기 처리에서
      // 루프/메모리를 고갈시키는 것 차단(formatter 도 별도 cap). RAW_ITEM_CAP > formatter maxItemChars 기본.
      // ⚠️ 절단 시 **표식**(…[절단됨]) 부착 — 무표식 절단은 문장 후반(조건·부정·출처)을 소리없이 잘라 기억
      // 의미를 반전시킬 수 있다. recall 반환은 "원문"이 아니라 *bounded excerpt*(절단 표식 보존)임을 명시.
      const RAW_ITEM_CAP = 4000;
      const cap = (s: unknown): string => capInput(s as string, RAW_ITEM_CAP);
      const facts = Array.isArray(result?.facts) ? result.facts.slice(0, topK).map((f) => cap(f?.content)) : [];
      // episode 의 role(provenance) 보존 — assistant 생성물이 사용자 사실로 강화되는 것 방지.
      const episodes = Array.isArray(result?.episodes)
        ? result.episodes.slice(0, topK).map((e) => ({ content: cap(e?.content), ...(e?.role ? { role: e.role } : {}) }))
        : [];
      return { facts, episodes };
    },

    async save(userText: string, assistantText: string): Promise<void> {
      // 저장 원문도 상한(턴당) — 거대 턴이 embedding/디스크/flush 시간을 폭증시키는 것 차단. 초과분 절단 표식.
      await sys.encode({ content: capInput(userText, SAVE_CAP), role: "user" }, { project, sessionId });
      await sys.encode({ content: capInput(assistantText, SAVE_CAP), role: "assistant" }, { project, sessionId });
    },

    async close(): Promise<void> {
      await sys.close();
    },
  };
}
