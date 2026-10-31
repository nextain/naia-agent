import { describe, expect, it, vi } from "vitest";
import { DiscordChannelRuntime } from "../main/adapters/discord-channel.js";
import { makeDiscordGateway, type DiscordSocket } from "../main/adapters/discord-gateway.js";
import { wireAgentUC1 } from "../main/composition/index.js";
import type { AgentRequest, ProviderChunk } from "../main/domain/chat.js";
import type { DiscordDedupePort } from "../main/ports/discord.js";
import type { DiagnosticLog, ProviderPort } from "../main/ports/uc1.js";

interface SocketEvent {
  readonly data?: unknown;
  readonly code?: number;
}

class FakeSocket implements DiscordSocket {
  readyState = 1;
  private readonly listeners = new Map<string, ((event: SocketEvent) => void)[]>();
  private handshook = false;

  send(): void {}
  close(code = 1_000): void {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({ code });
  }
  addEventListener(type: "message" | "close" | "error", listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
    if (type === "message" && !this.handshook) {
      this.handshook = true;
      queueMicrotask(() => {
        this.payload({ op: 10, d: { heartbeat_interval: 120_000 } });
        this.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
      });
    }
  }
  payload(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(value) });
    }
  }
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeDedupe(): DiscordDedupePort {
  const processed = new Set<string>();
  return {
    async reserve({ bindingId, messageId }) {
      const key = `${bindingId}:${messageId}`;
      if (processed.has(key)) return { decision: "duplicate" };
      processed.add(key);
      return { decision: "process" };
    },
    async beginReply() { return true; },
    async claimChunk() { return true; },
    async confirmChunk() { return true; },
    async complete() { return true; },
    async partial() { return true; },
  };
}

function waitFor(
  check: () => boolean,
  label = "condition",
  timeoutMs = 2_000,
  details: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) { resolve(); return; }
      if (Date.now() >= deadline) {
        reject(new Error(`Discord standalone integration timed out: ${label} ${details()}`));
        return;
      }
      setTimeout(poll, 0);
    };
    poll();
  });
}

describe("Discord standalone fake Gateway → core → fake REST", () => {
  it("creates and continues a server thread, answers an allowed DM, and rejects unauthorized ingress", async () => {
    const socket = new FakeSocket();
    const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
    let nextReplyId = 800;
    const rest = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = url.pathname;
      calls.push({
        method,
        path,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}),
      });
      if (path === "/api/v10/gateway/bot") return response(200, { url: "wss://discord.test" });
      if (method === "GET" && path === "/api/v10/channels/500") {
        return response(200, { id: "500", type: 1, recipients: [{ id: "300" }] });
      }
      if (method === "GET" && path === "/api/v10/channels/501") {
        return response(200, { id: "501", type: 1, recipients: [{ id: "301" }] });
      }
      if (method === "GET" && path === "/api/v10/channels/503") {
        return response(200, { id: "503", type: 3, recipients: [{ id: "300" }, { id: "301" }] });
      }
      if (method === "GET" && path === "/api/v10/channels/504") return response(403, {});
      if (method === "POST" && path === "/api/v10/channels/200/messages/400/threads") {
        return response(200, { id: "700", guild_id: "100", parent_id: "200", type: 11 });
      }
      if (method === "POST" && path.endsWith("/messages")) return response(200, { id: String(nextReplyId++) });
      throw new Error("unexpected fake Discord REST request");
    });
    const gateway = makeDiscordGateway({
      fetch: rest as typeof fetch,
      socket: () => socket,
    });
    const requests: Extract<AgentRequest, { kind: "chat" }>[] = [];
    const providerInputs: string[] = [];
    const provider: ProviderPort = {
      async *chat(_config, messages): AsyncIterable<ProviderChunk> {
        const prompt = messages.at(-1)?.content ?? "";
        providerInputs.push(prompt);
        yield { kind: "text", text: `answer:${prompt}` };
        yield { kind: "finish" };
      },
    };
    const diagnostics: unknown[] = [];
    const diag: DiagnosticLog = {
      log: (message, context) => diagnostics.push({ message, context }),
      debug: (message, context) => diagnostics.push({ message, context }),
    };
    const runtime = new DiscordChannelRuntime({
      gateway,
      token: { load: async () => "fake-token-for-gateway" },
      dedupe: makeDedupe(),
      clock: { now: () => Date.now(), sleep: async (_ms, signal) => {
        if (signal.aborted) throw new Error("aborted");
      } },
      text: {
        emptyReply: () => "EMPTY",
        failureReply: () => "FAILED",
        courseLifecycle: (state) => state,
        processingDisclosure: () => "PROCESSING",
      },
      diag,
    }, {
      bindings: [{
        bindingId: "binding_1",
        guildId: "100",
        channelId: "200",
        allowedUserIds: ["300"],
        processingProfileRef: "profile_1",
        participation: "mentions",
      }],
      dm: { bindingId: "dm_1", allowedUserIds: ["300"], processingProfileRef: "profile_1" },
    });
    const wired = wireAgentUC1({
      ingress: {
        onRequest(callback) {
          return runtime.ingress.onRequest((request) => {
            if (request.kind === "chat") requests.push(request);
            callback(request);
          });
        },
      },
      egress: runtime.egress,
      provider,
      defaultConfig: { provider: "fake", model: "fake-model" },
      processingGuard: {
        authorize: ({ processingProfileRef, workload }) => ({
          processingProfileRef, workload, destination: "local_device", decision: "allowed",
          provider: "fake", model: "fake-model",
        }),
        authorizePlan: (inputs) => inputs.map(({ processingProfileRef, workload }) => ({
          processingProfileRef, workload, destination: "local_device", decision: "allowed",
          provider: "fake", model: "fake-model",
        })),
        preparePlan: (inputs) => ({
          disclosures: inputs.map(({ processingProfileRef, workload }) => ({
            processingProfileRef, workload, destination: "local_device", decision: "allowed",
            provider: "fake", model: "fake-model",
          })),
          commit: () => true,
          rollback: () => true,
        }),
      },
      diag,
    });
    wired.start?.();
    runtime.start();

    try {
      await waitFor(() => runtime.status().state === "ready", "Gateway ready", 2_000, () =>
        JSON.stringify({ status: runtime.status(), calls, diagnostics }));
      socket.payload({ op: 0, t: "CHANNEL_CREATE", d: { id: "200", guild_id: "100", type: 0 } });
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "400", guild_id: "100", channel_id: "200", content: "<@999> hello",
        author: { id: "300", bot: false }, mentions: [{ id: "999" }],
      } });
      await waitFor(() => calls.some((call) => call.path === "/api/v10/channels/700/messages"), "initial thread reply");
      expect(requests[0]).toMatchObject({
        sessionId: "discord:binding_1:thread:700:300",
        channel: { bindingId: "binding_1", guildId: "100", channelId: "700", parentChannelId: "200" },
        messages: [{ role: "user", content: "hello" }],
      });
      expect(calls).toContainEqual(expect.objectContaining({
        method: "POST", path: "/api/v10/channels/200/messages/400/threads",
      }));
      expect(calls).toContainEqual(expect.objectContaining({
        method: "POST", path: "/api/v10/channels/700/messages",
      }));

      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "401", guild_id: "100", channel_id: "700", content: "continue here",
        author: { id: "300", bot: false }, mentions: [],
      } });
      await waitFor(() => requests.length === 2 && calls.some((call) =>
        call.method === "POST" && call.path === "/api/v10/channels/700/messages"), "thread follow-up");
      expect(requests[1]).toMatchObject({
        sessionId: requests[0]!.sessionId,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "answer:hello" },
          { role: "user", content: "continue here" },
        ],
      });

      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "402", channel_id: "500", content: "private question", author: { id: "300", bot: false },
      } });
      await waitFor(() => requests.length === 3 && calls.some((call) =>
        call.method === "POST" && call.path === "/api/v10/channels/500/messages"), "allowed DM reply");
      expect(requests[2]).toMatchObject({
        sessionId: "discord:dm_1:dm:500:300",
        channel: { bindingId: "dm_1", guildId: null, channelId: "500", userId: "300" },
        messages: [{ role: "user", content: "private question" }],
      });

      const callsBeforeDenied = calls.length;
      const repliesBeforeDenied = calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages")).length;
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "403", channel_id: "501", content: "wrong user", author: { id: "301", bot: false },
      } });
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "404", channel_id: "500", content: "bot message", author: { id: "999", bot: true },
      } });
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "405", channel_id: "502", content: "webhook", author: { id: "300", bot: false }, webhook_id: "777",
      } });
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "406", channel_id: "503", content: "group dm", author: { id: "300", bot: false },
      } });
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "407", channel_id: "504", content: "rest denied", author: { id: "300", bot: false },
      } });
      await waitFor(() => calls.length >= callsBeforeDenied + 3, "denied ingress REST checks");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(requests).toHaveLength(3);
      expect(providerInputs).toEqual(["hello", "continue here", "private question"]);
      expect(calls.some((call) => call.path === "/api/v10/channels/502")).toBe(false);
      expect(calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"))).toHaveLength(repliesBeforeDenied);
    } finally {
      await runtime.stop();
      await wired.drain?.();
    }
  }, 30_000);
});
