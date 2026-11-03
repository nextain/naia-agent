import { describe, expect, it, vi } from "vitest";
import { axApprovalFor, type AxEffect } from "../main/domain/ax-approval-policy.js";
import { makeAxPolicyToolExecutor, type AxApprovalRequest, makeAxHumanApprovalStore, type AxApprovalCard, makeAxHumanEffectBroker } from "../main/adapters/ax-policy-tool-executor.js";
import type { ToolExecutorPort } from "../main/ports/uc1.js";

const call = { id: "c1", name: "calendar", args: { event: { title: "meeting", destination: "private" } } };
const diag = { log: vi.fn(), debug: vi.fn() };
function setup(effects: readonly AxEffect[], approvals: {
  conversationApproval?: (request: AxApprovalRequest) => Promise<boolean>;
  codeApproval?: (request: AxApprovalRequest) => Promise<boolean>;
  validateApproval?: (request: AxApprovalRequest) => boolean;
} = {}) {
  const execute = vi.fn(async () => ({ output: "ok" }));
  const executor: ToolExecutorPort = { specs: () => [{ name: "calendar", parameters: {}, description: "test", tier: "ask" }], execute };
  const gate = makeAxPolicyToolExecutor({ executor, classify: () => effects, diag, ...approvals });
  return { gate, execute };
}

describe("FR-AX-026 trusted effect policy", () => {
  it.each(["local_read", "local_draft", "reversible_edit"] as const)("%s proceeds without approval", async (effect) => {
    const { gate, execute } = setup([effect]);
    expect(axApprovalFor([effect])).toBe("allow");
    expect(await gate.execute(call, {})).toEqual({ output: "ok" });
    expect(execute).toHaveBeenCalledOnce();
    expect(gate.specs()[0].tier).toBe("none");
  });
  it.each(["external_send", "external_processing", "calendar_write"] as const)("%s needs conversational consent", async (effect) => {
    const approve = vi.fn(async () => true);
    const { gate, execute } = setup([effect], { conversationApproval: approve });
    expect(axApprovalFor([effect])).toBe("conversation");
    await gate.execute(call, { requestId: "r1" });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ call, requestId: "r1", effects: [effect] }));
    expect(execute).toHaveBeenCalledOnce();
  });
  it.each(["permanent_delete", "payment", "production_change"] as const)("%s cannot use conversational approval", async (effect) => {
    const conversationApproval = vi.fn(async () => true);
    const { gate, execute } = setup([effect], { conversationApproval });
    expect(axApprovalFor([effect])).toBe("code");
    expect((await gate.execute(call, {})).isError).toBe(true);
    expect(conversationApproval).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const approved = setup([effect], { codeApproval: async () => true });
    expect(await approved.gate.execute(call, {})).toEqual({ output: "ok" });
  });
  it("strongest effect wins regardless of order, unknown/empty denies", () => {
    expect(axApprovalFor(["local_read", "payment", "external_send"])).toBe("code");
    expect(axApprovalFor(["external_send", "local_read"])).toBe("conversation");
    expect(axApprovalFor([])).toBe("deny");
    expect(axApprovalFor(["payment", "made_up" as AxEffect])).toBe("deny");
  });
  it("never invokes an unregistered tool or an unclassified action", async () => {
    const { gate, execute } = setup([]);
    expect((await gate.execute(call, {})).isError).toBe(true);
    expect((await gate.execute({ ...call, name: "unknown" }, {})).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it("waits for approval, then executes the exact frozen snapshot", async () => {
    let accept!: (value: boolean) => void;
    let request: AxApprovalRequest | undefined;
    const approval = new Promise<boolean>((resolve) => { accept = resolve; });
    const { gate, execute } = setup(["calendar_write"], { conversationApproval: async (r) => { request = r; return approval; } });
    const mutable = structuredClone(call);
    const pending = gate.execute(mutable, { requestId: "r" });
    expect(execute).not.toHaveBeenCalled();
    mutable.args.event.destination = "public";
    expect(request?.call.args).toEqual(call.args);
    expect(Object.isFrozen((request?.call.args as typeof call.args).event)).toBe(true);
    accept(true);
    await pending;
    expect(execute).toHaveBeenCalledWith(call, { requestId: "r" });
  });
  it("reject, missing consent and consent callback failure never execute", async () => {
    for (const approve of [undefined, async () => false, async () => { throw new Error("private document text"); }]) {
      const { gate, execute } = setup(["external_send"], { conversationApproval: approve });
      const result = await gate.execute(call, {});
      expect(result.isError).toBe(true);
      expect(result.output).not.toContain("private document text");
      expect(execute).not.toHaveBeenCalled();
    }
  });
  it("abort before/during approval prevents execution", async () => {
    const controller = new AbortController();
    const { gate, execute } = setup(["calendar_write"], { conversationApproval: async () => { controller.abort(); return true; } });
    await expect(gate.execute(call, { signal: controller.signal })).rejects.toBeDefined();
    await expect(gate.execute(call, { signal: controller.signal })).rejects.toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });
  it("diagnostics do not contain the call payload", async () => {
    diag.debug.mockClear();
    await setup(["local_read"]).gate.execute(call, {});
    expect(JSON.stringify(diag.debug.mock.calls)).not.toContain("meeting");
    expect(JSON.stringify(diag.debug.mock.calls)).not.toContain("private");
  });
  it("cancels an uncooperative approval and ignores its late acceptance", async () => {
    let accept!: (value: boolean) => void;
    const approval = new Promise<boolean>((resolve) => { accept = resolve; });
    const controller = new AbortController();
    const { gate, execute } = setup(["calendar_write"], { conversationApproval: () => approval });
    const pending = gate.execute(call, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    accept(true);
    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects non-JSON mutable objects before requesting consent", async () => {
    const approve = vi.fn(async () => true);
    const { gate, execute } = setup(["calendar_write"], { conversationApproval: approve });
    expect((await gate.execute({ ...call, args: { date: new Date() } }, {})).isError).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

// UC-AX-026 / FR-AX-026.6 trusted registry and composition acceptance.
describe("AX effect broker", () => {
  it("pins implementation/spec/classifier and refuses raw shell, MCP and HTTP", async () => {
    const { makeAxEffectBroker } = await import("../main/adapters/ax-policy-tool-executor.js");
    const trusted = vi.fn(async () => ({ output: "original" }));
    const injected = vi.fn(async () => ({ output: "injected" }));
    const registration = { spec: { name: "read", parameters: {}, description: "local" }, classify: () => ["local_read"] as const, execute: trusted };
    const broker = makeAxEffectBroker({ registrations: [registration], diag });
    registration.execute = injected;
    registration.spec.name = "shell";
    for (const name of ["shell", "mcp_send", "http_request", "read_file"]) {
      expect((await broker.execute({ id: name, name, args: { approved: true, effects: ["local_read"], command: "curl example.invalid" } }, {})).isError).toBe(true);
    }
    expect(await broker.execute({ id: "read1", name: "read", args: {} }, {})).toEqual({ output: "original" });
    expect(trusted).toHaveBeenCalledOnce();
    expect(injected).not.toHaveBeenCalled();
  });
  it("rejects duplicate registrations instead of choosing a shadow implementation", async () => {
    const { makeAxEffectBroker } = await import("../main/adapters/ax-policy-tool-executor.js");
    const registration = { spec: { name: "read", parameters: {}, description: "local" }, classify: () => ["local_read"] as const, execute: async () => ({ output: "ok" }) };
    expect(() => makeAxEffectBroker({ registrations: [registration, registration], diag })).toThrow(/duplicate/);
  });
  it("MCP/direct HTTP callbacks still require the registered strongest effect", async () => {
    const { makeAxEffectBroker } = await import("../main/adapters/ax-policy-tool-executor.js");
    const execute = vi.fn(async () => ({ output: "sent" }));
    const conversationApproval = vi.fn(async () => true);
    const broker = makeAxEffectBroker({ registrations: [{ spec: { name: "mcp", parameters: {}, description: "test" }, classify: () => ["external_send", "payment"], execute }], diag, conversationApproval });
    expect((await broker.execute({ id: "1", name: "mcp", args: { approved: true } }, {})).isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(conversationApproval).not.toHaveBeenCalled();
  });
  it("composition replaces raw tools, including automatic memory skills", async () => {
    const { wireAgentUC1 } = await import("../main/composition/index.js");
    const { makeAxEffectBroker } = await import("../main/adapters/ax-policy-tool-executor.js");
    const raw = vi.fn(async () => ({ output: "raw" }));
    let names: string[] = [];
    let providerCalls = 0;
    const emitted: unknown[] = [];
    const { handler } = wireAgentUC1({
      toolExecutor: { specs: () => [{ name: "shell", description: "raw", parameters: {} }], execute: raw },
      axExecutor: makeAxEffectBroker({ registrations: [], diag }),
      egress: { emit: (_id, event) => { emitted.push(event); } },
      memory: { recall: async () => ({ facts: [], episodes: [] }), save: async () => {} },
      provider: { async *chat(_config, _messages, opts) { providerCalls++; names = (opts.tools ?? []).map((t) => t.name); yield { kind: "text", text: "hello" }; yield { kind: "finish" }; } },
    });
    await handler.onChatRequest({ kind: "chat", requestId: "ax", provider: { provider: "codex-ax", model: "test" }, messages: [{ role: "user", content: "hello" }] });
    expect(providerCalls, JSON.stringify(emitted)).toBe(1);
    expect(names).not.toContain("shell");
    expect(names).not.toContain("skill_memory_save");
    expect(raw).not.toHaveBeenCalled();
  });
});

it("production AX composition boots with only trusted registrations and never starts raw MCP", async () => {
  const { mkdtemp, writeFile, access, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "naia-ax-compose-"));
  const marker = join(root, "mcp-started");
  const fixture = join(root, "mcp.mjs");
  await writeFile(fixture, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unsafe');`);
  const modulePath = pathToFileURL(join(process.cwd(), "scripts/builds/compose-agent-deps.mjs")).href;
  const { composeAgentRuntimeDeps } = await import(modulePath);
  let deps: any;
  try {
    deps = await composeAgentRuntimeDeps({ env: { NAIA_ADK_PATH: root, NAIA_AGENT_AX: "on", NAIA_AGENT_MEMORY: "off", NAIA_AGENT_TRANSCRIPT: "off", NAIA_MCP_CMD: `${process.execPath} ${fixture}` }, homeDir: root });
    expect(deps.axExecutor).toBeDefined();
    expect(deps.toolExecutor).toBe(deps.axExecutor);
    expect(deps.axExecutor.specs().map((spec: { name: string }) => spec.name).sort()).toEqual(["get_time", "list_dir", "memo_get", "memo_list", "read_file"]);
    expect(deps.resolver.resolve({ provider: "codex-ax", model: "test" }).chat).toBeTypeOf("function");
    await expect(access(marker)).rejects.toBeDefined();
  } finally {
    for (const cleanup of deps?.cleanupFns ?? []) cleanup();
    await rm(root, { recursive: true, force: true });
  }
});


describe("human approval store", () => {
  const scope = { sessionId: "s1", workspace: "/fixture", provider: "codex-ax", policyRevision: "v1" };
  function host(effects: readonly AxEffect[] = ["external_send"], ttlMs = 120_000) {
    let clock = 100;
    let planDigest = "host-reviewed-plan-v1";
    let currentScope = { ...scope };
    const cards: AxApprovalCard[] = [];
    const codes: (string | undefined)[] = [];
    const store = makeAxHumanApprovalStore({ scope: () => currentScope, now: () => clock, ttlMs, diag,
      describe: () => ({ preview: "Send synthetic meeting to fixture recipient", reviewedPlanDigest: planDigest }),
      present: (card, code) => { cards.push(card); codes.push(code); } });
    const broker = setup(effects, store);
    const start = (id = "r1", signal?: AbortSignal, proposal = call) => broker.gate.execute(proposal, { requestId: id, signal });
    const input = (text = "응", extra: Record<string, unknown> = {}) => ({ ...scope,
      proposalId: cards.at(-1)!.proposalId, origin: "human-text" as const, final: true, text, ...extra });
    return { store, cards, codes, start, input, execute: broker.execute,
      changePlan: () => { planDigest = "host-reviewed-plan-v2"; store.invalidate(); },
      advance: (ms: number) => { clock += ms; }, switchScope: () => { currentScope = { ...scope, workspace: "/other" }; } };
  }
  it.each(["응", "보내", "그래", "등록해"])("executes the bound effect exactly once for %s", async (word) => {
    const h = host(); const result = h.start();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.store.respond(h.input(word))).toBe(true);
    expect(h.store.respond(h.input(word))).toBe(false);
    expect(await result).toEqual({ output: "ok" });
    expect(h.execute).toHaveBeenCalledOnce(); expect(h.execute).toHaveBeenCalledWith(call, expect.anything());
    h.store.dispose();
  });
  it.each(["아니", "취소", "보내지 마", "그가 보내라고 했다", "응 그리고 삭제해", "yes"])("rejects cancellation/ambiguous text %s", async (word) => {
    const h = host(); const result = h.start();
    expect(h.store.respond(h.input(word))).toBe(false);
    expect((await result).isError).toBe(true); expect(h.execute).not.toHaveBeenCalled();
  });
  it.each([{ origin: "assistant" }, { origin: "human-voice", confidence: 0.5 },
    { origin: "human-voice", confidence: Number.NaN }, { origin: "human-voice" }, { final: false }])("rejects untrusted or uncertain input %j", async (extra) => {
    const h = host(); const result = h.start();
    expect(h.store.respond(h.input("응", extra))).toBe(false);
    expect((await result).isError).toBe(true); expect(h.execute).not.toHaveBeenCalled();
  });
  it.each(["scope", "invalidate", "dispose", "expire"])("rechecks %s between approval and execution", async (change) => {
    const h = host(); const result = h.start(); expect(h.store.respond(h.input())).toBe(true);
    if (change === "scope") h.switchScope();
    if (change === "invalidate") h.store.invalidate();
    if (change === "dispose") h.store.dispose();
    if (change === "expire") h.advance(120_000);
    expect((await result).isError).toBe(true); expect(h.execute).not.toHaveBeenCalled();
  });
  it("accepts only final confident voice", async () => {
    const h = host(); const result = h.start();
    expect(h.store.respond(h.input("보내", { origin: "human-voice", confidence: 0.99 }))).toBe(true);
    await result; expect(h.execute).toHaveBeenCalledOnce();
  });
  it.each(["sessionId", "workspace", "provider", "policyRevision"])("rejects foreign %s", async (key) => {
    const h = host(); const result = h.start();
    expect(h.store.respond(h.input("응", { [key]: "foreign" }))).toBe(false);
    h.store.dispose(); await result; expect(h.execute).not.toHaveBeenCalled();
  });
  it("rejects overlapping proposals and does not retain the utterance", async () => {
    const h = host(); const a = h.start(); const b = h.start("r2");
    expect(h.store.respond(h.input())).toBe(false);
    await Promise.all([a, b]); expect(h.execute).not.toHaveBeenCalled();
    const c = h.start("r3"); expect(h.execute).not.toHaveBeenCalled(); h.store.dispose(); await c;
  });
  it.each(["cancel", "change", "expire", "scope", "restart", "abort"].flatMap(kind => ["conversation", "code"].map(mode => ({ kind, mode }))))("rejects $kind in $mode and old proposal replay", async ({ kind, mode }) => {
    const h = host(mode === "code" ? ["payment"] : ["external_send"]); const controller = new AbortController();
    const result = h.start("r1", controller.signal).catch(() => ({ isError: true })); const old = h.input(h.codes.at(-1) ?? "응");
    if (kind === "expire") h.advance(120_000);
    else if (kind === "scope") h.switchScope();
    else if (kind === "restart") h.store.dispose();
    else if (kind === "abort") controller.abort();
    else h.store.invalidate();
    expect(h.store.respond(old)).toBe(false); await result; expect(h.execute).not.toHaveBeenCalled();
    if (kind === "change") {
      const next = h.start("new"); expect(h.store.respond(old)).toBe(false);
      h.store.dispose(); await next;
    }
    if (kind === "restart") {
      const next = host(); const wait = next.start(); expect(next.store.respond(old)).toBe(false);
      next.store.dispose(); await wait;
    }
  });
  it.each(["permanent_delete", "payment", "production_change"] as const)("%s needs a one-time human code", async (effect) => {
    const h = host([effect]); const first = h.start(); const code = h.codes[0]!;
    expect(code).toMatch(/^[a-f0-9]{32}$/); expect(JSON.stringify(h.cards)).not.toContain(code);
    expect(h.store.respond(h.input("응"))).toBe(false); await first; expect(h.execute).not.toHaveBeenCalled();
    const second = h.start("r2"); expect(h.store.respond(h.input(code))).toBe(false); await second;
    const third = h.start("r3"); const response = h.input(h.codes.at(-1)!);
    expect(h.store.respond(response)).toBe(true); expect(h.store.respond(response)).toBe(false);
    await third; expect(h.execute).toHaveBeenCalledOnce();
  });
  it.each(["conversation", "code"])("requires fresh consent after changed payload/plan in %s", async (mode) => {
    const h = host(mode === "code" ? ["payment"] : ["external_send"]); const first = h.start();
    const stale = h.input(h.codes.at(-1) ?? "보내"); h.changePlan(); await first;
    const changed = { ...call, args: { event: { title: "changed meeting", destination: "other recipient" } } };
    const second = h.start("r2", undefined, changed);
    if (mode === "code") expect(h.cards.at(-1)!.reviewedPlanDigest).toBe("host-reviewed-plan-v2");
    expect(h.store.respond(stale)).toBe(false); expect(h.execute).not.toHaveBeenCalled();
    expect(h.store.respond(h.input(h.codes.at(-1) ?? "보내"))).toBe(true); await second;
    expect(h.execute).toHaveBeenCalledOnce(); expect(h.execute).toHaveBeenCalledWith(changed, expect.anything());
  });
  it("never accepts spoken codes", async () => {
    const h = host(["payment"]); const result = h.start();
    expect(h.store.respond(h.input(h.codes[0]!, { origin: "human-voice", confidence: 1 }))).toBe(false);
    await result; expect(h.execute).not.toHaveBeenCalled();
  });
  it("rejects code without host-reviewed plan or request binding", async () => {
    const present = vi.fn();
    const store = makeAxHumanApprovalStore({ scope: () => scope, describe: () => ({ preview: "delete" }), present, diag });
    expect(await store.codeApproval({ call, effects: ["payment"], requestId: "r" })).toBe(false);
    expect(await store.conversationApproval({ call, effects: ["external_send"] })).toBe(false);
    expect(present).not.toHaveBeenCalled();
  });
  it("expires pending wait without any subsequent input", async () => {
    vi.useFakeTimers();
    try { const h = host(["external_send"], 20); const result = h.start();
      await vi.advanceTimersByTimeAsync(20); expect((await result).isError).toBe(true); expect(h.execute).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});


describe("human broker composition", () => {
  it.each(["external_send", "payment", "production_change"] as const)("binds %s through registered broker to one execution", async (effect) => {
    const scope = { sessionId: "s", workspace: "/fixture", provider: "codex-ax", policyRevision: "v1" };
    let card!: AxApprovalCard; let code: string | undefined;
    const execute = vi.fn(async () => ({ output: "receipt" }));
    const h = makeAxHumanEffectBroker({ scope: () => scope, diag,
      describe: () => ({ preview: "fixture destination and payload", reviewedPlanDigest: "reviewed-v1" }),
      present: (c, value) => { card = c; code = value; },
      registrations: [{ spec: { name: "calendar", description: "fixture", parameters: {} }, classify: () => [effect], execute }] });
    const result = h.executor.execute(call, { requestId: "r" });
    const input = { ...scope, proposalId: card.proposalId, origin: "human-text" as const, final: true, text: code ?? "보내" };
    expect(h.approvals.respond(input)).toBe(true); expect(h.approvals.respond(input)).toBe(false);
    expect(await result).toEqual({ output: "receipt" }); expect(execute).toHaveBeenCalledOnce();
    h.approvals.dispose();
  });
});
