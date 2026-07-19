import { describe, expect, it } from "vitest";
import { makeReloadableKnowledgeBackend } from "../main/adapters/reloadable-knowledge-backend.js";
import type { KnowledgeBackend } from "../main/adapters/knowledge-skill.js";

function backend(label: string, release?: Promise<void>): KnowledgeBackend {
  return {
    async search() {
      await release;
      return [{ title: label, snippet: label, score: 1, sourceUris: [`kb://${label}`] }];
    },
    async ask() { return { abstained: false, answer: label, sources: [] }; },
  };
}

describe("reloadable workspace knowledge backend", () => {
  it("new workspace never searches the old backend after atomic swap", async () => {
    const slot = makeReloadableKnowledgeBackend(backend("old"));
    expect((await slot.backend.search("q"))[0]?.title).toBe("old");
    slot.swap(backend("new"));
    const next = await slot.backend.search("q");
    expect(next.map((hit) => hit.title)).toEqual(["new"]);
    expect(JSON.stringify(next)).not.toContain("old");
  });

  it("an in-flight call retains its captured backend across a swap", async () => {
    let unlock!: () => void;
    const pending = new Promise<void>((resolve) => { unlock = resolve; });
    const slot = makeReloadableKnowledgeBackend(backend("old", pending));
    const inflight = slot.backend.search("q");
    slot.swap(backend("new"));
    unlock();
    expect((await inflight)[0]?.title).toBe("old");
    expect((await slot.backend.search("q"))[0]?.title).toBe("new");
  });

  it("fails closed with empty knowledge when the new workspace has no backend", async () => {
    const slot = makeReloadableKnowledgeBackend(backend("old"));
    slot.swap(undefined);
    expect(await slot.backend.search("q")).toEqual([]);
    expect(await slot.backend.ask("q")).toEqual({ abstained: true, answer: "", sources: [] });
  });
});
