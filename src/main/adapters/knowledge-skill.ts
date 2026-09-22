// adapters/knowledge-skill — 워크스페이스 지식 풀 도구 ToolExecutorPort(읽기 전용). K1a.
// 코어가 컴파일된 KB(naia-kb-compiler 등)를 검색/질의응답 도구로 노출 — memory(푸시)와 분리된 풀(tool).
// backend 주입(KnowledgeBackend) → 특정 엔진 비종속(D03). compose 가 실 backend 주입(K1a-2, openWorkspaceKnowledge).
// github-skills 동일 규약: no-throw 단일 try(arg/backend/format), abort 2가드(진입/await후), JSON 직렬화 출력(sources 보존).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

/** kb-compiler KnowledgeService 표면의 최소 미러(어댑터를 특정 엔진에 묶지 않음 — D03 비종속). */
export interface KnowledgeSearchHit {
  title: string;
  snippet: string;
  score: number;
  sourceUris: string[];
}
export interface KnowledgeAskResult {
  abstained: boolean;
  answer: string;
  sources: { title: string; sourceUris: string[] }[];
}
export interface KnowledgeGraphNode { id: string; label: string; type: string; deg: number; community: number; }
export interface KnowledgeGraphEdge { from: string; to: string; type: string; weight: number; }
export interface KnowledgeGraphData { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; communityCount: number; }
export interface KnowledgeScopeSource { path: string; cardCount: number; }
export interface KnowledgeScopeInfo {
  scope: string;            // active scope name, e.g. "default"
  sources: KnowledgeScopeSource[]; // registered source folders (knowledge.json), in config order
  totalCards: number;       // all cards in the compiled KB
  otherCards: number;       // cards whose sourceUris match no registered source (e.g. compiled from a source since removed)
}
export interface KnowledgeBackend {
  search(query: string, k?: number): Promise<KnowledgeSearchHit[]>;
  ask(query: string): Promise<KnowledgeAskResult>;
  /** 시각화용 그래프 데이터 — 선택(backend 지원 시에만 skill_knowledge_graph 노출, K3). */
  graph?(): Promise<KnowledgeGraphData>;
  /** 등록 소스 및 카드 수 조회 — 선택(backend 지원 시에만 skill_knowledge_scope 노출, FR-KB-8, nextain/naia-agent#142). */
  scope?(): Promise<KnowledgeScopeInfo>;
}

export interface KnowledgeDeps {
  backend?: KnowledgeBackend;
}

// 읽기 전용 → tier 없음(자동, 승인 불요. github-skills 동형). 쓰기/컴파일은 별도(K1b, tier+승인).
const TOOLS: readonly ToolSpec[] = [
  {
    name: "skill_knowledge_search",
    description: "워크스페이스 지식에서 관련 카드 검색(읽기 전용). 인자: {query, k?}",
    parameters: { type: "object", properties: { query: { type: "string" }, k: { type: "number" } }, required: ["query"] },
  },
  {
    name: "skill_knowledge_ask",
    description: "워크스페이스 지식으로 근거 답변(인용·출처 포함, 근거 없으면 기권). 인자: {query}",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];
// K3: 그래프 데이터(시각화용) — backend.graph 지원 시에만 specs 에 추가. 인자 없음.
const GRAPH_TOOL: ToolSpec = {
  name: "skill_knowledge_graph",
  description: "워크스페이스 지식 그래프 데이터(엔티티·관계·군집) 조회 — 시각화용(읽기 전용). 인자 없음",
  parameters: { type: "object", properties: {} },
};
// FR-KB-8: 지식 범위 조회 — backend.scope 지원 시에만 specs 에 추가. 인자 없음.
const SCOPE_TOOL: ToolSpec = {
  name: "skill_knowledge_scope",
  description: '워크스페이스 지식의 범위 조회 — 등록된 소스 폴더(knowledge.json)와 폴더별·전체 카드 수(읽기 전용). "지식 파일은?"·"지식에 뭐가 있어?" 같은 범위 질문에 사용. 인자 없음',
  parameters: { type: "object", properties: {} },
};

const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "tool error"; }
}

export function makeKnowledgeSkillsExecutor(deps: KnowledgeDeps = {}): ToolExecutorPort {
  const backend = deps.backend;
  return {
    specs: () => {
      if (!backend?.graph && !backend?.scope) return TOOLS;
      const list = [...TOOLS];
      if (backend.graph) list.push(GRAPH_TOOL);
      if (backend.scope) list.push(SCOPE_TOOL);
      return list;
    },
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined; // ⚠️ try 안에서 읽음 — malformed opts/throwing getter 도 catch→isError(NO-THROW)
      let aborted = false; // 결정론 abort 추적(catch 에서 signal 재독 의존 안 함)
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard(); // (진입 가드)
        if (!backend) return err("knowledge unavailable (backend 미주입)");
        if (call.name === "skill_knowledge_graph") {
          if (!backend.graph) return err("knowledge graph unavailable");
          const g = await backend.graph();
          abortGuard(); // (await 후 가드)
          const empty = !Array.isArray(g.nodes) || g.nodes.length === 0;
          return ok(JSON.stringify({
            ...g,
            empty,
            ...(empty ? { message: "No compiled knowledge graph is available." } : {}),
          }));
        }
        if (call.name === "skill_knowledge_scope") {
          if (!backend.scope) return err("knowledge scope unavailable");
          const s = await backend.scope();
          abortGuard(); // (await 후 가드)
          const empty = s.totalCards === 0;
          const note = "Workspace knowledge consists only of the compiled cards from the registered sources listed here. Files outside these sources (other project READMEs, AGENTS.md, design docs, code) are not part of the knowledge base.";
          return ok(JSON.stringify({
            ...s,
            empty,
            note,
            ...(empty ? { message: s.sources.length === 0 ? "No knowledge sources are registered." : "No compiled knowledge cards are available." } : {}),
          }));
        }
        if (!isObj(call.args)) return err("args must be object");
        const q = call.args.query;
        if (typeof q !== "string" || q.trim() === "") return err("query must be non-empty string");

        if (call.name === "skill_knowledge_search") {
          let k: number | undefined;
          if (call.args.k !== undefined) {
            const kv = call.args.k;
            if (typeof kv !== "number" || !Number.isInteger(kv) || kv <= 0) return err("k must be positive integer");
            k = kv;
          }
          const hits = await backend.search(q, k);
          abortGuard(); // (await 후 가드)
          const empty = hits.length === 0;
          return ok(JSON.stringify({
            hits,
            empty,
            ...(empty ? { message: "No compiled knowledge cards matched." } : {}),
          }));
        }
        if (call.name === "skill_knowledge_ask") {
          const r = await backend.ask(q);
          abortGuard(); // (await 후 가드)
          return ok(JSON.stringify({
            ...r,
            empty: r.abstained === true && !(r.answer ?? "").trim(),
            ...(r.abstained && !(r.answer ?? "").trim() ? { message: "No compiled knowledge cards matched." } : {}),
          }));
        }
        return err(`unknown tool: ${call.name}`);
      } catch (e) {
        if (aborted || isAborted(signal)) throw e instanceof Error ? e : new Error("aborted"); // abort(flag 우선) → reject
        return err(safeMsg(e));
      }
    },
  };
}
