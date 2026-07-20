import { describe, expect, it } from "vitest";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";

describe("naia-memory narrow-port injection", () => {
  it("Agent가 주입한 extractor/summarizer가 legacy provider config보다 우선한다", async () => {
    const memory = makeNaiaMemory({
      project: "role-injection",
      storePath: `/tmp/naia-memory-role-injection-${process.pid}-${Date.now()}.json`,
      // 이 legacy 설정은 단독이면 baseUrl/model 누락으로 throw한다.
      llm: { provider: "ollama" },
      factExtractor: async () => [],
      summarizer: async ({ seedSummary }) => seedSummary,
    });
    await expect(memory.recall("")).resolves.toEqual({ facts: [], episodes: [] });
    await expect(memory.close()).resolves.toBeUndefined();
  });
});
