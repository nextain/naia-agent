// adapters/exhibition-knowledge — KnowledgeBackend를 전시 profile의 작은 read-only port로 제한.
import { createHash } from "node:crypto";
import type { ExhibitionIntroItem } from "../ports/speech-activity.js";
import type { KnowledgeBackend } from "./knowledge-skill.js";

export function makeExhibitionKnowledge(backend: KnowledgeBackend | undefined): {
  ready(): boolean;
  listIntroItems(scope: string): Promise<readonly ExhibitionIntroItem[]>;
  answer(scope: string, question: string): Promise<{
    abstained: boolean;
    answer: string;
    sources: readonly string[];
  }>;
} {
  return {
    ready: () => backend !== undefined,
    async listIntroItems(scope) {
      if (!backend) return [];
      const hits = await backend.search(`${scope} 회사 제품 전시 소개`, 10);
      return hits.flatMap((hit) => {
        const sources = hit.sourceUris.map((uri) => uri.trim()).filter(Boolean);
        const text = hit.snippet.trim();
        if (!text || sources.length === 0) return [];
        const itemId = createHash("sha256")
          .update(`${sources.join("\n")}\0${hit.title.trim()}`)
          .digest("hex");
        return [{ itemId, text, sourceUris: sources }];
      });
    },
    async answer(scope, question) {
      if (!backend) return { abstained: true, answer: "", sources: [] };
      const result = await backend.ask(`[scope:${scope}] ${question}`);
      const sources = result.sources
        .flatMap((source) => source.sourceUris)
        .map((uri) => uri.trim())
        .filter(Boolean);
      return {
        abstained: result.abstained || sources.length === 0,
        answer: result.answer,
        sources,
      };
    },
  };
}
