import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRoleMemoryExtractor, buildRoleMemorySummarizer } from "../main/adapters/memory-role-summarizer.js";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";

const config = (model: string, provider = "nextain") => ({ provider, model, baseUrl: "https://example.invalid/v1" });
const ok = (content: string) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });

describe("small model memory request integration", () => {
  it("IT-SM-AGENT-01 대화 추출과 압축이 해석된 기억 역할을 쓴다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-memory-"));
    const models: string[] = [];
    const fetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body); models.push(body.model);
      return ok(body.max_tokens === 8192 ? '{"1":["User likes tea"]}' : "tea summary");
    };
    const small = config("small");
    const memory = makeNaiaMemory({ project: "test", storePath: join(dir, "memory.json"), roleExtractor: buildRoleMemoryExtractor(small, undefined, fetch, () => {}), roleSummarizer: buildRoleMemorySummarizer(small, undefined, fetch, () => {}) });
    try {
      await memory.ready();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() - 360_000);
      await memory.save("I like tea", "");
      vi.setSystemTime(Date.now() + 360_000);
      const authorize = vi.fn(async () => true);
      await memory.save("hello", "", { authorizeAndDisclose: authorize });
      const compact = await memory.compact({ messages: [{ role: "user" as const, content: "I like tea" }], keepTail: 0, targetTokens: 20, authorizeAndDisclose: authorize });
      expect(compact.recap).toBe("tea summary");
      expect(models).toEqual(["small", "small"]);
      expect(authorize).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); await memory.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("IT-SM-AGENT-03 동시 요청별 추출기와 요약기 및 승인을 격리한다", async () => {
    const approvals: string[] = [];
    const models: string[] = [];
    const fetch = async (_url: string, init: { body: string }) => { const b = JSON.parse(init.body); models.push(b.model); await Promise.resolve(); return ok(`summary-${b.model}`); };
    const summarize = buildRoleMemorySummarizer(config("small"), undefined, fetch, () => {});
    const input = { messages: [{ role: "user" as const, content: "private" }], keepTail: 0, targetTokens: 20, seedSummary: "" };
    const [approved, denied] = await Promise.allSettled([
      summarize(input, async ({ model }) => { approvals.push(`allow:${model}`); return true; }),
      summarize(input, async ({ model }) => { approvals.push(`deny:${model}`); return false; }),
    ]);
    expect(approved).toMatchObject({ status: "fulfilled", value: "summary-small" });
    expect(denied.status).toBe("rejected");
    expect(approvals.sort()).toEqual(["allow:small", "deny:small"]);
    expect(models).toEqual(["small"]);
  });

  it("IT-SM-AGENT-04 추출과 압축의 실패·승인·로컬 복구를 각각 확인한다", async () => {
    const calls: string[] = [];
    const fetch = async (_url: string, init: { body: string }) => { const b = JSON.parse(init.body); calls.push(b.model); return b.model === "small" ? { ok: false, status: 503, text: async () => "private" } : ok("fallback recap"); };
    const summary = buildRoleMemorySummarizer(config("small"), config("main"), fetch, () => {});
    const approvals: string[] = [];
    expect(await summary({ messages: [{ role: "user", content: "hi" }], keepTail: 0, targetTokens: 20, seedSummary: "" }, async ({ model }) => { approvals.push(model); return true; })).toBe("fallback recap");
    expect(calls).toEqual(["small", "main"]); expect(approvals).toEqual(["small", "main"]);
    calls.length = 0;
    const local = buildRoleMemorySummarizer(config("small", "ollama"), config("main"), fetch, () => {});
    await expect(local({ messages: [{ role: "user", content: "hi" }], keepTail: 0, targetTokens: 20, seedSummary: "" }, async () => true)).rejects.toThrow();
    expect(calls).toEqual(["small"]);
  });
});

it("desktop checks each actual memory destination and a rejected destination sends nothing", async () => {
  const { ChatTurnHandler } = await import("../main/app/chat-turn-handler.js");
  const { makeInMemoryApproval } = await import("../main/adapters/approval.js");
  const { makeInMemoryCredentials } = await import("../main/composition/index.js");
  const { makeFakeProvider } = await import("../main/adapters/fake-provider.js");
  const approval = makeInMemoryApproval();
  const sent: string[] = [];
  const targets: string[] = [];
  const names: string[] = [];
  const handler = new ChatTurnHandler({
    provider: makeFakeProvider(), defaultConfig: { provider: "fake", model: "main" },
    conversation: { assemble: (request) => ({ messages: request.messages }) }, credentials: makeInMemoryCredentials(), approval,
    egress: { emit: (id, event) => { if (event.kind === "approvalRequest") { targets.push(JSON.stringify(event.args)); names.push(event.toolName); queueMicrotask(() => approval.resolve(id, event.toolCallId, names.length === 1 ? "approve" : "reject")); } } },
    diag: { log: () => {} },
    memory: { recall: async () => ({ facts: [], episodes: [] }), save: async (_user, _assistant, opts) => {
      for (const model of ["small", "main"]) {
        if (await opts?.authorizeAndDisclose?.({ workload: "sub_llm", provider: "nextain", model, endpoint: `https://${model}.invalid/v1?secret=hidden` })) sent.push(model);
      }
    } },
  });
  await handler.onChatRequest({ kind: "chat", requestId: "r", messages: [{ role: "user", content: "hi" }] });
  expect(sent).toEqual(["small"]);
  expect(targets).toHaveLength(2); expect(names[0]).not.toBe(names[1]);
  expect(JSON.stringify({ targets, names })).not.toContain("hidden");
});

it("desktop timeout or cancellation never sends a memory request", async () => {
  const { ChatTurnHandler } = await import("../main/app/chat-turn-handler.js");
  const { makeInMemoryApproval } = await import("../main/adapters/approval.js");
  const { makeInMemoryCredentials } = await import("../main/composition/index.js");
  const { makeFakeProvider } = await import("../main/adapters/fake-provider.js");
  for (const mode of ["timeout", "cancel"] as const) {
    let transmissions = 0;
    let handler: InstanceType<typeof ChatTurnHandler>;
    handler = new ChatTurnHandler({
      provider: makeFakeProvider(), defaultConfig: { provider: "fake", model: "main" }, memoryTimeoutMs: 80,
      conversation: { assemble: (request) => ({ messages: request.messages }) }, credentials: makeInMemoryCredentials(), approval: makeInMemoryApproval(),
      egress: { emit: (_id, event) => { if (event.kind === "approvalRequest" && mode === "cancel") queueMicrotask(() => handler.onCancel({ kind: "cancel", requestId: mode })); } },
      diag: { log: () => {} },
      memory: { recall: async () => ({ facts: [], episodes: [] }), save: async (_user, _assistant, opts) => {
        if (await opts?.authorizeAndDisclose?.({ workload: "sub_llm", provider: "nextain", model: "small", endpoint: "https://small.invalid" })) transmissions++;
      } },
    });
    await handler.onChatRequest({ kind: "chat", requestId: mode, messages: [{ role: "user", content: "hi" }] });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transmissions).toBe(0);
  }
});

it("IT-SM-AGENT-05 재시도 후 중복 사실 없이 안전한 호출 기록을 남긴다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-dedupe-"));
  const models: string[] = [];
  const events: unknown[] = [];
  const fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); models.push(body.model);
    return body.model === "small" ? { ok: false, status: 503, text: async () => "sensitive-body" } : ok('{"1":["User likes tea"]}');
  };
  const extract = buildRoleMemoryExtractor(config("small"), config("main"), fetch, (event) => events.push({ role: "memory", ...event }));
  const memory = makeNaiaMemory({ project: "test", storePath: join(dir, "memory.json"), roleExtractor: extract });
  try {
    await memory.ready(); vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() - 720_000);
    await memory.save("I like tea", "");
    vi.setSystemTime(Date.now() + 360_000);
    await memory.save("I like tea", "", { authorizeAndDisclose: async () => true });
    vi.setSystemTime(Date.now() + 360_000);
    await memory.save("hello", "", { authorizeAndDisclose: async () => true });
    expect(models).toEqual(["small", "main", "small", "main"]);
    expect((await memory.recall("tea")).facts.filter((value) => value === "User likes tea")).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ role: "memory", model: "small", reason: "http_503" }), expect.objectContaining({ role: "memory", model: "main", reason: "fallback_success" }), expect.objectContaining({ model: "small", reason: "http_503" }), expect.objectContaining({ model: "main", reason: "fallback_success" })]);
    expect(JSON.stringify(events)).not.toMatch(/sensitive-body|I like tea/);
  } finally { vi.useRealTimers(); await memory.close(); await rm(dir, { recursive: true, force: true }); }
});

it("cancelling during an asynchronous processing disclosure rolls back its reservation", async () => {
  const { ChatTurnHandler } = await import("../main/app/chat-turn-handler.js");
  const { makeInMemoryApproval } = await import("../main/adapters/approval.js");
  const { makeInMemoryCredentials } = await import("../main/composition/index.js");
  const { makeFakeProvider } = await import("../main/adapters/fake-provider.js");
  let rollback = 0; let transmissions = 0;
  const processingGuard = {
    authorize: () => { throw new Error("unused"); }, authorizePlan: () => [],
    preparePlan: (inputs: any[]) => ({ disclosures: inputs.map((input) => ({ workload: input.workload, provider: input.provider.provider, model: input.provider.model, processingProfileRef: input.processingProfileRef, destination: "external_cloud", decision: "allowed" })), commit: () => true, rollback: () => { rollback++; return true; } }),
  } as any;
  let handler: InstanceType<typeof ChatTurnHandler>;
  handler = new ChatTurnHandler({
    provider: makeFakeProvider(), defaultConfig: { provider: "fake", model: "main" }, memoryTimeoutMs: 200,
    conversation: { assemble: (request) => ({ messages: request.messages }) }, credentials: makeInMemoryCredentials(), approval: makeInMemoryApproval(), processingGuard,
    egress: { emit: () => {}, emitCritical: async (_id, event) => {
      if (event.kind === "processingDisclosure" && event.model === "small") { handler.onCancel({ kind: "cancel", requestId: "r" }); await Promise.resolve(); }
      return true;
    } }, diag: { log: () => {} },
    memory: { recall: async () => ({ facts: [], episodes: [] }), save: async (_user, _assistant, opts) => {
      if (await opts?.authorizeAndDisclose?.({ workload: "sub_llm", provider: "nextain", model: "small", endpoint: "https://small.invalid", signal: opts.signal })) transmissions++;
    } },
  });
  await handler.onChatRequest({ kind: "chat", requestId: "r", messages: [{ role: "user", content: "hi" }], processing: { processingProfileRef: "p" } });
  expect(transmissions).toBe(0); expect(rollback).toBeGreaterThan(0);
});

it("IT-SM-AGENT-04 추출과 압축의 승인 거부, 양쪽 실패와 로컬 복구를 확인한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-recovery-"));
  const calls: string[] = [];
  const events: unknown[] = [];
  const fetch = async (_url: string, init: { body: string }) => {
    const model = JSON.parse(init.body).model; calls.push(model);
    return { ok: false, status: model === "small" ? 429 : 503, text: async () => "private" };
  };
  const cloud = config("small"); const main = config("main");
  const episode = { id: "e1", content: "I like tea", timestamp: Date.now(), importance: { utility: 0.5, emotion: 0 }, encodingContext: { project: "test" }, role: "user" } as import("@nextain/naia-memory").Episode;
  const input = { messages: [{ role: "user" as const, content: "I like tea" }], keepTail: 0, targetTokens: 20, seedSummary: "previous" };
  const extract = buildRoleMemoryExtractor(cloud, main, fetch, (event) => events.push(event));
  const summarize = buildRoleMemorySummarizer(cloud, main, fetch, (event) => events.push(event));
  await expect(extract([episode], async () => false)).rejects.toThrow("SUB_LLM_PROCESSING_NOT_AUTHORIZED");
  await expect(summarize(input, async () => false)).rejects.toThrow("SUB_LLM_PROCESSING_NOT_AUTHORIZED");
  expect(calls).toEqual([]);
  await expect(extract([episode], async () => true)).rejects.toMatchObject({ status: 429 });
  await expect(summarize(input, async () => true)).rejects.toMatchObject({ status: 429 });
  expect(calls).toEqual(["small", "main", "small", "main"]);
  calls.length = 0;
  const observed: unknown[] = [];
  const failingMemory = makeNaiaMemory({ project: "test", storePath: join(dir, "cloud.json"), roleExtractor: extract, roleSummarizer: summarize });
  try {
    await failingMemory.ready(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() - 360_000);
    await failingMemory.save("I like tea", ""); vi.setSystemTime(Date.now() + 360_000);
    await failingMemory.save("hello", "", { authorizeAndDisclose: async () => true, onRoleError: (error) => observed.push(error) });
    const compacted = await failingMemory.compact({ messages: input.messages, keepTail: 0, targetTokens: 20, authorizeAndDisclose: async () => true, onRoleError: (error) => observed.push(error) });
    expect(compacted.recap).toContain("tea");
    expect(observed).toHaveLength(2); expect(observed[0]).toMatchObject({ status: 429 }); expect(observed[1]).toMatchObject({ status: 429 });
    expect(calls).toEqual(["small", "main", "small", "main"]);
  } finally { vi.useRealTimers(); await failingMemory.close(); }
  calls.length = 0;
  const local = config("small", "ollama");
  const memory = makeNaiaMemory({ project: "test", storePath: join(dir, "memory.json"), consolidateOnSave: true, fallbackHeuristicOnFailure: true, roleExtractor: buildRoleMemoryExtractor(local, main, fetch, (event) => events.push(event)), roleSummarizer: buildRoleMemorySummarizer(local, main, fetch, (event) => events.push(event)) });
  try {
    await memory.ready(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() - 360_000);
    await memory.save("I like tea", ""); vi.setSystemTime(Date.now() + 360_000);
    await memory.save("hello", "", { authorizeAndDisclose: async () => true });
    const result = await memory.compact({ messages: input.messages, keepTail: 0, targetTokens: 20, authorizeAndDisclose: async () => true });
    expect((await memory.recall("tea")).facts).toContain("I like tea");
    expect(result.recap).toContain("tea");
    expect(calls).toEqual(["small", "small"]);
    expect(JSON.stringify(events)).not.toContain("private");
  } finally { vi.useRealTimers(); await memory.close(); await rm(dir, { recursive: true, force: true }); }
});

it("IT-SM-AGENT-03 공유 memory의 동시 추출·요약과 승인을 격리한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-concurrent-"));
  const approvals: string[] = []; const calls: number[] = [];
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetch = async (_url: string, init: { body: string }) => { const body = JSON.parse(init.body); calls.push(body.max_tokens); return ok(body.max_tokens === 8192 ? '{"1":["User likes tea"]}' : "approved recap"); };
  const small = config("small");
  const memory = makeNaiaMemory({ project: "test", storePath: join(dir, "memory.json"), roleExtractor: buildRoleMemoryExtractor(small, undefined, fetch, () => {}), roleSummarizer: buildRoleMemorySummarizer(small, undefined, fetch, () => {}) });
  try {
    await memory.ready(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() - 360_000);
    await memory.save("I like tea", ""); vi.setSystemTime(Date.now() + 360_000);
    const first = memory.save("first", "", { authorizeAndDisclose: async () => { approvals.push("first"); enter(); await gate; return true; } });
    await entered;
    const second = memory.save("I like coffee", "", { authorizeAndDisclose: async () => { approvals.push("second"); return false; } });
    const request = { messages: [{ role: "user" as const, content: "I like tea" }], keepTail: 0, targetTokens: 20 };
    const [allowed, rejected] = await Promise.all([
      memory.compact({ ...request, authorizeAndDisclose: async () => { approvals.push("allow-summary"); return true; } }),
      memory.compact({ ...request, authorizeAndDisclose: async () => { approvals.push("deny-summary"); return false; } }),
    ]);
    release(); await Promise.all([first, second]);
    expect(allowed.recap).toBe("approved recap"); expect(rejected.recap).not.toBe("approved recap");
    expect(approvals).toContain("first"); expect(approvals).toContain("allow-summary"); expect(approvals).toContain("deny-summary");
    expect(calls.filter((n) => n === 8192)).toHaveLength(1); expect(calls.filter((n) => n === 1024)).toHaveLength(1);
    expect(approvals).not.toContain("second"); // single-flight leaves the competing episode for a later cycle
    vi.setSystemTime(Date.now() + 360_000);
    await memory.save("third", "", { authorizeAndDisclose: async () => { approvals.push("later"); return true; } });
    expect(approvals).toContain("later"); expect(calls.filter((n) => n === 8192)).toHaveLength(2);
    expect((await memory.recall("coffee")).episodes.some((episode) => episode.content === "I like coffee")).toBe(true);
  } finally { release?.(); vi.useRealTimers(); await memory.close(); await rm(dir, { recursive: true, force: true }); }
});

it("IT-SM-AGENT-01 실제 조립에서 기억 우선, 빈 역할과 메인 선택을 보존한다", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  // @ts-expect-error JavaScript composition entry has no TypeScript declaration.
  const { composeAgentRuntimeDeps } = await import("../../scripts/builds/compose-agent-deps.mjs");
  const { makePiRoleProcessingPlans, makePiRoleSubAgent } = await import("../main/adapters/pi-role-runner.js");
  const root = await mkdtemp(join(tmpdir(), "agent-compose-memory-"));
  const models: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => { const body = JSON.parse(String(init.body)); models.push(body.model); return new Response(JSON.stringify({ choices: [{ message: { content: body.max_tokens === 8192 ? '{"1":["User likes tea"]}' : "memory recap" } }] }), { status: 200 }); }) as typeof globalThis.fetch;
  try {
    for (const mode of ["explicit", "sub", "empty"] as const) {
      const workspace = join(root, mode); await mkdir(join(workspace, "naia-settings"), { recursive: true });
      const roles = mode === "explicit" ? { sub: { provider: "nextain", model: "small" }, memory: { provider: "nextain", model: "memory" } } : mode === "sub" ? { sub: { provider: "nextain", model: "small" } } : {};
      await writeFile(join(workspace, "naia-settings", "config.json"), JSON.stringify({ provider: "nextain", model: "grok-4.3", llmRoles: roles, memoryEmbeddingProvider: "none" }));
      const deps = await composeAgentRuntimeDeps({ env: { NAIA_ADK_PATH: workspace, AGENT_PROVIDER: "fake", NAIA_AGENT_SKILLS: "off", NAIA_AGENT_TRANSCRIPT: "off", NAIA_MEMORY_SURFACING: "off", NAIA_ANYLLM_API_KEY: "fake" } });
      try {
        expect(deps.defaultConfig.model).toBe("grok-4.3");
        expect(makePiRoleProcessingPlans(deps.llmRoles).find((plan) => plan.when?.values.includes("main"))?.model).toBe("grok-4.3");
        let piArgs: readonly string[] = [];
        const pi = makePiRoleSubAgent(deps.llmRoles, "main", { env: { NAIA_API_KEY: "fake", PATH: "" }, piConfigDir: join(workspace, "pi-test"), resolveBin: () => ({ command: "fake-pi", prefixArgs: [] }), spawnFn: (_command, args) => { piArgs = args; return { stdout: { on() {} }, stderr: { on() {} }, on() { return this; }, kill() { return false; } } as unknown as import("node:child_process").ChildProcess; } });
        expect(pi.ok).toBe(true);
        if (!pi.ok) throw new Error(pi.reason);
        pi.agent.spawn({ prompt: "inspect", workdir: workspace });
        expect(piArgs).toContain("--model"); expect(piArgs).toContain("grok-4.3");
        const { ChatTurnHandler } = await import("../main/app/chat-turn-handler.js");
        const { makeInMemoryApproval } = await import("../main/adapters/approval.js");
        const { makeInMemoryCredentials } = await import("../main/composition/index.js");
        let chatModel = "";
        const handler = new ChatTurnHandler({ defaultConfig: deps.defaultConfig, provider: { async *chat(config) { chatModel = config.model; yield { kind: "text", text: "ok" }; yield { kind: "finish" }; } }, conversation: { assemble: (request) => ({ messages: request.messages }) }, credentials: makeInMemoryCredentials(), approval: makeInMemoryApproval(), egress: { emit: () => {} }, diag: { log: () => {} } });
        await handler.onChatRequest({ kind: "chat", requestId: mode, messages: [{ role: "user", content: "hi" }] });
        expect(chatModel).toBe("grok-4.3");
        vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() - 360_000);
        await deps.memory.save("I like tea", ""); vi.setSystemTime(Date.now() + 360_000);
        await deps.memory.save("hello", "", { authorizeAndDisclose: async () => true });
        const compacted = await deps.memory.compact({ messages: [{ role: "user" as const, content: "I like tea" }], keepTail: 0, targetTokens: 20, authorizeAndDisclose: async () => true });
        const recalled = await deps.memory.recall("tea");
        if (mode === "empty") { expect(models).toEqual([]); expect(recalled.facts).toContain("I like tea"); expect(compacted.recap).toContain("tea"); }
        else { expect(models).toEqual([mode === "explicit" ? "memory" : "small", mode === "explicit" ? "memory" : "small"]); expect(recalled.facts).toContain("User likes tea"); expect(compacted.recap).toBe("memory recap"); }
        models.length = 0;
      } finally { vi.useRealTimers(); await deps.memory.close(); }
    }
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
});
