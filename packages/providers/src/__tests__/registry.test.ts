/**
 * Provider Registry tests — Slice 4-P1 (#59).
 * Verifies provider catalogue, lookup helpers, gateway pricing overlay,
 * model migration, and dynamic fetch stubs.
 */
import { describe, it, expect } from "vitest";

// We test the source directly (tsconfig paths resolve @nextain/agent-types).
// The registry is pure data — no network calls unless explicitly testing fetch.
import {
  listProviders,
  getProvider,
  getProviderModels,
  getDefaultModel,
  shouldMigrateNextainModel,
  fetchNaiaPricing,
  DEFAULT_GATEWAY_HTTP_URL,
} from "../registry.js";

describe("Provider Registry — catalogue", () => {
  it("lists 9 providers", () => {
    const providers = listProviders();
    expect(providers).toHaveLength(9);
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("nextain");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("gemini");
    expect(ids).toContain("openai");
    expect(ids).toContain("xai");
    expect(ids).toContain("zai");
    expect(ids).toContain("ollama");
    expect(ids).toContain("vllm");
    expect(ids).toContain("claude-code-cli");
  });

  it("each provider has required fields", () => {
    for (const p of listProviders()) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(typeof p.requiresApiKey).toBe("boolean");
      expect(typeof p.defaultModel).toBe("string");
      expect(Array.isArray(p.models)).toBe(true);
    }
  });
});

describe("Provider Registry — lookup helpers", () => {
  it("getProvider returns provider by id", () => {
    const naia = getProvider("nextain");
    expect(naia).toBeDefined();
    expect(naia!.name).toBe("Naia");
    expect(naia!.requiresNaiaKey).toBe(true);
    expect(naia!.requiresApiKey).toBe(false);
  });

  it("getProvider returns undefined for unknown id", () => {
    expect(getProvider("nonexistent")).toBeUndefined();
  });

  it("getProviderModels returns models for a provider", () => {
    const models = getProviderModels("nextain");
    expect(models.length).toBeGreaterThan(0);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("gemini-2.5-flash");
    expect(ids).toContain("gemini-2.5-pro");
  });

  it("getProviderModels returns empty for unknown provider", () => {
    expect(getProviderModels("nonexistent")).toEqual([]);
  });

  it("getDefaultModel returns default for provider", () => {
    expect(getDefaultModel("nextain")).toBe("gemini-3.5-flash");
    expect(getDefaultModel("anthropic")).toBe("claude-sonnet-4-6");
  });

  it("getDefaultModel returns empty string for unknown", () => {
    expect(getDefaultModel("nonexistent")).toBe("");
  });
});

describe("Provider Registry — Naia model details", () => {
  it("Naia text models have no static pricing (fetched from gateway)", () => {
    const models = getProviderModels("nextain");
    const flash = models.find((m) => m.id === "gemini-2.5-flash");
    expect(flash).toBeDefined();
    expect(flash!.pricing).toBeUndefined();
  });

  it("Naia provider has omni models with voice metadata", () => {
    const models = getProviderModels("nextain");
    const live = models.find((m) => m.id === "gemini-2.5-flash-live");
    expect(live).toBeDefined();
    expect(live!.capabilities).toContain("omni");
    expect(live!.voiceSelectable).toBe(true);
    expect(live!.voices!.length).toBeGreaterThan(0);
    expect(live!.transcriptProvided).toBe(true);
  });

  it("Naia provider lists gemini-3.x models", () => {
    const models = getProviderModels("nextain");
    const ids = models.map((m) => m.id);
    const gemini3x = ids.filter((id) => id.startsWith("gemini-3"));
    expect(gemini3x.length).toBeGreaterThan(0);
  });
});

describe("Provider Registry — local providers", () => {
  it("ollama is local with empty static models and fetchModels", () => {
    const ollama = getProvider("ollama");
    expect(ollama!.isLocal).toBe(true);
    expect(ollama!.models).toEqual([]);
    expect(ollama!.fetchModels).toBeDefined();
  });

  it("vllm is local with empty static models and fetchModels", () => {
    const vllm = getProvider("vllm");
    expect(vllm!.isLocal).toBe(true);
    expect(vllm!.models).toEqual([]);
    expect(vllm!.fetchModels).toBeDefined();
  });
});

describe("Provider Registry — shouldMigrateNextainModel", () => {
  it("returns false for a valid model", () => {
    expect(shouldMigrateNextainModel("nextain", "gemini-2.5-flash")).toEqual({ migrate: false });
  });

  it("returns true with fallback for a removed model", () => {
    const result = shouldMigrateNextainModel("nextain", "gemini-1.5-pro-obsolete");
    expect(result).toEqual({ migrate: true, to: "gemini-3.5-flash" });
  });

  it("returns false for non-nextain provider", () => {
    expect(shouldMigrateNextainModel("anthropic", "claude-opus-4-6")).toEqual({ migrate: false });
  });
});

describe("Provider Registry — fetchNaiaPricing", () => {
  it("returns null when gateway is unreachable", async () => {
    const result = await fetchNaiaPricing("http://127.0.0.1:1");
    expect(result).toBeNull();
  });
});

describe("Provider Registry — DEFAULT_GATEWAY_HTTP_URL", () => {
  it("points to prod gateway", () => {
    expect(DEFAULT_GATEWAY_HTTP_URL).toContain("naia-gateway");
    expect(DEFAULT_GATEWAY_HTTP_URL).toMatch(/^https:\/\//);
  });
});
