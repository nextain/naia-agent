import { describe, expect, it, vi } from "vitest";
import {
  DiscordChannelRuntime,
  parseDiscordRuntimeConfig,
} from "../main/adapters/discord-channel.js";
import { wireAgentUC1 } from "../main/composition/index.js";
import type { AgentRequest, ChatMessage, ProviderChunk } from "../main/domain/chat.js";
import type {
  DiscordGatewayClose,
  DiscordGatewayConnection,
  DiscordGatewayHandlers,
  DiscordGatewayMessage,
  DiscordGatewayPort,
  DiscordDedupePort,
} from "../main/ports/discord.js";
import type { DiagnosticLog, ProviderPort } from "../main/ports/uc1.js";

const testText = {
  emptyReply: () => "EMPTY",
  failureReply: () => "FAILED",
  processingDisclosure: ({ workload, destination, decision }: {
    workload: string; destination: string; decision: string;
  }) => `PROCESSING ${workload} ${destination} ${decision}`,
};

function makeDedupe() {
  const records = new Map<string, {
    state: string;
    chunks?: readonly string[];
    nextChunk?: number;
    confirmedChunk?: number;
  }>();
  const key = (bindingId: string, messageId: string) => `${bindingId}:${messageId}`;
  return {
    async reserve({ bindingId, messageId }: { bindingId: string; messageId: string; now: number }) {
      const record = records.get(key(bindingId, messageId));
      if (record?.state === "replying") {
        return { decision: "resume_reply" as const, chunks: record.chunks!, nextChunk: record.nextChunk! };
      }
      if (record) return { decision: "duplicate" as const };
      records.set(key(bindingId, messageId), { state: "reserved" });
      return { decision: "process" as const };
    },
    async beginReply({ bindingId, messageId, chunks }: { bindingId: string; messageId: string; chunks: readonly string[]; now: number }) {
      records.set(key(bindingId, messageId), {
        state: "replying", chunks, nextChunk: 0, confirmedChunk: 0,
      });
      return true;
    },
    async claimChunk({ bindingId, messageId, nextChunk }: { bindingId: string; messageId: string; nextChunk: number; now: number }) {
      const record = records.get(key(bindingId, messageId));
      if (!record) return false;
      records.set(key(bindingId, messageId), { ...record, nextChunk });
      return true;
    },
    async confirmChunk({ bindingId, messageId, confirmedChunk }: { bindingId: string; messageId: string; confirmedChunk: number; now: number }) {
      const record = records.get(key(bindingId, messageId));
      if (!record) return false;
      records.set(key(bindingId, messageId), confirmedChunk === record.chunks?.length
        ? { state: "completed" }
        : { ...record, confirmedChunk });
      return true;
    },
    async complete() { return true; },
    async partial({ bindingId, messageId, confirmedChunk }: {
      bindingId: string; messageId: string; confirmedChunk: number; now: number;
    }) {
      records.set(key(bindingId, messageId), { state: "partial", confirmedChunk });
      return true;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeConnection implements DiscordGatewayConnection {
  private readonly done = deferred<DiscordGatewayClose>();
  readonly closed = this.done.promise;
  readonly replies: { guildId: string; channelId: string; messageId: string; content: string }[] = [];
  closeCount = 0;
  replyGate?: Promise<void>;
  failOnReplyNumber?: number;
  private replyAttempts = 0;
  async sendReply(input: { guildId: string; channelId: string; messageId: string; content: string }): Promise<void> {
    await this.replyGate;
    this.replyAttempts++;
    if (this.replyAttempts === this.failOnReplyNumber) throw new Error("ambiguous network failure");
    this.replies.push(input);
  }
  close(): void {
    this.closeCount++;
    this.done.resolve({ code: "closed", retryable: false });
  }
  disconnect(reason: DiscordGatewayClose): void { this.done.resolve(reason); }
}

class FakeGateway implements DiscordGatewayPort {
  readonly connections: FakeConnection[] = [];
  readonly handlers: DiscordGatewayHandlers[] = [];
  readonly tokens: string[] = [];
  async connect(token: string, handlers: DiscordGatewayHandlers): Promise<DiscordGatewayConnection> {
    const connection = new FakeConnection();
    this.tokens.push(token);
    this.handlers.push(handlers);
    this.connections.push(connection);
    handlers.onReady("999");
    return connection;
  }
  message(value: Partial<DiscordGatewayMessage> = {}, connection = this.handlers.length - 1): void {
    this.handlers[connection]!.onMessage({
      messageId: "m-1",
      guildId: "100",
      channelId: "200",
      authorId: "300",
      authorIsBot: false,
      content: "<@999> hello",
      mentionedUserIds: ["999"],
      ...value,
    });
  }
}

function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) { resolve(); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error("waitFor timeout")); return; }
      setTimeout(poll, 0);
    };
    poll();
  });
}

function answerReplies(connection: FakeConnection) {
  return connection.replies.filter((reply) => !reply.content.startsWith("PROCESSING "));
}

function makeHarness(options: {
  provider?: ProviderPort;
  twoBindings?: boolean;
  maxReplyChars?: number;
  allowedUserIds?: readonly string[];
  authority?: { isActive(): boolean };
  dedupe?: DiscordDedupePort;
} = {}) {
  const gateway = new FakeGateway();
  const sleeps: number[] = [];
  let now = 1_000;
  const logs: unknown[] = [];
  const diag: DiagnosticLog = {
    log: (message, context) => logs.push({ message, context }),
    debug: (message, context) => logs.push({ message, context }),
  };
  const runtime = new DiscordChannelRuntime({
    gateway,
    token: { load: async () => "discord-bot-token-secret" },
    dedupe: options.dedupe ?? makeDedupe(),
    ...(options.authority ? { authority: options.authority } : {}),
    clock: {
      now: () => now,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (signal.aborted) throw new Error("aborted");
      },
    },
    text: testText,
    diag,
  }, {
    bindings: [
      {
        bindingId: "binding_1",
        guildId: "100",
        channelId: "200",
        allowedUserIds: options.allowedUserIds ?? ["300"],
        processingProfileRef: "profile_1",
      },
      ...(options.twoBindings ? [{
        bindingId: "binding_2",
        guildId: "101",
        channelId: "201",
        allowedUserIds: ["301"],
        processingProfileRef: "profile_2",
      }] : []),
    ],
    reconnectBaseMs: 100,
    reconnectMaxMs: 400,
    ...(options.maxReplyChars ? { maxReplyChars: options.maxReplyChars } : {}),
  });
  const provider = options.provider ?? {
    async *chat(_config, messages): AsyncIterable<ProviderChunk> {
      const current = messages.at(-1)?.content ?? "";
      yield { kind: "text", text: `answer:${current}` };
      yield { kind: "finish" };
    },
  };
  const wired = wireAgentUC1({
    ingress: runtime.ingress,
    egress: runtime.egress,
    provider,
    defaultConfig: { provider: "fake", model: "fake-model" },
    processingGuard: {
      authorize: ({ processingProfileRef, workload }) => ({
        processingProfileRef,
        workload,
        destination: "local_device",
        decision: "allowed",
        provider: "fake",
        model: "fake-model",
      }),
      authorizePlan: (inputs) => inputs.map(({ processingProfileRef, workload }) => ({
        processingProfileRef,
        workload,
        destination: "local_device",
        decision: "allowed",
        provider: "fake",
        model: "fake-model",
      })),
      preparePlan: (inputs) => ({
        disclosures: inputs.map(({ processingProfileRef, workload }) => ({
          processingProfileRef,
          workload,
          destination: "local_device",
          decision: "allowed",
          provider: "fake",
          model: "fake-model",
        })),
        commit: () => true,
      }),
    },
    diag,
  });
  wired.start?.();
  runtime.start();
  return { gateway, runtime, sleeps, logs, setNow: (value: number) => { now = value; } };
}

describe("T-DISCORD-RT-01/02 — authenticated ingress to existing chat pipeline", () => {
  it("keeps a connected generation in standby and re-checks authority before consuming ingress", async () => {
    let active = false;
    const dedupe = makeDedupe();
    const refresh = vi.fn(async () => true);
    const { gateway, runtime } = makeHarness({
      authority: { isActive: () => active },
      dedupe: { ...dedupe, refresh },
    });
    await waitFor(() => gateway.handlers.length === 1);
    expect(runtime.status()).toMatchObject({ state: "ready", authoritative: false });
    gateway.message({ messageId: "standby-message" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gateway.connections[0]?.replies).toHaveLength(0);
    active = true;
    gateway.message({ messageId: "active-message" });
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 1);
    expect(refresh).toHaveBeenCalledOnce();
    expect(answerReplies(gateway.connections[0]!)[0]?.messageId).toBe("active-message");
    active = false;
    gateway.message({ messageId: "old-generation-message" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answerReplies(gateway.connections[0]!)).toHaveLength(1);
    await runtime.stop();
  });

  it("releases a reservation when authority changes during reserve", async () => {
    let active = true;
    const base = makeDedupe();
    const releaseReservation = vi.fn(async () => true);
    const dedupe = {
      ...base,
      reserve: async (input: Parameters<typeof base.reserve>[0]) => {
        const result = await base.reserve(input);
        active = false;
        return result;
      },
      releaseReservation,
    };
    const { gateway, runtime } = makeHarness({
      authority: { isActive: () => active },
      dedupe,
    });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "authority-flip-after-reserve" });
    await waitFor(() => releaseReservation.mock.calls.length === 1);
    expect(answerReplies(gateway.connections[0]!)).toHaveLength(0);
    await runtime.stop();
  });

  it("does not send a claimed reply chunk after generation authority changes", async () => {
    let active = true;
    const base = makeDedupe();
    const dedupe = {
      ...base,
      claimChunk: async (input: Parameters<typeof base.claimChunk>[0]) => {
        const result = await base.claimChunk(input);
        active = false;
        return result;
      },
    };
    const { gateway, runtime } = makeHarness({
      authority: { isActive: () => active },
      dedupe,
    });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "authority-flip-before-send" });
    await waitFor(() => runtime.status().partialReplies === 1);
    expect(answerReplies(gateway.connections[0]!)).toHaveLength(0);
    expect(runtime.status().partialReply).toEqual({ confirmedChunk: 0 });
    await runtime.stop();
  });

  it("accepts only exact bounded snowflake bindings and rejects duplicate channel tuples", () => {
    const valid = {
      bindings: [{
        bindingId: "binding_1", guildId: "100", channelId: "200",
        allowedUserIds: ["300"], processingProfileRef: "profile_1",
      }],
      processingProfiles: { profile_1: "cloud_enabled" },
    };
    expect(parseDiscordRuntimeConfig(valid)).toEqual(valid);
    expect(parseDiscordRuntimeConfig({
      bindings: [{ ...valid.bindings[0], guildId: "not-a-snowflake" }],
    })).toBeUndefined();
    expect(parseDiscordRuntimeConfig({
      bindings: [valid.bindings[0], { ...valid.bindings[0], bindingId: "binding_2" }],
    })).toBeUndefined();
  });

  it("dispatches an exact binding with trusted processing metadata and replies to the source message", async () => {
    const gateway = new FakeGateway();
    const requests: AgentRequest[] = [];
    const runtime = new DiscordChannelRuntime({
      gateway,
      token: { load: async () => "token" },
      dedupe: makeDedupe(),
      clock: { now: () => 1, sleep: async () => {} },
      text: testText,
      diag: { log() {} },
    }, {
      bindings: [{
        bindingId: "binding_1", guildId: "100", channelId: "200",
        allowedUserIds: ["300"], processingProfileRef: "profile_1",
      }],
    });
    runtime.ingress.onRequest((request) => requests.push(request));
    runtime.start();
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message();
    await waitFor(() => requests.length === 1);
    expect(requests[0]).toMatchObject({
      kind: "chat",
      requestId: "discord:binding_1:m-1",
      sessionId: "discord:binding_1:100:200:300",
      messages: [{ role: "user", content: "hello" }],
      channel: {
        kind: "discord", bindingId: "binding_1", guildId: "100", channelId: "200", userId: "300",
      },
      processing: { processingProfileRef: "profile_1" },
    });
    runtime.egress.emit("discord:binding_1:m-1", { kind: "text", text: "answer" });
    runtime.egress.emit("discord:binding_1:m-1", { kind: "finish" });
    await waitFor(() => gateway.connections[0]!.replies.length === 1);
    expect(gateway.connections[0]!.replies[0]).toMatchObject({
      guildId: "100", channelId: "200", messageId: "m-1", content: "answer",
    });
    await runtime.stop();
  });

  it.each([
    { guildId: null },
    { guildId: "101" },
    { channelId: "201" },
    { authorId: "301" },
    { authorIsBot: true },
    { authorId: "999" },
    { mentionedUserIds: [], replyToAuthorId: undefined },
  ] as Partial<DiscordGatewayMessage>[])("rejects before provider/dispatch: %o", async (change) => {
    const provider = { chat: vi.fn() } as unknown as ProviderPort;
    const { gateway, runtime } = makeHarness({ provider });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message(change);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(provider.chat).not.toHaveBeenCalled();
    expect(gateway.connections[0]!.replies).toHaveLength(0);
    await runtime.stop();
  });

  it("rejects a guild/channel cross-product that is not an exact binding", async () => {
    const provider = { chat: vi.fn() } as unknown as ProviderPort;
    const { gateway, runtime } = makeHarness({ provider, twoBindings: true });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ guildId: "100", channelId: "201", authorId: "301" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(provider.chat).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("does not call the provider until Discord acknowledges the processing disclosure", async () => {
    const chat = vi.fn(async function* () {
      yield { kind: "text" as const, text: "answer" };
      yield { kind: "finish" as const };
    });
    const provider: ProviderPort = { chat };
    const gate = deferred<void>();
    const { gateway, runtime } = makeHarness({ provider });
    await waitFor(() => gateway.connections.length === 1);
    gateway.connections[0]!.replyGate = gate.promise;
    gateway.message();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chat).not.toHaveBeenCalled();
    gate.resolve();
    await waitFor(() => chat.mock.calls.length === 1);
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 1);
    await runtime.stop();
  });

  it("claims an expiring one-time friend code without dispatching the code to the agent", async () => {
    const gateway = new FakeGateway();
    const requests: AgentRequest[] = [];
    let registered = false;
    const runtime = new DiscordChannelRuntime({
      gateway,
      token: { load: async () => "token" },
      dedupe: makeDedupe(),
      registration: {
        isRegistered: async () => registered,
        claim: async ({ bindingId, userId, code, now }) => {
          const accepted = !registered && bindingId === "binding_1" && userId === "301"
            && code === "friend-code" && now < 2_000;
          if (accepted) registered = true;
          return accepted;
        },
      },
      clock: { now: () => 1_000, sleep: async () => {} },
      text: testText,
      diag: { log() {} },
    }, {
      bindings: [{
        bindingId: "binding_1", guildId: "100", channelId: "200",
        allowedUserIds: ["300"], processingProfileRef: "profile_1",
      }],
    });
    runtime.ingress.onRequest((request) => requests.push(request));
    runtime.start();
    await waitFor(() => gateway.handlers.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    gateway.message({
      messageId: "register-1",
      authorId: "301",
      content: "<@999> register friend-code",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registered).toBe(true);
    expect(gateway.connections[0]!.replies).toHaveLength(0);
    expect(requests).toHaveLength(0);
    gateway.message({
      messageId: "after-register",
      authorId: "301",
      content: "<@999> hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(1);
    expect((requests[0] as { messages: readonly ChatMessage[] }).messages.at(-1)?.content).toBe("hello");
    await runtime.stop();
  });
});

describe("T-DISCORD-RT-03/04 — history isolation and replay dedupe", () => {
  it("keeps bounded histories isolated per guild/channel", async () => {
    const captures: ChatMessage[][] = [];
    const provider: ProviderPort = {
      async *chat(_config, messages): AsyncIterable<ProviderChunk> {
        captures.push([...messages]);
        yield { kind: "text", text: `answer:${messages.at(-1)?.content}` };
        yield { kind: "finish" };
      },
    };
    const { gateway, runtime } = makeHarness({ provider, twoBindings: true });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "m-1", content: "<@999> one" });
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 1);
    gateway.message({ messageId: "m-2", content: "<@999> two" });
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 2);
    gateway.message({
      messageId: "m-3", guildId: "101", channelId: "201", authorId: "301",
      content: "<@999> other",
    });
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 3);
    expect(captures[1]!.map((message) => message.content)).toEqual(["one", "answer:one", "two"]);
    expect(captures[2]!.map((message) => message.content)).toEqual(["other"]);
    await runtime.stop();
  });

  it("isolates history between two allowed users in the same channel", async () => {
    const captures: ChatMessage[][] = [];
    const provider: ProviderPort = {
      async *chat(_config, messages): AsyncIterable<ProviderChunk> {
        captures.push([...messages]);
        yield { kind: "text", text: "answer" };
        yield { kind: "finish" };
      },
    };
    const { gateway, runtime } = makeHarness({ provider, allowedUserIds: ["300", "302"] });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "m-user-a", authorId: "300", content: "<@999> private-a" });
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 1);
    gateway.message({ messageId: "m-user-b", authorId: "302", content: "<@999> private-b" });
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 2);
    expect(captures[1]!.map((message) => message.content)).toEqual(["private-b"]);
    await runtime.stop();
  });

  it("does not dispatch or reply twice after reconnect replay", async () => {
    const calls: string[] = [];
    const provider: ProviderPort = {
      async *chat(_config, messages): AsyncIterable<ProviderChunk> {
        calls.push(messages.at(-1)?.content ?? "");
        yield { kind: "text", text: "once" };
        yield { kind: "finish" };
      },
    };
    const { gateway, runtime, sleeps } = makeHarness({ provider });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "same" });
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 1);
    gateway.connections[0]!.disconnect({ code: "network_error", retryable: true });
    await waitFor(() => gateway.handlers.length === 2);
    gateway.message({ messageId: "same" }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toEqual(["hello"]);
    expect(sleeps).toEqual([100]);
    expect(gateway.connections[1]!.replies).toHaveLength(0);
    await runtime.stop();
  });
});

describe("T-DISCORD-RT-05/06 — lifecycle, bounded reply, safe failure", () => {
  it("reports an explicit lifecycle state and resume capability", async () => {
    const { gateway, runtime } = makeHarness();
    await waitFor(() => gateway.handlers.length === 1);
    expect(runtime.status()).toMatchObject({ state: "ready", bindingCount: 1, resumeSupported: true });
    await runtime.stop();
    expect(runtime.status().state).toBe("stopped");
  });
  it("uses deterministic capped exponential backoff for pre-ready connect failures", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const gateway: DiscordGatewayPort = {
      async connect() {
        attempts++;
        if (attempts < 4) throw new Error("network");
        return new FakeConnection();
      },
    };
    const runtime = new DiscordChannelRuntime({
      gateway,
      token: { load: async () => "token" },
      dedupe: makeDedupe(),
      clock: { now: () => 1, sleep: async (ms) => { sleeps.push(ms); } },
      text: testText,
      diag: { log() {} },
    }, {
      bindings: [{
        bindingId: "binding_1", guildId: "100", channelId: "200",
        allowedUserIds: ["300"], processingProfileRef: "profile_1",
      }],
      reconnectBaseMs: 100,
      reconnectMaxMs: 250,
    });
    runtime.ingress.onRequest(() => {});
    runtime.start();
    await waitFor(() => attempts === 4);
    expect(sleeps).toEqual([100, 200, 250]);
    await runtime.stop();
  });

  it("closes a stale pending connection and reconnects after configure", async () => {
    const first = deferred<DiscordGatewayConnection>();
    const connections = [new FakeConnection(), new FakeConnection()];
    let attempts = 0;
    const gateway: DiscordGatewayPort = {
      async connect(_token, handlers) {
        attempts++;
        if (attempts === 1) return first.promise;
        handlers.onReady("999");
        return connections[1]!;
      },
    };
    const runtime = new DiscordChannelRuntime({
      gateway,
      token: { load: async () => "token" },
      dedupe: makeDedupe(),
      clock: { now: () => 1, sleep: async () => {} },
      text: testText,
      diag: { log() {} },
    }, {
      bindings: [{
        bindingId: "binding_1", guildId: "100", channelId: "200",
        allowedUserIds: ["300"], processingProfileRef: "profile_1",
      }],
    });
    runtime.ingress.onRequest(() => {});
    runtime.start();
    await waitFor(() => attempts === 1);
    await runtime.configure({
      bindings: [{
        bindingId: "binding_2", guildId: "101", channelId: "201",
        allowedUserIds: ["301"], processingProfileRef: "profile_2",
      }],
    });
    first.resolve(connections[0]!);
    await waitFor(() => attempts === 2);
    expect(connections[0]!.closeCount).toBe(1);
    expect(runtime.status()).toMatchObject({ state: "ready", bindingCount: 1 });
    await runtime.stop();
  });

  it("cancels and removes active turns before switching configuration", async () => {
    let signal: AbortSignal | undefined;
    const provider: ProviderPort = {
      async *chat(_config, _messages, options): AsyncIterable<ProviderChunk> {
        signal = options.signal;
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      },
    };
    const { gateway, runtime } = makeHarness({ provider });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message();
    await waitFor(() => signal !== undefined);
    await runtime.configure({
      bindings: [{
        bindingId: "binding_2", guildId: "101", channelId: "201",
        allowedUserIds: ["301"], processingProfileRef: "profile_2",
      }],
    });
    expect(signal?.aborted).toBe(true);
    expect(runtime.status()).toMatchObject({ activeTurns: 0, partialReplies: 1 });
    expect(answerReplies(gateway.connections[0]!)).toHaveLength(0);
    await runtime.stop();
  });

  it("does not connect when the injected token is absent", async () => {
    const connect = vi.fn();
    const logs: unknown[] = [];
    const runtime = new DiscordChannelRuntime({
      gateway: { connect } as unknown as DiscordGatewayPort,
      token: { load: async () => undefined },
      dedupe: makeDedupe(),
      clock: { now: () => 1, sleep: async () => {} },
      text: testText,
      diag: { log: (_message, context) => logs.push(context) },
    }, {
      bindings: [{
        bindingId: "binding_1", guildId: "100", channelId: "200",
        allowedUserIds: ["300"], processingProfileRef: "profile_1",
      }],
    });
    runtime.ingress.onRequest(() => {});
    runtime.start();
    await waitFor(() => logs.length === 1);
    expect(connect).not.toHaveBeenCalled();
    expect(logs).toEqual([{ code: "token_unavailable" }]);
    await runtime.stop();
  });

  it("cancels an in-flight provider turn and closes Gateway on stop", async () => {
    let signal: AbortSignal | undefined;
    const provider: ProviderPort = {
      async *chat(_config, _messages, options): AsyncIterable<ProviderChunk> {
        signal = options.signal;
        await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      },
    };
    const { gateway, runtime } = makeHarness({ provider });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message();
    await waitFor(() => signal !== undefined);
    await runtime.stop();
    expect(signal?.aborted).toBe(true);
    expect(gateway.connections[0]!.closeCount).toBe(1);
    expect(answerReplies(gateway.connections[0]!)).toHaveLength(0);
  });

  it("splits replies to <=2,000 chars and enforces the configured total cap", async () => {
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: "x".repeat(5_000) };
        yield { kind: "finish" };
      },
    };
    const { gateway, runtime } = makeHarness({ provider, maxReplyChars: 4_500 });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message();
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 3);
    expect(answerReplies(gateway.connections[0]!).map((reply) => reply.content.length)).toEqual([2_000, 2_000, 500]);
    await runtime.stop();
  });

  it("returns a fixed short error and does not reflect provider failure content", async () => {
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        throw new Error("private-document-text sk-super-secret-value");
      },
    };
    const { gateway, runtime, logs } = makeHarness({ provider });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message();
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 1);
    expect(answerReplies(gateway.connections[0]!)[0]!.content).toBe("FAILED");
    expect(JSON.stringify(gateway.connections[0]!.replies)).not.toContain("private-document-text");
    expect(JSON.stringify(logs)).not.toContain("<@999> hello");
    expect(JSON.stringify(logs)).not.toContain("discord-bot-token-secret");
    await runtime.stop();
  });

  it("records an ambiguous first answer chunk as partial with zero confirmed chunks", async () => {
    const { gateway, runtime } = makeHarness();
    await waitFor(() => gateway.connections.length === 1);
    gateway.connections[0]!.failOnReplyNumber = 2;
    gateway.message();
    await waitFor(() => runtime.status().partialReplies === 1);
    expect(answerReplies(gateway.connections[0]!)).toHaveLength(0);
    expect(runtime.status()).toMatchObject({
      partialReplies: 1,
      partialReply: { confirmedChunk: 0 },
    });
    await runtime.stop();
  });
});
