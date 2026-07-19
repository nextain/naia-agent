import { createHash } from "node:crypto";
import type { ChatRequest } from "../domain/chat.js";
import type { KnowledgeBackend } from "./knowledge-skill.js";

/** 활성 workspace KB를 provider-only bounded evidence로 변환한다. snippet 원문은 wire source에 넣지 않는다. */
export function makeKnowledgeGrounding(backend: KnowledgeBackend | undefined) {
  return {
    async resolve(req: ChatRequest) {
      if (!backend || !req.grounding) return { status: "unavailable" as const, sources: [] };
      const query = req.messages.at(-1)?.role === "user" ? req.messages.at(-1)!.content.trim() : "";
      if (!query) return { status: "no_evidence" as const, sources: [] };
      const hits = await backend.search(`[scope:${req.grounding.knowledgeScope}] ${query}`, 8);
      let remainingEvidenceScalars = 16_000;
      const accepted = hits.slice(0, 8).flatMap((hit) => {
        const title = hit.title.trim().slice(0, 256);
        const sourceUris = hit.sourceUris.map((uri) => uri.trim()).filter(Boolean).slice(0, 8);
        const textScalars = Array.from(hit.snippet.trim());
        const take = Math.min(4_000, remainingEvidenceScalars);
        const text = textScalars.slice(0, take).join("");
        if (!title || sourceUris.length === 0 || !text) return [];
        remainingEvidenceScalars -= Array.from(text).length;
        const sourceHandle = createHash("sha256").update(`${title}\0${sourceUris.join("\0")}`).digest("hex");
        return [{ source: { title, sourceUris }, evidence: { sourceHandle, text } }];
      });
      if (accepted.length === 0) return { status: "no_evidence" as const, sources: [] };
      return {
        status: "grounded" as const,
        sources: accepted.map((item) => item.source),
        evidence: accepted.map((item) => item.evidence),
      };
    },
  };
}
