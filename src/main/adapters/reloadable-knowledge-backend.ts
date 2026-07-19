import type { KnowledgeAskResult, KnowledgeBackend, KnowledgeGraphData, KnowledgeSearchHit } from "./knowledge-skill.js";

const EMPTY_ASK: KnowledgeAskResult = { abstained: true, answer: "", sources: [] };

/**
 * Workspace reload용 stable port. swap은 한 reference 교체라 원자적이며 각 method는
 * 호출 시작 시 backend를 한 번 캡처해 진행 중 호출이 중간 workspace로 갈아타지 않는다.
 */
export function makeReloadableKnowledgeBackend(initial?: KnowledgeBackend): {
  readonly backend: KnowledgeBackend;
  snapshot(): KnowledgeBackend | undefined;
  swap(next: KnowledgeBackend | undefined): void;
} {
  let current = initial;
  return {
    snapshot: () => current,
    swap: (next) => { current = next; },
    backend: {
      async search(query: string, k?: number): Promise<KnowledgeSearchHit[]> {
        const selected = current;
        return selected ? selected.search(query, k) : [];
      },
      async ask(query: string): Promise<KnowledgeAskResult> {
        const selected = current;
        return selected ? selected.ask(query) : EMPTY_ASK;
      },
      async graph(): Promise<KnowledgeGraphData> {
        const selected = current;
        return selected?.graph ? selected.graph() : { nodes: [], edges: [], communityCount: 0 };
      },
    },
  };
}
