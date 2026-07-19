import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscordGatewayError,
  makeDiscordGateway,
  type DiscordSocket,
} from "../main/adapters/discord-gateway.js";

class FakeSocket implements DiscordSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  private readonly listeners = new Map<string, ((event: { data?: unknown; code?: number }) => void)[]>();
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closes.push({ code, reason }); }
  addEventListener(type: "message" | "close" | "error", listener: (event: { data?: unknown; code?: number }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: "message" | "close" | "error", event: { data?: unknown; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  payload(value: unknown): void { this.emit("message", { data: JSON.stringify(value) }); }
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("T-DISCORD-RT-02/05/06 — Discord Gateway adapter", () => {
  it("authenticates after Hello and maps READY/MESSAGE_CREATE authenticated fields", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => response(200, { url: "wss://gateway.discord.test" }));
    const onReady = vi.fn();
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({ fetch: fetcher as typeof fetch, socket: () => socket })
      .connect("bot-token-secret", { onReady, onMessage });

    socket.payload({ op: 10, d: { heartbeat_interval: 1_000 } });
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      op: 2,
      d: { token: "bot-token-secret", intents: 33_281 },
    });
    socket.payload({ op: 0, t: "READY", s: 1, d: { user: { id: "999" } } });
    socket.payload({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 2,
      d: {
        id: "400", guild_id: "100", channel_id: "200", content: "<@999> hi",
        author: { id: "300" },
        mentions: [{ id: "999" }],
        referenced_message: { author: { id: "999" } },
      },
    });
    expect(onReady).toHaveBeenCalledWith("999");
    expect(onMessage).toHaveBeenCalledWith({
      messageId: "400",
      guildId: "100",
      channelId: "200",
      authorId: "300",
      authorIsBot: false,
      content: "<@999> hi",
      mentionedUserIds: ["999"],
      replyToAuthorId: "999",
    });
    connection.close();
  });

  it("requests reconnect after a missed heartbeat acknowledgement", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const gateway = makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => socket,
    });
    const connection = await gateway.connect("token", { onReady() {}, onMessage() {} });
    socket.payload({ op: 10, d: { heartbeat_interval: 250 } });
    await vi.advanceTimersByTimeAsync(500);
    await expect(connection.closed).resolves.toEqual({ code: "reconnect_requested", retryable: true });
    expect(socket.closes.at(-1)?.code).toBe(4_000);
  });

  it("classifies discovery authentication failure without reflecting the response", async () => {
    const fetcher = vi.fn(async () => response(401, { token: "must-not-reflect" }));
    await expect(makeDiscordGateway({ fetch: fetcher as typeof fetch }).connect(
      "token",
      { onReady() {}, onMessage() {} },
    )).rejects.toMatchObject({ code: "auth_failed", message: "auth_failed" });
  });

  it("stops reconnecting when Discord rejects privileged intents", async () => {
    const socket = new FakeSocket();
    const connection = await makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage() {} });
    socket.emit("close", { code: 4_014 });
    await expect(connection.closed).resolves.toEqual({ code: "intent_missing", retryable: false });
  });

  it("classifies invalid intents as terminal", async () => {
    const socket = new FakeSocket();
    const connection = await makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage() {} });
    socket.emit("close", { code: 4_013 });
    await expect(connection.closed).resolves.toEqual({ code: "intent_invalid", retryable: false });
  });

  it("resumes a READY session on the next connection", async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const fetcher = vi.fn(async () => response(200, { url: "wss://gateway.discord.test" }));
    const gateway = makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => sockets.shift()!,
    });
    const firstSocket = sockets[0]!;
    const firstReady = vi.fn();
    const first = await gateway.connect("token", { onReady: firstReady, onMessage() {} });
    firstSocket.payload({ op: 10, d: { heartbeat_interval: 1_000 } });
    firstSocket.payload({
      op: 0,
      t: "READY",
      s: 7,
      d: {
        user: { id: "999" },
        session_id: "session-1",
        resume_gateway_url: "wss://resume.discord.test",
      },
    });
    firstSocket.emit("close", { code: 1_006 });
    await first.closed;
    const secondSocket = sockets[0]!;
    const resumedReady = vi.fn();
    const resumedMessage = vi.fn();
    const second = await gateway.connect("token", { onReady: resumedReady, onMessage: resumedMessage });
    secondSocket.payload({ op: 10, d: { heartbeat_interval: 1_000 } });
    expect(JSON.parse(secondSocket.sent[0]!)).toEqual({
      op: 6,
      d: { token: "token", session_id: "session-1", seq: 7 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    secondSocket.payload({ op: 0, t: "RESUMED", s: 8, d: {} });
    secondSocket.payload({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 9,
      d: {
        id: "401", guild_id: "100", channel_id: "200", content: "<@999> after resume",
        author: { id: "300", bot: false },
        mentions: [{ id: "999" }],
      },
    });
    expect(resumedReady).toHaveBeenCalledWith("999");
    expect(resumedMessage).toHaveBeenCalledTimes(1);
    second.close();
  });

  it("sends a safe referenced reply and bounds rate-limit retry", async () => {
    const socket = new FakeSocket();
    const sleeps: number[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(429, { retry_after: 0.25 }))
      .mockResolvedValueOnce(response(200, { id: "reply-1" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
      sleep: async (ms) => { sleeps.push(ms); },
    }).connect("token", { onReady() {}, onMessage() {} });
    await connection.sendReply({ guildId: "100", channelId: "200", messageId: "400", content: "answer" });
    expect(sleeps).toEqual([250]);
    const request = fetcher.mock.calls[1]!;
    expect(request[0]).toContain("/channels/200/messages");
    expect(JSON.parse((request[1] as RequestInit).body as string)).toEqual({
      content: "answer",
      message_reference: { message_id: "400", channel_id: "200", guild_id: "100", fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
    });
  });

  it("does not retry a rate-limited reply after abort", async () => {
    const socket = new FakeSocket();
    const pendingSleep = deferred<void>();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(429, { retry_after: 30 }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
      sleep: () => pendingSleep.promise,
    }).connect("token", { onReady() {}, onMessage() {} });
    const abort = new AbortController();
    const reply = connection.sendReply({
      guildId: "100", channelId: "200", messageId: "400", content: "answer", signal: abort.signal,
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    abort.abort();
    await expect(reply).rejects.toMatchObject({ code: "http_error" });
    pendingSleep.resolve();
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "auth_failed"],
    [403, "permission_denied"],
  ] as const)("classifies reply HTTP %s without response content", async (status, code) => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(status, { token: "must-not-reflect" }));
    const connection = await makeDiscordGateway({ fetch: fetcher as typeof fetch, socket: () => socket })
      .connect("token", { onReady() {}, onMessage() {} });
    await expect(connection.sendReply({ guildId: "100", channelId: "200", messageId: "400", content: "answer" }))
      .rejects.toMatchObject({ code });
  });

  it("rejects invalid reply length before network I/O", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn().mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }));
    const connection = await makeDiscordGateway({ fetch: fetcher as typeof fetch, socket: () => socket })
      .connect("token", { onReady() {}, onMessage() {} });
    await expect(connection.sendReply({ guildId: "100", channelId: "200", messageId: "400", content: "x".repeat(2_001) }))
      .rejects.toBeInstanceOf(DiscordGatewayError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
