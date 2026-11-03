import { describe, expect, it, vi } from "vitest";
import { axApprovalFor, type AxEffect } from "../main/domain/ax-approval-policy.js";
import { makeAxHostControlLane, makeAxPolicyToolExecutor, type AxApprovalRequest, makeAxHumanApprovalStore, type AxApprovalCard, makeAxHumanEffectBroker } from "../main/adapters/ax-policy-tool-executor.js";
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


describe("AX authenticated host control lane", () => {
  it.each(["approve", "invalidate", "dispose", "stale", "untrusted"])("%s binds fresh capture and single use", async (mode) => {
    let card!: AxApprovalCard;
    const execute = vi.fn(async () => ({ output: "receipt" }));
    const evidence = {};
    const h = makeAxHostControlLane({
      scope: () => ({ sessionId: "s", workspace: "/w", provider: "codex-ax", policyRevision: "1" }),
      diag, authenticate: (value) => value === evidence ? "human-text" : undefined,
      describe: () => ({ preview: "synthetic payload/destination" }), present: (c) => { card = c; },
      registrations: [{ spec: { name: call.name, description: "fixture", parameters: {} }, classify: () => ["external_send"], execute }],
    });
    expect(h.beginInput(evidence)).toBeUndefined();
    const pending = h.executor.execute(call, { requestId: "r" });
    expect(h.beginInput(evidence)).toBeUndefined();
    expect(h.displayed("wrong")).toBe(false);
    expect(h.displayed(card.proposalId)).toBe(true);
    expect(h.beginInput({ origin: "human-text" })).toBeUndefined();
    const token = h.beginInput(evidence)!;
    if (mode === "invalidate" || mode === "stale") h.invalidate();
    if (mode === "dispose") h.dispose();
    const ok = h.submit(mode === "untrusted" ? {} : token, { text: "보내", final: true });
    expect(ok).toBe(mode === "approve");
    if (mode === "untrusted") h.dispose();
    expect(h.submit(token, { text: "보내", final: true })).toBe(false);
    if (mode !== "approve") h.dispose();
    expect((await pending).isError ?? false).toBe(mode !== "approve");
    expect(execute).toHaveBeenCalledTimes(mode === "approve" ? 1 : 0);
    h.dispose();
  });
});

// FR-AX-026.12: loopback service, no external accounts or credentials.
import { createServer } from "node:http";
import { makeAxConnectorRegistrations, makeAxEffectBroker } from "../main/adapters/ax-policy-tool-executor.js";

describe("AX connector fake service", () => {
  async function fixture(run: (f: { broker: ToolExecutorPort; requests: string[]; approve: (v: boolean) => void;
    setUnknown: () => void; setSlow: () => void; restart: () => ToolExecutorPort }) => Promise<void>) {
    const requests: string[] = [];
    const receipts = new Map<string, { digest: string; receipt: string }>();
    let allowed = true, unknown = false, slow = false;
    const server = createServer(async (req, res) => {
      const key = req.url!.slice(1);
      requests.push(req.method!);
      if (req.method === "GET") {
        res.end(JSON.stringify(unknown ? { status: "unknown" } : receipts.has(key)
          ? { status: "found", ...receipts.get(key) } : { status: "absent" }));
      } else {
        let body = "";
        for await (const part of req) body += part;
        const { digest, call: receivedCall } = JSON.parse(body);
        const actualDigest = createHash("sha256").update(JSON.stringify({ name: receivedCall.name, args: receivedCall.args })).digest("hex");
        if (actualDigest !== digest) { res.writeHead(409); res.end(); return; }
        const prior = receipts.get(key);
        if (prior && prior.digest !== digest) { res.writeHead(409); res.end(); return; }
        receipts.set(key, { digest, receipt: "event-1" });
        if (slow) { setTimeout(() => res.end(JSON.stringify({ receipt: "event-1" })), 1500).unref(); }
        else res.end(JSON.stringify({ receipt: "event-1" }));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address() as { port: number };
    const endpoint = `http://127.0.0.1:${address.port}/operation`;
    const registrations = makeAxConnectorRegistrations({ verifyReceipt: async (_key, digest, receipt) => receipts.get("operation")?.digest === digest && receipt === "event-1", keyFor: () => "host-operation", diag, timeoutMs: 1000,
      draft: async () => ({ output: "local draft" }),
      lookup: async (_key, digest, signal) => {
        const response = await fetch(endpoint, { signal });
        const value = await response.json() as { status: "found"; digest: string; receipt: string } | { status: "absent" | "unknown" };
        if (value.status === "found" && value.digest !== digest) throw new Error("Conflict");
        return value;
      },
      write: async (_key, digest, call, signal) => {
        const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ digest, call }), signal });
        if (!response.ok) throw new Error("Conflict");
        return (await response.json() as { receipt: string }).receipt;
      } });
    const broker = makeAxEffectBroker({ registrations, conversationApproval: async () => allowed, diag });
    try { await run({ broker, requests, approve: (v) => { allowed = v; }, setUnknown: () => { unknown = true; }, setSlow: () => { slow = true; },
      restart: () => makeAxEffectBroker({ registrations: makeAxConnectorRegistrations({ verifyReceipt: async (_key, digest, receipt) => receipts.get("operation")?.digest === digest && receipt === "event-1", keyFor: () => "host-operation", diag,
        draft: async () => ({ output: "local draft" }),
        lookup: async (_key, _digest, signal) => (await (await fetch(endpoint, { signal })).json()) as { status: "found"; receipt: string },
        write: async () => { throw new Error("Recovery must not write"); } }), conversationApproval: async () => allowed, diag }) }); }
    finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
  }
  const event = { id: "event", name: "calendar_create", args: { title: "synthetic", start: "2026-11-07T10:00:00+09:00", end: "2026-11-07T11:00:00+09:00", timeZone: "Asia/Seoul" } };
  it("registers one approved event; duplicate queries first with no second write", async () => fixture(async ({ broker, requests }) => {
    expect((await broker.execute(event, {})).isError).not.toBe(true);
    expect(JSON.parse((await broker.execute({ ...event, id: "retry" }, {})).output)).toEqual({ reference: expect.any(String), recovered: true });
    expect(requests).toEqual(["GET", "POST", "GET"]);
  }));
  it("cancelled approval performs zero service requests; local draft needs none", async () => fixture(async ({ broker, requests, approve }) => {
    approve(false);
    expect((await broker.execute(event, {})).isError).toBe(true);
    expect(await broker.execute({ id: "draft", name: "document_draft", args: {} }, {})).toEqual({ output: "local draft" });
    expect((await broker.execute({ id: "send", name: "document_send", args: { body: "synthetic" } }, {})).isError).toBe(true);
    expect(requests).toEqual([]);
  }));
  it.each([
    { timeZone: "Invalid/Zone" }, { start: "2026-11-07T10:00:00" },
    { timeZone: "America/New_York" }, { end: "2026-11-07T09:00:00+09:00" },
    { start: "2026-02-30T10:00:00+09:00" },
  ])("rejects invalid time before service requests %j", async (change) => fixture(async ({ broker, requests }) => {
    expect((await broker.execute({ ...event, args: { ...event.args, ...change } }, {})).isError).toBe(true);
    expect(requests).toEqual([]);
  }));
  it("unknown lookup cannot write", async () => fixture(async ({ broker, requests, setUnknown }) => {
    setUnknown(); expect((await broker.execute(event, {})).isError).toBe(true);
    expect(requests).toEqual(["GET"]);
  }));
  it("lost write response is recovered by lookup, without resend", async () => fixture(async ({ broker, requests, setSlow }) => {
    setSlow(); expect((await broker.execute(event, {})).isError).toBe(true);
    expect(JSON.parse((await broker.execute(event, {})).output).recovered).toBe(true);
    expect(requests).toEqual(["GET", "POST", "GET"]);
  }));
  it("fresh connector recovers committed receipt after restart", async () => fixture(async ({ broker, requests, restart }) => {
    await broker.execute(event, {});
    expect(JSON.parse((await restart().execute(event, {})).output).recovered).toBe(true);
    expect(requests).toEqual(["GET", "POST", "GET"]);
  }));
  it("approved document send writes once and retry queries", async () => fixture(async ({ broker, requests }) => {
    const send = { id: "send", name: "document_send", args: { destination: "synthetic", body: "synthetic" } };
    expect((await broker.execute(send, {})).isError).not.toBe(true);
    expect(JSON.parse((await broker.execute(send, {})).output).recovered).toBe(true);
    expect(requests).toEqual(["GET", "POST", "GET"]);
  }));
  it("concurrent duplicates cannot create two writes", async () => fixture(async ({ broker, requests, setSlow }) => {
    setSlow();
    await Promise.all([broker.execute(event, {}), broker.execute(event, {})]);
    expect(requests.filter((method) => method === "POST")).toHaveLength(1);
  }));
  it("aborted request never reaches the service", async () => fixture(async ({ broker, requests }) => {
    const controller = new AbortController(); controller.abort();
    await expect(broker.execute(event, { signal: controller.signal })).rejects.toBeDefined();
    expect(requests).toEqual([]);
  }));
  it("rejects changed payload under an existing host key", async () => fixture(async ({ broker, requests }) => {
    await broker.execute(event, {});
    expect((await broker.execute({ ...event, args: { ...event.args, title: "changed" } }, {})).isError).toBe(true);
    expect(requests).toEqual(["GET", "POST", "GET"]);
  }));
});

// Synthetic fixtures only. No customer documents, credentials or approval codes.
import { makeAxDocumentLifecycle } from "../main/adapters/ax-policy-tool-executor.js";
import { createHash } from "node:crypto";

describe("FR-AX-026.13 synthetic document lifecycle", () => {
  const secret = "SYNTHETIC-document-key-code-PII@example.invalid";
  function fixture() {
    let now = 99;
    const documents = new Map([[secret, "SYNTHETIC customer body"]]);
    const audit = vi.fn(async (_event: unknown) => {});
    const diag = { log: vi.fn(), debug: vi.fn() };
    const remove = vi.fn(async (key: string) => { documents.delete(key); });
    const lifecycle = makeAxDocumentLifecycle({ now: () => now, remove,
      exists: async (key) => documents.has(key), audit, diag });
    return { lifecycle, documents, audit, diag, remove, advance: (n: number) => { now = n; } };
  }
  it("retains before expiry, removes at boundary, retries safely without PII audit", async () => {
    const f = fixture(); const record = { storageKey: secret, expiresAt: 100 };
    expect((await f.lifecycle.check(record)).status).toBe("retained");
    expect(f.documents.size).toBe(1); expect(f.remove).not.toHaveBeenCalled();
    f.advance(100);
    const expired = await f.lifecycle.check(record);
    expect(expired.status).toBe("expired"); expect(f.documents.size).toBe(0);
    expect((await f.lifecycle.check(record)).status).toBe("expired");
    expect(JSON.stringify([f.audit.mock.calls, f.diag.debug.mock.calls, expired])).not.toContain(secret);
    expect(f.audit.mock.calls.map(([event]) => (event as { action: string }).action)).toEqual(["retained", "expired", "expired"]);
  });
  it("explicit deletion confirms absence; residual copies fail closed", async () => {
    const f = fixture(); f.remove.mockImplementationOnce(async () => {});
    expect(await f.lifecycle.check({ storageKey: secret, expiresAt: 100 }, true)).toEqual({ status: "unresolved" });
    expect(f.audit).not.toHaveBeenCalled();
    expect((await f.lifecycle.check({ storageKey: secret, expiresAt: 100 }, true)).status).toBe("deleted");
    expect(f.documents.size).toBe(0);
  });
  it("audit outage and storage errors never report successful deletion", async () => {
    const f = fixture(); f.remove.mockRejectedValueOnce(new Error(secret));
    expect(await f.lifecycle.check({ storageKey: secret, expiresAt: 100 }, true)).toEqual({ status: "unresolved" });
    f.audit.mockRejectedValueOnce(new Error(secret));
    expect(await f.lifecycle.check({ storageKey: secret, expiresAt: 100 }, true)).toEqual({ status: "unresolved" });
    expect(f.documents.size).toBe(0);
    expect((await f.lifecycle.check({ storageKey: secret, expiresAt: 100 }, true)).status).toBe("deleted");
  });
  it.each([NaN, Infinity, -Infinity])("rejects invalid expiry %s without touching storage", async (expiresAt) => {
    const f = fixture();
    expect(await f.lifecycle.check({ storageKey: secret, expiresAt })).toEqual({ status: "unresolved" });
    expect(f.remove).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled();
  });
  it("rejects invalid host clock and absent retained document", async () => {
    const f = fixture(); f.advance(NaN);
    expect((await f.lifecycle.check({ storageKey: secret, expiresAt: 100 })).status).toBe("unresolved");
    f.advance(99); f.documents.clear();
    expect((await f.lifecycle.check({ storageKey: secret, expiresAt: 100 })).status).toBe("unresolved");
  });
});

describe("FR-AX-026.13 approval receipt versus actual synthetic effect", () => {
  it.each([false, true])("verifies new and recovered effects; recovered=%s", async (recovered) => {
    const payload = { id: "synthetic", name: "document_send", args: { body: "SYNTHETIC PII body", to: "synthetic@example.invalid" } };
    const expectedDigest = createHash("sha256").update(JSON.stringify({ name: payload.name, args: payload.args })).digest("hex");
    const remoteReceipt = "SYNTHETIC raw body / private-key / approval-code";
    let actualDigest = "changed destination";
    const verifyReceipt = vi.fn(async (key: string, digest: string, receipt: string) =>
      key === "private-storage-key" && receipt === remoteReceipt && actualDigest === digest);
    const write = vi.fn(async () => remoteReceipt);
    const diag = { log: vi.fn(), debug: vi.fn() };
    const broker = makeAxEffectBroker({ diag, conversationApproval: async () => true,
      registrations: makeAxConnectorRegistrations({ diag, keyFor: () => "private-storage-key",
        draft: async () => ({ output: "draft" }), write, verifyReceipt,
        lookup: async () => recovered ? { status: "found", receipt: remoteReceipt } : { status: "absent" } }) });
    const mismatch = await broker.execute(payload, {});
    expect(mismatch.isError).toBe(true);
    actualDigest = expectedDigest;
    const matched = await broker.execute(payload, {});
    expect(matched.isError).not.toBe(true);
    expect(JSON.parse(matched.output)).toEqual({ reference: expect.any(String), recovered });
    expect(verifyReceipt).toHaveBeenCalledWith("private-storage-key", expectedDigest, remoteReceipt, expect.any(AbortSignal));
    if (recovered) expect(write).not.toHaveBeenCalled();
    const modelAndLogs = JSON.stringify([mismatch, matched, diag.debug.mock.calls, diag.log.mock.calls]);
    for (const sensitive of [remoteReceipt, payload.args.body, payload.args.to, "private-storage-key"]) expect(modelAndLogs).not.toContain(sensitive);
  });
  it("verification exception is sanitized and does not leak into model result", async () => {
    const registrations = makeAxConnectorRegistrations({ keyFor: () => "key", diag,
      draft: async () => ({ output: "draft" }), lookup: async () => ({ status: "absent" }),
      write: async () => "private receipt", verifyReceipt: async () => { throw new Error("secret code"); } });
    const broker = makeAxEffectBroker({ registrations, diag, conversationApproval: async () => true });
    expect(await broker.execute({ id: "1", name: "document_send", args: {} }, {})).toEqual({ output: "AX connector unresolved; query before retry", isError: true });
  });
});

// Execute the peer's actual draft without importing its UI logger/runtime.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
async function pairedAdapter() {
  const source = readFileSync(resolve(process.env.NAIA_SHELL_ROOT ?? "../026-shell",
    "packages/shell/src/lib/ax-approval-adapter.ts"), "utf8");
  const compiled = ts.transpileModule(source.replace('import { Logger } from "./logger";',
    'const Logger = { debug() {} };'), { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext } }).outputText;
  return (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`)).makeAxApprovalAdapter;
}

describe.skipIf(!process.env.NAIA_SHELL_ROOT)("r9 paired shell adapter", () => {
  it.each(["approve", "no-ack", "forged", "bad-origin", "auth-error", "scope", "scope-error", "invalidate", "dispose", "code", "voice-code"])(
    "%s crosses the real peer adapter and registered executor", async (mode) => {
      const makeAdapter = await pairedAdapter();
      let card!: AxApprovalCard; let code: string | undefined;
      let workspace = "/w"; let scopeError = false;
      const evidence = Object.freeze({});
      const execute = vi.fn(async () => ({ output: "receipt" }));
      let adapter: ReturnType<typeof makeAdapter>;
      const lane = makeAxHostControlLane({ diag,
        scope: () => { if (scopeError) throw new Error("fixture scope failure");
          return { sessionId: "s", workspace, provider: "codex-ax", policyRevision: "1" }; },
        authenticate: (value) => {
          if (mode === "auth-error") throw new Error("fixture auth failure");
          if (mode === "bad-origin") return "model" as "human-text";
          return value === evidence ? (mode === "voice-code" ? "human-voice" : "human-text") : undefined;
        },
        describe: () => ({ preview: "synthetic destination/payload", reviewedPlanDigest: "reviewed-plan" }),
        present: (c, secret) => { card = c; code = secret; adapter.present(c); },
        registrations: [{ spec: { name: call.name, description: "fixture", parameters: {} },
          classify: () => [mode === "code" || mode === "voice-code" ? "production_change" : "external_send"], execute }],
      });
      adapter = makeAdapter(lane);
      const pending = lane.executor.execute(call, { requestId: "r9" });
      expect(adapter.beginInput(evidence)).toBe(false);
      expect(adapter.displayed("wrong")).toBe(false);
      if (mode !== "no-ack") expect(adapter.displayed(card.proposalId)).toBe(true);
      const captured = adapter.beginInput(mode === "forged" ? { origin: "human-text" } : evidence);
      expect(captured).toBe(!["no-ack", "forged", "bad-origin", "auth-error"].includes(mode));
      if (mode === "scope") workspace = "/changed";
      if (mode === "scope-error") scopeError = true;
      if (mode === "invalidate") adapter.invalidate();
      if (mode === "dispose") adapter.dispose();
      const approved = mode === "approve" || mode === "code";
      expect(adapter.submit(code ?? "보내")).toBe(approved);
      expect(adapter.submit(code ?? "보내")).toBe(false);
      if (!approved) adapter.dispose();
      expect((await pending).isError ?? false).toBe(!approved);
      adapter.dispose();
      expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
      if (code) {
        expect(JSON.stringify(card)).not.toContain(code);
        expect(JSON.stringify(diag.debug.mock.calls)).not.toContain(code);
      }
    });
});

describe("r9 Agent capture failure boundaries", () => {
  it.each(["origin", "auth-error", "scope", "scope-error", "equivalent-scope"])("%s is checked without a peer checkout", async (mode) => {
    let card!: AxApprovalCard; let changed = false;
    const execute = vi.fn(async () => ({ output: "receipt" }));
    const lane = makeAxHostControlLane({ diag,
      scope: () => {
        if (changed && mode === "scope-error") throw new Error("fixture");
        if (changed && mode === "equivalent-scope") return { provider: "codex-ax", policyRevision: "1", workspace: "/w", sessionId: "s" };
        return { sessionId: "s", workspace: changed ? "/changed" : "/w", provider: "codex-ax", policyRevision: "1" };
      },
      authenticate: () => {
        if (mode === "auth-error") throw new Error("fixture");
        return mode === "origin" ? "model" as "human-text" : "human-text";
      },
      describe: () => ({ preview: "synthetic payload" }), present: c => { card = c; },
      registrations: [{ spec: { name: call.name, description: "fixture", parameters: {} }, classify: () => ["external_send"], execute }],
    });
    const pending = lane.executor.execute(call, { requestId: "r9" });
    lane.displayed(card.proposalId);
    const token = lane.beginInput({});
    if (mode === "origin" || mode === "auth-error") expect(token).toBeUndefined();
    changed = true;
    const approved = mode === "equivalent-scope";
    expect(lane.submit(token ?? {}, { text: "보내", final: true })).toBe(approved);
    if (!approved) lane.dispose();
    expect((await pending).isError ?? false).toBe(!approved);
    expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
    lane.dispose();
  });
});
