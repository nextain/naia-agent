import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildRoleMemoryExtractor, buildRoleMemorySummarizer } from "../main/adapters/memory-role-summarizer.js";
import type { Episode } from "@nextain/naia-memory";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";

describe("request-scoped memory summarizer", () => {
  it("uses the small model only after per-call approval", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body).model);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "short summary" } }] }) };
    });
    const summary = buildRoleMemorySummarizer({ provider: "nextain", model: "small", baseUrl: "https://example.invalid" }, undefined, fetch, () => {});
    const authorizeAndDisclose = vi.fn(async () => true);
    await expect(summary({ messages: [{ role: "user", content: "hello" }], keepTail: 0, targetTokens: 20, seedSummary: "seed" }, authorizeAndDisclose)).resolves.toBe("short summary");
    expect(calls).toEqual(["small"]);
    expect(authorizeAndDisclose).toHaveBeenCalledOnce();
  });
  it("does not send without approval", async () => {
    const fetch = vi.fn();
    const summary = buildRoleMemorySummarizer({ provider: "nextain", model: "small", baseUrl: "https://example.invalid" }, undefined, fetch, () => {});
    await expect(summary({ messages: [{ role: "user", content: "hello" }], keepTail: 0, targetTokens: 20, seedSummary: "seed" }, async () => false)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it("extracts facts through the existing parser with fallback and distinct approval", async () => {
  const models: string[] = [];
  const fetch = vi.fn(async (_url: string, init: { body: string }) => {
    const model = JSON.parse(init.body).model as string;
    models.push(model);
    const content = model === "small" ? "bad JSON" : '{"1":["User likes tea"]}';
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  });
  const small = { provider: "nextain", model: "small", baseUrl: "https://example.invalid" };
  const main = { ...small, model: "main" };
  const events: Array<{ provider: string; model?: string; reason: string }> = [];
  const extract = buildRoleMemoryExtractor(small, main, fetch, (event) => events.push(event));
  const authorize = vi.fn(async () => true);
  const episode = { id: "e1", content: "I like tea", timestamp: Date.now(), importance: { utility: 0.5, emotion: 0 }, encodingContext: { project: "test" }, role: "user" } as Episode;
  const result = await extract([episode], authorize);
  expect(result).toEqual([expect.objectContaining({ content: "User likes tea", sourceEpisodeIds: ["e1"] })]);
  expect(models).toEqual(["small", "main"]);
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(events).toEqual([
    { provider: "nextain", model: "small", reason: "invalid_response", attemptRole: "memory" },
    { provider: "nextain", model: "main", reason: "fallback_success", attemptRole: "main" },
  ]);
});

it("wires the authorized request-scoped summarizer into the real memory compaction path", async () => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "small recap" } }] }) }));
  const summary = buildRoleMemorySummarizer({ provider: "nextain", model: "small", baseUrl: "https://example.invalid" }, undefined, fetch, () => {});
  const testDir = join(tmpdir(), "sm-i1");
  await mkdir(testDir, { recursive: true });
  const storePath = join(testDir, `memory-${randomUUID()}.json`);
  const memory = makeNaiaMemory({ project: "smallmodel-i1", storePath, roleSummarizer: summary });
  try {
    await memory.ready();
    const messages = [{ role: "user" as const, content: "hello" }, { role: "assistant" as const, content: "world" }];
    const unapproved = await memory.compact({ messages, keepTail: 0, targetTokens: 20 });
    expect(unapproved.recap).not.toBe("small recap");
    expect(fetch).not.toHaveBeenCalled();
    const approved = await memory.compact({ messages, keepTail: 0, targetTokens: 20, authorizeAndDisclose: async () => true });
    expect(approved.recap).toBe("small recap");
    expect(fetch).toHaveBeenCalledOnce();
  } finally { await memory.close(); await rm(storePath, { force: true }); }
});

it("runs the real consolidation only in a save that supplies authorization", async () => {
  const fetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"1":["User likes tea"]}' } }] }) }));
  const extract = buildRoleMemoryExtractor({ provider: "nextain", model: "small", baseUrl: "https://example.invalid" }, undefined, fetch, () => {});
  const testDir = join(tmpdir(), "sm-i1");
  await mkdir(testDir, { recursive: true });
  const storePath = join(testDir, `memory-${randomUUID()}.json`);
  const memory = makeNaiaMemory({ project: "smallmodel-i1", storePath, roleExtractor: extract });
  try {
    await memory.ready();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 360_000);
    await memory.save("I like tea", "");
    vi.setSystemTime(Date.now() + 360_000);
    expect(fetch).not.toHaveBeenCalled();
    await memory.save("Hello", "", { authorizeAndDisclose: async () => true });
    expect(fetch).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); await memory.close(); await rm(storePath, { force: true }); }
});

it("uses the actual main ProviderPort after separate approval and preserves the first failure", async () => {
  const { buildMainMemoryPort } = await import("../main/adapters/memory-role-summarizer.js");
  const seen: string[] = [];
  const resolver = { resolve: (config: { provider: string; model: string }) => ({
    async *chat() { seen.push(`${config.provider}/${config.model}`); yield { kind: "text" as const, text: "main recap" }; },
  }) };
  const main = buildMainMemoryPort({ provider: "anthropic", model: "main" }, resolver);
  const small = { provider: "nextain", model: "small", baseUrl: "https://example.invalid" };
  const events: string[] = [];
  const endpoints: string[] = [];
  const summary = buildRoleMemorySummarizer(small, main, async () => ({ ok: false, status: 503, text: async () => "" }), () => {});
  const value = await summary({ messages: [{ role: "user", content: "hi" }], keepTail: 0, targetTokens: 20, seedSummary: "" }, async ({ provider, endpoint }) => { events.push(provider); endpoints.push(endpoint); return true; });
  expect(value).toBe("main recap");
  expect(seen).toEqual(["anthropic/main"]);
  expect(events).toEqual(["nextain", "anthropic"]);
  expect(endpoints).toEqual(["https://example.invalid", "https://api.anthropic.com"]);
});

it("approves an opaque main CLI as the selected provider and model before executing it", async () => {
  const { buildMainMemoryPort } = await import("../main/adapters/memory-role-summarizer.js");
  const { bindMemoryAuthorization } = await import("../main/adapters/llm-role-runtime.js");
  const calls: string[] = [];
  const provider = { provider: "codex", model: "main" };
  const port = buildMainMemoryPort(provider, { resolve: () => ({ async *chat() { calls.push("executed"); yield { kind: "text" as const, text: "ok" }; } }) });
  const endpoint = "opaque-cli:codex:main";
  let current: string | undefined = endpoint;
  let reply!: (decision: boolean) => void;
  const pendingDecision = new Promise<boolean>((resolve) => { reply = resolve; });
  const pending = port.complete("x", { authorizeAndDisclose: bindMemoryAuthorization(() => current, async () => pendingDecision) });
  current = "opaque-cli:codex:other"; reply(true);
  await expect(pending).rejects.toThrow("SUB_LLM_PROCESSING_NOT_AUTHORIZED");
  expect(calls).toEqual([]);
  current = endpoint;
  const approved: unknown[] = [];
  await expect(port.complete("x", { authorizeAndDisclose: bindMemoryAuthorization(() => current, async (input) => { approved.push(input); return true; }) })).resolves.toBe("ok");
  expect(approved).toEqual([expect.objectContaining({ provider: "codex", model: "main", endpoint })]);
  expect(calls).toEqual(["executed"]);
});
