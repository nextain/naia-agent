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
  DiscordInboxPort,
  DiscordInboxRecord,
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
  readonly replies: {
    guildId: string;
    channelId: string;
    messageId: string;
    content: string;
    replyMessageId: string;
  }[] = [];
  closeCount = 0;
  replyGate?: Promise<void>;
  failOnReplyNumber?: number;
  private replyAttempts = 0;
  async sendReply(input: { guildId: string; channelId: string; messageId: string; content: string }): Promise<string> {
    await this.replyGate;
    this.replyAttempts++;
    if (this.replyAttempts === this.failOnReplyNumber) throw new Error("ambiguous network failure");
    const replyMessageId = String(400_000 + this.replyAttempts);
    this.replies.push({ ...input, replyMessageId });
    return replyMessageId;
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
  participation?: "mentions" | "all" | "paused";
  maxActiveTurns?: number;
  authority?: { isActive(): boolean };
  dedupe?: DiscordDedupePort;
  inbox?: DiscordInboxPort;
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
    ...(options.inbox ? { inbox: options.inbox } : {}),
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
        participation: options.participation ?? "mentions",
      },
      ...(options.twoBindings ? [{
        bindingId: "binding_2",
        guildId: "101",
        channelId: "201",
        allowedUserIds: ["301"],
        processingProfileRef: "profile_2",
        participation: "mentions" as const,
      }] : []),
    ],
    reconnectBaseMs: 100,
    reconnectMaxMs: 400,
    ...(options.maxActiveTurns ? { maxActiveTurns: options.maxActiveTurns } : {}),
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
        rollback: () => true,
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

  it("accepts only the strict manifest schema and rejects duplicate identities", () => {
    const valid = {
      version: 1,
      bindings: [{
        bindingId: "binding_1", guildId: "100", channelId: "200",
        allowedUserIds: ["300"], processingProfileRef: "profile_1", participation: "mentions",
      }],
      processingProfiles: { profile_1: "cloud_enabled" },
    };
    expect(parseDiscordRuntimeConfig(valid)).toEqual({
      bindings: valid.bindings,
      processingProfiles: valid.processingProfiles,
    });
    expect(parseDiscordRuntimeConfig({
      version: 1,
      bindings: [],
      processingProfiles: { profile_1: "local_only" },
    })).toEqual({
      bindings: [],
      processingProfiles: { profile_1: "local_only" },
    });
    expect(parseDiscordRuntimeConfig({
      ...valid,
      generation: 1,
      bindings: [{ ...valid.bindings[0], guildName: null, channelName: null }],
    })).toBeDefined();
    expect(parseDiscordRuntimeConfig({
      ...valid,
      bindings: [{ ...valid.bindings[0], participation: undefined }],
    })?.bindings[0]?.participation).toBe("paused");
    expect(parseDiscordRuntimeConfig({
      ...valid,
      bindings: [{ ...valid.bindings[0], participation: "future-rule" }],
    })?.bindings[0]?.participation).toBe("paused");
    expect(parseDiscordRuntimeConfig({
      version: 2,
      bindings: [],
      processingProfiles: { profile_1: "local_only" },
    })).toBeUndefined();
    expect(parseDiscordRuntimeConfig({
      version: 1,
      bindings: [{ ...valid.bindings[0], guildId: "not-a-snowflake" }],
      processingProfiles: valid.processingProfiles,
    })).toBeUndefined();
    expect(parseDiscordRuntimeConfig({
      version: 1,
      bindings: [valid.bindings[0], { ...valid.bindings[0], bindingId: "binding_2" }],
      processingProfiles: valid.processingProfiles,
    })).toBeUndefined();
    expect(parseDiscordRuntimeConfig({
      ...valid,
      unexpected: true,
    })).toBeUndefined();
    expect(parseDiscordRuntimeConfig({
      ...valid,
      bindings: [{ ...valid.bindings[0], token: "must-not-cross" }],
    })).toBeUndefined();
    expect(parseDiscordRuntimeConfig({
      ...valid,
      bindings: [
        valid.bindings[0],
        { ...valid.bindings[0], guildId: "101", channelId: "201" },
      ],
    })).toBeUndefined();
  });

  it("allows an empty binding set while rejecting every inbound channel", async () => {
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
      bindings: [],
      processingProfiles: { profile_1: "local_only" },
    });
    runtime.ingress.onRequest((request) => requests.push(request));

    runtime.start();
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(requests).toEqual([]);
    expect(runtime.status()).toMatchObject({ state: "ready", bindingCount: 0 });
    await runtime.stop();
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
        allowedUserIds: ["300"], processingProfileRef: "profile_1", participation: "mentions",
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

  it("applies all and paused participation without weakening allowed-user authority", async () => {
    const all = makeHarness({ participation: "all" });
    await waitFor(() => all.gateway.handlers.length === 1);
    all.gateway.message({ mentionedUserIds: [], replyToAuthorId: undefined });
    await waitFor(() => answerReplies(all.gateway.connections[0]!).length === 1);
    expect(answerReplies(all.gateway.connections[0]!)[0]?.content).toBe("answer:hello");
    all.gateway.message({
      messageId: "all-denied-user",
      authorId: "301",
      mentionedUserIds: [],
      replyToAuthorId: undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answerReplies(all.gateway.connections[0]!)).toHaveLength(1);
    await all.runtime.stop();

    const paused = makeHarness({ participation: "paused" });
    await waitFor(() => paused.gateway.handlers.length === 1);
    paused.gateway.message();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(answerReplies(paused.gateway.connections[0]!)).toHaveLength(0);
    await paused.runtime.stop();
  });

  it("does not read paused messages and records accepted incoming plus confirmed outgoing replies", async () => {
    const records: DiscordInboxRecord[] = [];
    const inbox: DiscordInboxPort = {
      append: async (record) => {
        records.push(record);
        return true;
      },
    };
    const paused = makeHarness({ participation: "paused", inbox });
    await waitFor(() => paused.gateway.handlers.length === 1);
    paused.gateway.message({ messageId: "paused-message" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(records).toHaveLength(0);
    expect(answerReplies(paused.gateway.connections[0]!)).toHaveLength(0);
    await paused.runtime.stop();

    records.length = 0;
    const active = makeHarness({ inbox });
    await waitFor(() => active.gateway.handlers.length === 1);
    active.gateway.message({ messageId: "active-message" });
    await waitFor(() => records.some((record) => record.direction === "outgoing"));
    expect(records.map((record) => record.direction)).toEqual(["incoming", "outgoing"]);
    const answer = answerReplies(active.gateway.connections[0]!)[0]!;
    expect(records[1]).toMatchObject({
      recordId: `outgoing_${answer.replyMessageId}`,
      sourceMessageId: answer.replyMessageId,
      content: "answer:hello",
    });
    await active.runtime.stop();
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
        allowedUserIds: ["300"], processingProfileRef: "profile_1", participation: "mentions",
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

  it("dispatches same-session messages in arrival order after prior history commit", async () => {
    const firstTurn = deferred<void>();
    const captures: ChatMessage[][] = [];
    let calls = 0;
    const provider: ProviderPort = {
      async *chat(_config, messages): AsyncIterable<ProviderChunk> {
        calls++;
        captures.push([...messages]);
        if (calls === 1) await firstTurn.promise;
        yield { kind: "text", text: `answer:${messages.at(-1)?.content}` };
        yield { kind: "finish" };
      },
    };
    const { gateway, runtime } = makeHarness({ provider });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "m-order-1", content: "<@999> first" });
    await waitFor(() => captures.length === 1);
    gateway.message({ messageId: "m-order-2", content: "<@999> second" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captures).toHaveLength(1);
    firstTurn.resolve();
    await waitFor(() => captures.length === 2);
    expect(captures[1]!.map((message) => message.content)).toEqual([
      "first",
      "answer:first",
      "second",
    ]);
    await runtime.stop();
  });

  it("reserves the admission slot before async dedupe work across different sessions", async () => {
    const firstReserve = deferred<Awaited<ReturnType<DiscordDedupePort["reserve"]>>>();
    const base = makeDedupe();
    const reserve = vi.fn(async (input: Parameters<DiscordDedupePort["reserve"]>[0]) => {
      if (input.messageId === "m-admission-1") return firstReserve.promise;
      return base.reserve(input);
    });
    const chat = vi.fn(async function* () {
      yield { kind: "text" as const, text: "answer" };
      yield { kind: "finish" as const };
    });
    const { gateway, runtime } = makeHarness({
      provider: { chat },
      allowedUserIds: ["300", "302"],
      maxActiveTurns: 1,
      dedupe: { ...base, reserve },
    });
    await waitFor(() => gateway.handlers.length === 1);

    gateway.message({
      messageId: "m-admission-1",
      authorId: "300",
      content: "<@999> first",
    });
    await waitFor(() => reserve.mock.calls.length === 1);
    gateway.message({
      messageId: "m-admission-2",
      authorId: "302",
      content: "<@999> second",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled();

    firstReserve.resolve({ decision: "process" });
    await waitFor(() => chat.mock.calls.length === 1);
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 1);
    expect(answerReplies(gateway.connections[0]!)[0]?.messageId).toBe("m-admission-1");
    await runtime.stop();
  });

  it("drops unbound guild and DM events before async authority admission work", async () => {
    const refresh = vi.fn(async () => true);
    const chat = vi.fn(async function* () {
      yield { kind: "finish" as const };
    });
    const base = makeDedupe();
    const { gateway, runtime, logs } = makeHarness({
      provider: { chat },
      authority: { isActive: () => true },
      dedupe: { ...base, refresh },
      maxActiveTurns: 1,
    });
    await waitFor(() => gateway.handlers.length === 1);
    const logCountBeforeFlood = logs.length;

    for (let index = 0; index < 100; index++) {
      gateway.message({
        messageId: `unbound-${index}`,
        guildId: index % 2 === 0 ? "101" : null,
        channelId: "201",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(refresh).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(runtime.status().activeTurns).toBe(0);
    expect(logs).toHaveLength(logCountBeforeFlood);
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
        allowedUserIds: ["300"], processingProfileRef: "profile_1", participation: "mentions",
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
        allowedUserIds: ["300"], processingProfileRef: "profile_1", participation: "mentions",
      }],
    });
    runtime.ingress.onRequest(() => {});
    runtime.start();
    await waitFor(() => attempts === 1);
    await runtime.configure({
      bindings: [{
        bindingId: "binding_2", guildId: "101", channelId: "201",
        allowedUserIds: ["301"], processingProfileRef: "profile_2", participation: "mentions",
      }],
    });
    first.resolve(connections[0]!);
    await waitFor(() => attempts === 2);
    expect(connections[0]!.closeCount).toBe(1);
    expect(runtime.status()).toMatchObject({ state: "ready", bindingCount: 1 });
    await runtime.stop();
  });

  it("aborts and awaits a pending Gateway discovery connect on stop", async () => {
    let connectSignal: AbortSignal | undefined;
    let aborted = false;
    const gateway: DiscordGatewayPort = {
      async connect(_token, _handlers, options) {
        connectSignal = options?.signal;
        return new Promise<DiscordGatewayConnection>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        });
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
        allowedUserIds: ["300"], processingProfileRef: "profile_1", participation: "mentions",
      }],
    });
    runtime.ingress.onRequest(() => {});
    runtime.start();
    await waitFor(() => connectSignal !== undefined);
    await runtime.stop();
    expect(connectSignal?.aborted).toBe(true);
    expect(aborted).toBe(true);
    expect(runtime.status().state).toBe("stopped");
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
        allowedUserIds: ["301"], processingProfileRef: "profile_2", participation: "mentions",
      }],
    });
    expect(signal?.aborted).toBe(true);
    expect(runtime.status()).toMatchObject({ activeTurns: 0, partialReplies: 1 });
    expect(answerReplies(gateway.connections[0]!)).toHaveLength(0);
    await runtime.stop();
  });

  it("invalidates and drains deferred authority preparation before reconfiguration", async () => {
    const authorityRefresh = deferred<boolean>();
    const refresh = vi.fn(() => authorityRefresh.promise);
    const chat = vi.fn(async function* () {
      yield { kind: "finish" as const };
    });
    const base = makeDedupe();
    const { gateway, runtime } = makeHarness({
      provider: { chat },
      authority: { isActive: () => true },
      dedupe: { ...base, refresh },
    });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "old-authority" });
    await waitFor(() => refresh.mock.calls.length === 1);

    const configuring = runtime.configure({
      bindings: [{
        bindingId: "binding_2", guildId: "101", channelId: "201",
        allowedUserIds: ["301"], processingProfileRef: "profile_2", participation: "mentions",
      }],
    });
    authorityRefresh.resolve(true);
    await configuring;

    expect(chat).not.toHaveBeenCalled();
    expect(runtime.status()).toMatchObject({ bindingCount: 1, activeTurns: 0 });
    await runtime.stop();
  });

  it("releases a deferred reservation and prevents dispatch after stop", async () => {
    const reservation = deferred<Awaited<ReturnType<DiscordDedupePort["reserve"]>>>();
    const base = makeDedupe();
    const reserve = vi.fn(() => reservation.promise);
    const releaseReservation = vi.fn(async () => true);
    const chat = vi.fn(async function* () {
      yield { kind: "finish" as const };
    });
    const { gateway, runtime } = makeHarness({
      provider: { chat },
      dedupe: { ...base, reserve, releaseReservation },
    });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "old-reservation" });
    await waitFor(() => reserve.mock.calls.length === 1);

    const stopping = runtime.stop();
    const concurrentStop = runtime.stop();
    reservation.resolve({ decision: "process" });
    await Promise.all([stopping, concurrentStop]);

    expect(releaseReservation).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: "binding_1",
      messageId: "old-reservation",
    }));
    expect(chat).not.toHaveBeenCalled();
    expect(runtime.status().state).toBe("stopped");
  });

  it("drains a deferred inbox append without dispatching an obsolete binding", async () => {
    const inboxAppend = deferred<boolean>();
    const append = vi.fn(() => inboxAppend.promise);
    const base = makeDedupe();
    const releaseReservation = vi.fn(async () => true);
    const chat = vi.fn(async function* () {
      yield { kind: "finish" as const };
    });
    const { gateway, runtime } = makeHarness({
      provider: { chat },
      dedupe: { ...base, releaseReservation },
      inbox: { append },
    });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "old-inbox" });
    await waitFor(() => append.mock.calls.length === 1);

    const configuring = runtime.configure({
      bindings: [{
        bindingId: "binding_2", guildId: "101", channelId: "201",
        allowedUserIds: ["301"], processingProfileRef: "profile_2", participation: "mentions",
      }],
    });
    inboxAppend.resolve(true);
    await configuring;

    expect(releaseReservation).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: "binding_1",
      messageId: "old-inbox",
    }));
    expect(chat).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("awaits an old-epoch outgoing inbox task before configure returns", async () => {
    const outgoingAppend = deferred<boolean>();
    const append = vi.fn((record: DiscordInboxRecord) =>
      record.direction === "outgoing" ? outgoingAppend.promise : Promise.resolve(true));
    const { gateway, runtime } = makeHarness({ inbox: { append } });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "old-outgoing" });
    await waitFor(() => append.mock.calls.some(([record]) => record.direction === "outgoing"));

    let configured = false;
    const configuring = runtime.configure({
      bindings: [{
        bindingId: "binding_2", guildId: "101", channelId: "201",
        allowedUserIds: ["301"], processingProfileRef: "profile_2", participation: "mentions",
      }],
    }).then(() => { configured = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(configured).toBe(false);

    outgoingAppend.resolve(true);
    await configuring;
    expect(configured).toBe(true);
    await runtime.stop();
  });

  it("keeps the latest configuration when overlapping reconfigurations drain out of order", async () => {
    const reservation = deferred<Awaited<ReturnType<DiscordDedupePort["reserve"]>>>();
    const base = makeDedupe();
    const reserve = vi.fn((input: Parameters<DiscordDedupePort["reserve"]>[0]) =>
      input.messageId === "old-overlap" ? reservation.promise : base.reserve(input));
    const { gateway, runtime } = makeHarness({ dedupe: { ...base, reserve } });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message({ messageId: "old-overlap" });
    await waitFor(() => reserve.mock.calls.length === 1);

    const first = runtime.configure({
      bindings: [{
        bindingId: "binding_2", guildId: "101", channelId: "201",
        allowedUserIds: ["301"], processingProfileRef: "profile_2", participation: "mentions",
      }],
    });
    const second = runtime.configure({
      bindings: [{
        bindingId: "binding_3", guildId: "102", channelId: "202",
        allowedUserIds: ["302"], processingProfileRef: "profile_3", participation: "mentions",
      }],
    });
    reservation.resolve({ decision: "duplicate" });
    await Promise.all([second, first]);
    await waitFor(() => gateway.handlers.length >= 2);

    gateway.message({
      messageId: "latest-binding",
      guildId: "102",
      channelId: "202",
      authorId: "302",
    });
    await waitFor(() => answerReplies(gateway.connections.at(-1)!).length === 1);
    expect(answerReplies(gateway.connections.at(-1)!)[0]?.messageId).toBe("latest-binding");
    await runtime.stop();
  });

  it("rejects configure without mutating state once stop has started or completed", async () => {
    const { gateway, runtime } = makeHarness();
    await waitFor(() => gateway.handlers.length === 1);
    const stopping = runtime.stop();
    const stoppedConfig = {
      bindings: [{
        bindingId: "binding_stale", guildId: "101", channelId: "201",
        allowedUserIds: ["301"], processingProfileRef: "profile_stale", participation: "mentions" as const,
      }],
    };

    await expect(runtime.configure(stoppedConfig)).rejects.toThrow("DISCORD_RUNTIME_STOPPED");
    await stopping;
    await expect(runtime.configure(stoppedConfig)).rejects.toThrow("DISCORD_RUNTIME_STOPPED");
    expect(runtime.status()).toMatchObject({
      state: "stopped",
      bindingCount: 1,
      activeTurns: 0,
    });
    expect(gateway.handlers).toHaveLength(1);
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
        allowedUserIds: ["300"], processingProfileRef: "profile_1", participation: "mentions",
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

  it("splits replies on Unicode code-point boundaries without breaking emoji", async () => {
    const provider: ProviderPort = {
      async *chat(): AsyncIterable<ProviderChunk> {
        yield { kind: "text", text: `${"x".repeat(1_999)}😀y` };
        yield { kind: "finish" };
      },
    };
    const { gateway, runtime } = makeHarness({ provider, maxReplyChars: 2_001 });
    await waitFor(() => gateway.handlers.length === 1);
    gateway.message();
    await waitFor(() => answerReplies(gateway.connections[0]!).length === 2);
    const replies = answerReplies(gateway.connections[0]!).map((reply) => reply.content);
    expect(replies.map((reply) => Array.from(reply).length)).toEqual([2_000, 1]);
    expect(replies[0]!.endsWith("😀")).toBe(true);
    expect(replies.join("")).toBe(`${"x".repeat(1_999)}😀y`);
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
