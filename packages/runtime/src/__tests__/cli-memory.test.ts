// --memory pure logic (Task #3 Slice C-mem, cross-review F1/F5).

import { describe, it, expect } from "vitest";
import { normalizeEmbedBaseUrl, decideCliMemory } from "../utils/cli-memory.js";

describe("normalizeEmbedBaseUrl", () => {
  it("strips a single trailing /v1 (the naia-settings uniform suffix)", () => {
    expect(normalizeEmbedBaseUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(normalizeEmbedBaseUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
  });
  it("leaves a base WITHOUT /v1 unchanged (Ollama root)", () => {
    expect(normalizeEmbedBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
  });
  it("does NOT false-strip /v1 mid-path", () => {
    expect(normalizeEmbedBaseUrl("http://h/v1/foo")).toBe("http://h/v1/foo");
  });
  it("F5: does not expose a Gemini /openai base by stripping its /v1", () => {
    // stripping would yield `…/openai` → provider switches to /embeddings
    // and loses /v1. Keep original.
    expect(normalizeEmbedBaseUrl("http://h/openai/v1")).toBe("http://h/openai/v1");
    // realistic Gemini base (no trailing /v1) is inert
    expect(normalizeEmbedBaseUrl("https://g/v1beta/openai")).toBe("https://g/v1beta/openai");
  });
});

describe("decideCliMemory", () => {
  it("lite when base+model+positive-int dims present (base normalized)", () => {
    const d = decideCliMemory({
      NAIA_EMBED_BASE_URL: "http://127.0.0.1:11434/v1",
      NAIA_EMBED_MODEL: "bge-m3",
      NAIA_EMBED_DIMS: "1024",
    } as NodeJS.ProcessEnv);
    expect(d).toEqual({ kind: "lite", base: "http://127.0.0.1:11434", model: "bge-m3", dims: 1024 });
  });
  it("ephemeral on missing base / model / bad dims", () => {
    expect(decideCliMemory({} as NodeJS.ProcessEnv).kind).toBe("ephemeral");
    expect(decideCliMemory({ NAIA_EMBED_BASE_URL: "u", NAIA_EMBED_MODEL: "m", NAIA_EMBED_DIMS: "0" } as NodeJS.ProcessEnv).kind).toBe("ephemeral");
    expect(decideCliMemory({ NAIA_EMBED_BASE_URL: "u", NAIA_EMBED_MODEL: "m", NAIA_EMBED_DIMS: "abc" } as NodeJS.ProcessEnv).kind).toBe("ephemeral");
    expect(decideCliMemory({ NAIA_EMBED_BASE_URL: "u", NAIA_EMBED_DIMS: "8" } as NodeJS.ProcessEnv).kind).toBe("ephemeral");
  });
});
