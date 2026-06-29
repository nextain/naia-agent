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
export interface KnowledgeBackend {
  search(query: string, k?: number): Promise<KnowledgeSearchHit[]>;
  ask(query: string): Promise<KnowledgeAskResult>;
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
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined; // ⚠️ try 안에서 읽음 — malformed opts/throwing getter 도 catch→isError(NO-THROW)
      let aborted = false; // 결정론 abort 추적(catch 에서 signal 재독 의존 안 함)
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard(); // (진입 가드)
        if (!backend) return err("knowledge unavailable (backend 미주입)");
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
          return ok(JSON.stringify({ hits }));
        }
        if (call.name === "skill_knowledge_ask") {
          const r = await backend.ask(q);
          abortGuard(); // (await 후 가드)
          return ok(JSON.stringify(r));
        }
        return err(`unknown tool: ${call.name}`);
      } catch (e) {
        if (aborted || isAborted(signal)) throw e instanceof Error ? e : new Error("aborted"); // abort(flag 우선) → reject
        return err(safeMsg(e));
      }
    },
  };
}
