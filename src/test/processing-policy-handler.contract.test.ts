import { describe, expect, it, vi } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { AgentEmit, ChatRequest, ProviderChunk } from "../main/domain/chat.js";
import type { ProviderPort } from "../main/ports/uc1.js";

function fixture(decision: "allowed" | "blocked" | "confirmation_required", withGuard = true) {
  const emits: AgentEmit[] = [];
  const chat = vi.fn();
  const provider: ProviderPort = {
    chat() {
      chat();
      return (async function* (): AsyncIterable<ProviderChunk> {
        yield { kind: "finish" };
      })();
    },
  };
  const deps: HandlerDeps = {
    provider,
    conversation: { assemble: (input) => input },
    credentials: { get: () => undefined, update: () => {} },
    approval: makeInMemoryApproval(),
    egress: {
      emit: (_requestId, event) => emits.push(event),
      emitCritical: (_requestId, event) => {
        emits.push(event);
        return true;
      },
    },
    diag: { log: () => {} },
    ...(withGuard ? {
      processingGuard: {
        authorize: (input) => ({
          workload: input.workload,
          destination: "external_cloud" as const,
          decision,
          processingProfileRef: input.processingProfileRef,
          provider: input.provider.provider,
          model: input.provider.model,
        }),
      },
    } : {}),
  };
  const request: ChatRequest = {
    kind: "chat",
    requestId: "request_1",
    sessionId: "session_1",
    provider: { provider: "openai", model: "gpt" },
    messages: [{ role: "user", content: "hello" }],
    processing: { processingProfileRef: "profile_1" },
  };
  return { deps, emits, chat, request };
}

describe("ChatTurnHandler processing guard", () => {
  it("emits disclosure before an allowed provider call", async () => {
    const { deps, emits, chat, request } = fixture("allowed");
    await new ChatTurnHandler(deps).onChatRequest(request);
    expect(chat).toHaveBeenCalledOnce();
    expect(emits.map((event) => event.kind)).toEqual([
      "processingDisclosure", "usage", "finish",
    ]);
  });

  it.each([
    ["blocked", "EXTERNAL_PROCESSING_FORBIDDEN"],
    ["confirmation_required", "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED"],
  ] as const)("emits disclosure then coded error and makes zero provider calls", async (decision, code) => {
    const { deps, emits, chat, request } = fixture(decision);
    await new ChatTurnHandler(deps).onChatRequest(request);
    expect(chat).not.toHaveBeenCalled();
    expect(emits.map((event) => event.kind)).toEqual([
      "processingDisclosure", "usage", "error",
    ]);
    expect(emits.at(-1)).toMatchObject({ kind: "error", code });
  });

  it("fails closed when processing metadata has no guard", async () => {
    const { deps, emits, chat, request } = fixture("allowed", false);
    await new ChatTurnHandler(deps).onChatRequest(request);
    expect(chat).not.toHaveBeenCalled();
    expect(emits.at(-1)).toMatchObject({
      kind: "error",
      code: "PROCESSING_DESTINATION_UNKNOWN",
    });
  });

  it("makes zero provider calls when critical disclosure delivery fails", async () => {
    const { deps, emits, chat, request } = fixture("allowed");
    deps.egress.emitCritical = () => false;
    await new ChatTurnHandler(deps).onChatRequest(request);
    expect(chat).not.toHaveBeenCalled();
    expect(emits.at(-1)).toMatchObject({
      kind: "error",
      code: "PROCESSING_DESTINATION_UNKNOWN",
    });
  });

  it("awaits the critical delivery acknowledgement before provider I/O", async () => {
    const { deps, chat, request } = fixture("allowed");
    let acknowledge!: (accepted: boolean) => void;
    deps.egress.emitCritical = () => new Promise<boolean>((resolve) => { acknowledge = resolve; });
    const pending = new ChatTurnHandler(deps).onChatRequest(request);
    await Promise.resolve();
    expect(chat).not.toHaveBeenCalled();
    acknowledge(true);
    await pending;
    expect(chat).toHaveBeenCalledOnce();
  });

  it("authorizes main, memory LLM, and embedding before memory recall", async () => {
    const { deps, request } = fixture("allowed");
    const order: string[] = [];
    const processingGuard: NonNullable<HandlerDeps["processingGuard"]> = {
      authorize: (input) => {
        order.push(`guard:${input.workload}`);
        return {
          workload: input.workload,
          destination: "local_device",
          decision: "allowed",
          processingProfileRef: input.processingProfileRef,
        };
      },
    };
    deps.egress.emitCritical = async () => true;
    const memory = {
      recall: async () => {
        order.push("memory:recall");
        return { facts: [], episodes: [] };
      },
      save: async () => {},
    };
    await new ChatTurnHandler({ ...deps, processingGuard, memory }).onChatRequest(request);
    expect(order.indexOf("guard:embedding")).toBeLessThan(order.indexOf("memory:recall"));
    expect(order).toContain("guard:main_llm");
    expect(order).toContain("guard:memory_llm");
  });

  it("does not disclose compaction when the threshold prevents the operation", async () => {
    const { deps, request } = fixture("allowed");
    const workloads: string[] = [];
    const processingGuard: NonNullable<HandlerDeps["processingGuard"]> = {
      authorize: (input) => {
        workloads.push(input.workload);
        return {
          workload: input.workload,
          destination: "local_device",
          decision: "allowed",
          processingProfileRef: input.processingProfileRef,
        };
      },
    };
    const compact = vi.fn();
    const compaction: NonNullable<HandlerDeps["compaction"]> = {
      compact,
      attachHandoff: async () => {},
    };
    await new ChatTurnHandler({ ...deps, processingGuard, compaction }).onChatRequest(request);
    expect(compact).not.toHaveBeenCalled();
    expect(workloads).toEqual(["main_llm"]);
  });

  it("does not disclose an allowed save stage when another required stage blocks", async () => {
    const { deps, emits, request } = fixture("allowed");
    const save = vi.fn(async () => {});
    const processingGuard: NonNullable<HandlerDeps["processingGuard"]> = {
      authorize: (input) => ({
        workload: input.workload,
        destination: "external_cloud",
        decision: input.workload === "embedding" ? "blocked" : "allowed",
        processingProfileRef: input.processingProfileRef,
      }),
    };
    const memory: NonNullable<HandlerDeps["memory"]> = {
      recall: async () => ({ facts: [], episodes: [] }),
      save,
    };
    await new ChatTurnHandler({ ...deps, processingGuard, memory }).onChatRequest({
      ...request,
      messages: [{ role: "user", content: "" }],
    });
    expect(save).not.toHaveBeenCalled();
    const disclosures = emits.filter((event) => event.kind === "processingDisclosure");
    expect(disclosures.map((event) => event.kind === "processingDisclosure" && event.workload))
      .not.toContain("memory_llm");
  });

  it("does not classify a local tool as a network operation", async () => {
    const { deps, emits, request } = fixture("allowed");
    let rounds = 0;
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        rounds += 1;
        if (rounds === 1) yield { kind: "toolUse", id: "call_1", name: "echo", args: {} };
        yield { kind: "finish" };
      },
    };
    const toolExecutor = {
      specs: () => [{ name: "echo", description: "echo", parameters: {} }],
      execute: async () => ({ output: "ok" }),
    };
    await new ChatTurnHandler({ ...deps, provider, toolExecutor }).onChatRequest(request);
    expect(rounds).toBe(2);
    expect(emits.filter((event) => event.kind === "processingDisclosure")).toHaveLength(2);
  });

  it("guards a trusted external tool immediately before execute", async () => {
    const { deps, request } = fixture("allowed");
    const order: string[] = [];
    let rounds = 0;
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        rounds++;
        if (rounds === 1) yield { kind: "toolUse", id: "call_1", name: "external", args: {} };
        yield { kind: "finish" };
      },
    };
    const processingGuard: NonNullable<HandlerDeps["processingGuard"]> = {
      authorize: (input) => {
        order.push(`guard:${input.workload}:${input.provider.provider}:${input.provider.model}`);
        return {
          workload: input.workload,
          destination: "external_cloud",
          decision: "allowed",
          processingProfileRef: input.processingProfileRef,
        };
      },
    };
    const toolExecutor = {
      specs: () => [{
        name: "external",
        description: "external",
        parameters: {},
        processing: {
          workload: "network_tool" as const,
          destination: "external_cloud" as const,
          provider: "github",
          model: "issues-api",
        },
      }],
      execute: async () => {
        order.push("tool:execute");
        return { output: "ok" };
      },
    };
    await new ChatTurnHandler({ ...deps, provider, processingGuard, toolExecutor }).onChatRequest(request);
    expect(order.indexOf("guard:network_tool:github:issues-api")).toBeLessThan(order.indexOf("tool:execute"));
  });
});
