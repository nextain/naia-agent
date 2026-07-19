import { describe, expect, it } from "vitest";
import { makeKnowledgeGrounding } from "../main/adapters/knowledge-grounding.js";
import { makeReloadableKnowledgeBackend } from "../main/adapters/reloadable-knowledge-backend.js";

const request = {
  kind: "chat" as const,
  requestId: "rag-bounds",
  messages: [{ role: "user" as const, content: "query" }],
  grounding: { policy: "required" as const, knowledgeScope: "workshop" },
};

describe("knowledge grounding provider-evidence bounds", () => {
  it("counts Unicode scalars, allowing 3000 emoji without surrogate truncation", async () => {
    const text = "😀".repeat(3_000);
    const grounding = makeKnowledgeGrounding({
      search: async () => [{ title: "emoji", snippet: text, score: 1, sourceUris: ["kb://workshop/emoji"] }],
      ask: async () => ({ abstained: true, answer: "", sources: [] }),
    });
    const result = await grounding.resolve(request);
    expect(result.evidence?.[0]?.text).toBe(text);
    expect(Array.from(result.evidence?.[0]?.text ?? "")).toHaveLength(3_000);
  });

  it("caps evidence at 8 items, 4000 scalars each, and 16000 scalars total", async () => {
    const grounding = makeKnowledgeGrounding({
      search: async () => Array.from({ length: 10 }, (_, index) => ({
        title: `source-${index}`, snippet: "😀".repeat(5_000), score: 1,
        sourceUris: [`kb://workshop/${index}`],
      })),
      ask: async () => ({ abstained: true, answer: "", sources: [] }),
    });
    const result = await grounding.resolve(request);
    expect(result.evidence).toHaveLength(4);
    expect(result.evidence?.every((item) => Array.from(item.text).length === 4_000)).toBe(true);
    expect(result.evidence?.reduce((sum, item) => sum + Array.from(item.text).length, 0)).toBe(16_000);
  });

  it("keeps an admitted request on its old KB while the next request sees the swap", async () => {
    const hit = (name: string) => ({
      search: async () => [{ title: name, snippet: name, score: 1, sourceUris: [`kb://${name}`] }],
      ask: async () => ({ abstained: true, answer: "", sources: [] }),
    });
    const slot = makeReloadableKnowledgeBackend(hit("old"));
    const admitted = makeKnowledgeGrounding(slot.snapshot());
    slot.swap(hit("new"));
    expect((await admitted.resolve(request)).sources[0]?.title).toBe("old");
    expect((await makeKnowledgeGrounding(slot.snapshot()).resolve(request)).sources[0]?.title).toBe("new");
  });
});
