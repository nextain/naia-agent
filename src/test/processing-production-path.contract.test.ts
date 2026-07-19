import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { makeProcessingAwareProvider } from "../main/adapters/processing-operation-decorators.js";
import { makeProcessingRequestContext } from "../main/adapters/processing-request-context.js";
import { wireAgentUC1 } from "../main/composition/index.js";
import type { AgentRequest, ProviderChunk } from "../main/domain/chat.js";
import type { AgentIngressPort, ProviderPort } from "../main/ports/uc1.js";
import type { SpeechProfileRuntime } from "../main/app/speech-profile-runtime.js";

function ingressHarness() {
  let route: ((request: AgentRequest) => void) | undefined;
  const ingress: AgentIngressPort = {
    onRequest(callback) { route = callback; return () => {}; },
  };
  return { ingress, send: (request: AgentRequest) => route?.(request) };
}

describe("wrapped production provider compatibility", () => {
  it("retains the prior processing snapshot on invalid live reload", () => {
    const entry = readFileSync(new URL("../../scripts/builds/agent-stdio-entry.mjs", import.meta.url), "utf8");
    expect(entry).toContain("trustedSnapshot = candidate;");
    expect(entry).toContain("bind: () => makeBoundProcessingPolicy(trustedSnapshot)");
    expect(entry).not.toContain("void loadTrustedProcessingProfiles");
    expect(entry).toContain('digest("base64url")');
    expect(entry).not.toContain(': "shell");');
    expect(entry.indexOf("makeCompositeToolExecutor([toolExecutor, panelExec])"))
      .toBeLessThan(entry.indexOf("makeProcessingAwareToolExecutor(toolExecutor"));
    expect(entry).not.toMatch(/localToolNames[\s\S]*?"shell_exec"[\s\S]*?\]\);/);
    expect(entry).toContain("const processingProvider = provider ? makeProcessingAwareProvider(provider");
    expect(entry).toContain("endpointUrl: \"http://127.0.0.1/fixed-provider\"");
    expect(entry).toContain("...(processingProvider ? { provider: processingProvider } : {})");
  });

  it("binds an allow-existing-behavior context for legacy text-only requests", async () => {
    const called = vi.fn();
    const delegate: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        called();
        yield { kind: "finish" };
      },
    };
    const provider = makeProcessingAwareProvider(delegate, {
      endpointUrl: "https://api.example.com",
      endpointZone: "unverified",
      requiresConsent: true,
    });
    const harness = ingressHarness();
    const terminals: string[] = [];
    const wired = wireAgentUC1({
      ingress: harness.ingress,
      provider,
      egress: { emit: (_id, event) => {
        if (event.kind === "finish" || event.kind === "error") terminals.push(event.kind);
      } },
      // T-WIRE-01: processing 필드가 없는 기존 요청은 종전 동작을 허용하되,
      // 요청 컨텍스트 자체는 항상 bind한다.
      processingRequestContext: (request) => makeProcessingRequestContext(async () => {
        if (request.processing) throw new Error("unexpected policy bypass");
      }),
    });
    wired.start?.();
    harness.send({
      kind: "chat",
      requestId: "legacy_1",
      messages: [{ role: "user", content: "hello" }],
      provider: { provider: "openai", model: "org/model" },
    });
    await wired.drain?.();
    expect(called).toHaveBeenCalledOnce();
    expect(terminals).toEqual(["finish"]);
  });

  it("fixed local provider emits a critical local disclosure before the delegate call", async () => {
    const order: string[] = [];
    const provider = makeProcessingAwareProvider({
      async *chat() {
        order.push("provider");
        yield { kind: "finish" };
      },
    }, {
      endpointUrl: "http://127.0.0.1/fixed-provider",
      endpointZone: "unverified",
      requiresConsent: false,
    });
    const harness = ingressHarness();
    const wired = wireAgentUC1({
      ingress: harness.ingress,
      provider,
      egress: {
        emit: () => {},
        emitCritical: async (_requestId, event) => {
          order.push(`disclosure:${event.kind === "processingDisclosure" ? event.destination : "other"}`);
          return true;
        },
      },
      processingPolicy: {
        resolve: (_req, operation) => ({
          kind: "processingDisclosure", processingProfileRef: "profile_1",
          workload: operation.workload, destination: "local_device", decision: "allowed",
          provider: operation.provider, model: operation.model,
        }),
      },
    });
    wired.start?.();
    harness.send({
      kind: "chat", requestId: "fixed-local", messages: [{ role: "user", content: "hello" }],
      provider: { provider: "fake", model: "fixed" },
      channel: { kind: "shell" }, processing: { processingProfileRef: "profile_1" },
    });
    await wired.drain?.();
    expect(order).toEqual(["disclosure:local_device", "provider"]);
  });

  it("captures provider and grounding before an awaited speech profile while the next request sees reload", async () => {
    let generation = "old";
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    const speechProfiles = {
      async handleProfileChat() {
        if (first) { first = false; await paused; }
        return false;
      },
    } as unknown as SpeechProfileRuntime;
    const seen: Array<{ model: string; messages: string }> = [];
    const resolver = {
      resolve: () => ({
        async *chat(config: { model: string }, messages: readonly { content: string }[]) {
          seen.push({ model: config.model, messages: JSON.stringify(messages) });
          yield { kind: "finish" as const };
        },
      }),
    };
    const harness = ingressHarness();
    const wired = wireAgentUC1({
      ingress: harness.ingress,
      resolver,
      speechProfiles,
      egress: { emit: () => {} },
      bindRequestRuntime: () => {
        const captured = generation;
        return {
          trustContext: { allowedKnowledgeScopes: ["scope"] },
          providerConfig: { provider: "openai", model: `${captured}-model` },
          grounding: {
            resolve: async () => ({
              status: "grounded" as const,
              sources: [{ title: captured, sourceUris: [`kb://scope/${captured}`] }],
              evidence: [{ sourceHandle: `${captured}001`, text: `${captured}-evidence` }],
            }),
          },
        };
      },
    });
    wired.start?.();
    const request = (id: string) => ({
      kind: "chat" as const, requestId: id, channel: { kind: "shell" as const },
      grounding: { policy: "required" as const, knowledgeScope: "scope" },
      messages: [{ role: "user" as const, content: "question" }],
    });
    harness.send(request("snapshot-old"));
    generation = "new";
    release();
    await wired.drain?.();
    harness.send(request("snapshot-new"));
    await wired.drain?.();
    expect(seen.map((item) => item.model)).toEqual(["old-model", "new-model"]);
    expect(seen[0]?.messages).toContain("old-evidence");
    expect(seen[0]?.messages).not.toContain("new-evidence");
    expect(seen[1]?.messages).toContain("new-evidence");
  });
});
