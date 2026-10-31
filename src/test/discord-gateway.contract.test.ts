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

function stalledBodyResponse(status: number, signal?: AbortSignal): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => {
        controller.error(new DOMException("aborted", "AbortError"));
      }, { once: true });
    },
  }), {
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
  it("rejects webhook events even when their author looks like an allowed human", async () => {
    const socket = new FakeSocket();
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "400", guild_id: "100", channel_id: "200", content: "hi",
      author: { id: "300", bot: false }, webhook_id: "123",
    } });
    expect(onMessage).not.toHaveBeenCalled();
    connection.close();
  });

  it("authenticates after Hello and maps READY/MESSAGE_CREATE authenticated fields", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => response(200, { url: "wss://gateway.discord.test" }));
    const onReady = vi.fn();
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({ fetch: fetcher as typeof fetch, socket: () => socket })
      .connect("test-token", { onReady, onMessage });

    socket.payload({ op: 10, d: { heartbeat_interval: 1_000 } });
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      op: 2,
      d: { token: "test-token", intents: 37_377 },
    });
    socket.payload({ op: 0, t: "READY", s: 1, d: { user: { id: "999" } } });
    socket.payload({ op: 0, t: "CHANNEL_CREATE", d: {
      id: "200", guild_id: "100", type: 0,
    } });
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
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith({
      messageId: "400",
      guildId: "100",
      channelId: "200",
      channelType: 0,
      authorId: "300",
      authorIsBot: false,
      content: "<@999> hi",
      mentionedUserIds: ["999"],
      replyToAuthorId: "999",
    }));
    connection.close();
  });

  it("attaches a cached thread parent to incoming messages", async () => {
    const socket = new FakeSocket();
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
    socket.payload({ op: 0, t: "THREAD_CREATE", d: {
      id: "700", guild_id: "100", parent_id: "200", type: 11,
    } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "401", guild_id: "100", channel_id: "700", content: "follow up",
      author: { id: "300", bot: false },
    } });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "700", parentChannelId: "200", channelType: 11,
    })));
    connection.close();
  });

  it("rejects unsupported channel types from Gateway cache events and REST lookup", async () => {
    const socket = new FakeSocket();
    const onMessage = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/gateway/bot")) return response(200, { url: "wss://gateway.discord.test" });
      const channelId = String(input).split("/").at(-1);
      return response(200, { id: channelId, guild_id: "100", type: 20 });
    });
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
    socket.payload({ op: 0, t: "CHANNEL_CREATE", d: {
      id: "200", guild_id: "100", type: 20,
    } });
    socket.payload({ op: 0, t: "CHANNEL_CREATE", d: {
      id: "202", guild_id: "100", type: 1, recipients: [{ id: "300" }],
    } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "403", guild_id: "100", channel_id: "200", content: "unsupported cached type",
      author: { id: "300", bot: false },
    } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "405", guild_id: "100", channel_id: "202", content: "DM type in guild context",
      author: { id: "300", bot: false },
    } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "404", guild_id: "100", channel_id: "201", content: "unsupported REST type",
      author: { id: "300", bot: false },
    } });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    connection.close();
  });

  it("does not treat a guild text channel category parent as a thread parent", async () => {
    const socket = new FakeSocket();
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
    socket.payload({ op: 0, t: "CHANNEL_CREATE", d: {
      id: "200", guild_id: "100", parent_id: "150", type: 0,
    } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "402", guild_id: "100", channel_id: "200", content: "in category",
      author: { id: "300", bot: false },
    } });

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage.mock.calls[0]![0]).toMatchObject({ channelType: 0, channelId: "200" });
    expect(onMessage.mock.calls[0]![0]).not.toHaveProperty("parentChannelId");
    connection.close();
  });

  it.each([
    ["THREAD_LIST_SYNC", {
      guild_id: "100", threads: [{ id: "700", parent_id: "200", type: 11 }],
    }],
    ["GUILD_CREATE", {
      id: "100", threads: [{ id: "700", parent_id: "200", type: 11 }],
    }],
  ])("uses outer guild ID from %s for thread metadata", async (event, data) => {
    const socket = new FakeSocket();
    const fetcher = vi.fn(async () => response(200, { url: "wss://gateway.discord.test" }));
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    try {
      socket.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
      socket.payload({ op: 0, t: event, d: data });
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "408", guild_id: "100", channel_id: "700", content: "thread follow-up",
        author: { id: "300", bot: false },
      } });

      await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
      expect(onMessage.mock.calls[0]![0]).toMatchObject({
        guildId: "100", channelId: "700", channelType: 11, parentChannelId: "200",
      });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      connection.close();
    }
  });

  it("does not trust incomplete READY thread metadata before REST confirms its guild", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, {
        id: "700", guild_id: "100", parent_id: "200", type: 11,
      }));
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    try {
      socket.payload({ op: 0, t: "READY", d: {
        user: { id: "999" },
        guilds: [{ threads: [{ id: "700", parent_id: "200", type: 11 }] }],
      } });
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: "409", guild_id: "100", channel_id: "700", content: "REST confirmed",
        author: { id: "300", bot: false },
      } });

      await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(onMessage.mock.calls[0]![0]).toMatchObject({
        guildId: "100", channelId: "700", parentChannelId: "200",
      });
    } finally {
      connection.close();
    }
  });

  it("attaches private channel type metadata from READY for DM policy checks", async () => {
    const socket = new FakeSocket();
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: {
      user: { id: "999" },
      private_channels: [
        { id: "500", type: 1, recipients: [{ id: "300" }] },
        { id: "501", type: 3, recipients: [{ id: "300" }, { id: "301" }] },
      ],
    } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "402", channel_id: "500", content: "dm", author: { id: "300" },
    } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "403", channel_id: "501", content: "group", author: { id: "300" },
    } });
    await vi.waitFor(() => expect(onMessage.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({ channelId: "500", guildId: null, channelType: 1 }),
    ]));
    connection.close();
  });

  it("does not trust recipient-less READY or REST DM metadata and retries REST", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, { id: "500", type: 1 }))
      .mockResolvedValueOnce(response(403, { message: "forbidden" }));
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: {
      user: { id: "999" },
      private_channels: [{ id: "500", type: 1 }],
    } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "406", channel_id: "500", content: "unknown recipient", author: { id: "300" },
    } });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).not.toHaveBeenCalled();
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "407", channel_id: "500", content: "retry after failed REST", author: { id: "300" },
    } });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).not.toHaveBeenCalled();
    connection.close();
  });

  it("looks up an unknown DM once and accepts it only when it is a one-to-one channel for the author", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, {
        id: "500", type: 1, recipients: [{ id: "300" }],
      }));
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "404", channel_id: "500", content: "first", author: { id: "300" },
    } });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "405", channel_id: "500", content: "second", author: { id: "300" },
    } });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(2));
    expect(onMessage.mock.calls[0]![0]).toMatchObject({
      channelId: "500", guildId: null, channelType: 1, authorId: "300",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toBe("https://discord.com/api/v10/channels/500");
    expect(fetcher.mock.calls[1]![1]).toMatchObject({
      method: "GET", headers: { authorization: "Bot token" },
    });
    connection.close();
  });

  it("fails closed for unknown group DMs, mismatched recipients, failed REST lookups, and mismatched channel IDs", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, {
        id: "501", type: 3, recipients: [{ id: "300" }, { id: "301" }],
      }))
      .mockResolvedValueOnce(response(200, {
        id: "502", type: 1, recipients: [{ id: "301" }],
      }))
      .mockResolvedValueOnce(response(403, {}))
      .mockResolvedValueOnce(response(200, {
        id: "999", type: 1, recipients: [{ id: "300" }],
      }));
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
    for (const [messageId, channelId] of [["406", "501"], ["407", "502"], ["408", "503"], ["409", "504"]]) {
      socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
        id: messageId, channel_id: channelId, content: "must fail closed", author: { id: "300" },
      } });
    }
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(5));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).not.toHaveBeenCalled();
    connection.close();
  });

  it("looks up an unknown server thread and requires a matching guild and verified parent", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, {
        id: "700", guild_id: "100", parent_id: "200", type: 11,
      }))
      .mockResolvedValueOnce(response(200, {
        id: "701", guild_id: "101", parent_id: "200", type: 11,
      }));
    const onMessage = vi.fn();
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage });
    socket.payload({ op: 0, t: "READY", d: { user: { id: "999" } } });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "410", guild_id: "100", channel_id: "700", content: "thread", author: { id: "300" },
    } });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
    expect(onMessage.mock.calls[0]![0]).toMatchObject({
      guildId: "100", channelId: "700", channelType: 11, parentChannelId: "200",
    });
    socket.payload({ op: 0, t: "MESSAGE_CREATE", d: {
      id: "411", guild_id: "100", channel_id: "701", content: "wrong guild", author: { id: "300" },
    } });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onMessage).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it("creates a thread only from the specified parent message and validates the returned parent", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, {
        id: "700", guild_id: "100", parent_id: "200", type: 11,
      }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage() {} });
    await expect(connection.createThreadFromMessage({
      guildId: "100", channelId: "200", messageId: "400", name: "Naia conversation",
    })).resolves.toBe("700");
    expect(fetcher.mock.calls[1]![0]).toContain("/channels/200/messages/400/threads");
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      name: "Naia conversation", auto_archive_duration: 1_440,
    });
    connection.close();
  });

  it("sends DM replies without inventing a guild id or cross-channel message reference", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, { id: "401" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage() {} });
    await connection.sendReply({ guildId: null, channelId: "500", content: "answer" });
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      content: "answer", allowed_mentions: { parse: [], replied_user: false },
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
    let closed = false;
    void connection.closed.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(socket.closes.at(-1)?.code).toBe(1_000);
    socket.emit("close", { code: 1_000 });
    await expect(connection.closed).resolves.toEqual({ code: "reconnect_requested", retryable: true });
  });

  it("waits for the old socket to close before allowing an opcode-7 reconnect", async () => {
    vi.useFakeTimers();
    const sockets = [new FakeSocket(), new FakeSocket()];
    const gateway = makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => sockets.shift()!,
    });
    const firstSocket = sockets[0]!;
    const first = await gateway.connect("token", { onReady() {}, onMessage() {} });
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
    firstSocket.payload({ op: 7, d: null });

    let closed = false;
    void first.closed.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(firstSocket.closes).toEqual([{ code: 1_000, reason: "reconnect" }]);

    firstSocket.emit("close", { code: 1_000 });
    await expect(first.closed).resolves.toEqual({ code: "reconnect_requested", retryable: true });
    const secondSocket = sockets[0]!;
    await gateway.connect("token", { onReady() {}, onMessage() {} });
    secondSocket.payload({ op: 10, d: { heartbeat_interval: 1_000 } });
    expect(JSON.parse(secondSocket.sent[0]!)).toEqual({
      op: 6,
      d: { token: "token", session_id: "session-1", seq: 7 },
    });
  });

  it("answers a server opcode 1 heartbeat request immediately with the latest sequence", async () => {
    const socket = new FakeSocket();
    const connection = await makeDiscordGateway({
      fetch: vi.fn(async () => response(200, { url: "wss://gateway.discord.test" })) as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage() {} });
    socket.payload({ op: 10, d: { heartbeat_interval: 1_000 } });
    socket.payload({ op: 0, t: "READY", s: 7, d: { user: { id: "999" } } });
    socket.payload({ op: 1, d: null });
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ op: 1, d: 7 });
    connection.close();
  });

  it("aborts a pending Gateway discovery request through the connect signal", async () => {
    const aborted = deferred<void>();
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted.resolve();
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));
    const controller = new AbortController();
    const connecting = makeDiscordGateway({ fetch: fetcher as typeof fetch }).connect(
      "token",
      { onReady() {}, onMessage() {} },
      { signal: controller.signal },
    );
    controller.abort();
    await aborted.promise;
    await expect(connecting).rejects.toMatchObject({ code: "gateway_unavailable" });
  });

  it("bounds a stalled Gateway discovery request with an adapter timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("timed out", "AbortError")), { once: true });
      }));
    const connecting = makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      discoveryTimeoutMs: 100,
    }).connect("token", { onReady() {}, onMessage() {} });
    const rejected = expect(connecting).rejects.toMatchObject({ code: "gateway_unavailable" });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
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
    firstSocket.payload({ op: 0, t: "CHANNEL_CREATE", d: {
      id: "200", guild_id: "100", type: 0,
    } });
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
    // Discord may replay dispatches immediately around RESUME. They must not
    // reach the runtime before the authenticated session is restored.
    secondSocket.payload({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 8,
      d: {
        id: "401", guild_id: "100", channel_id: "200", content: "<@999> after resume",
        author: { id: "300", bot: false },
        mentions: [{ id: "999" }],
      },
    });
    expect(resumedMessage).not.toHaveBeenCalled();
    secondSocket.payload({ op: 0, t: "RESUMED", s: 9, d: {} });
    expect(resumedReady).toHaveBeenCalledWith("999");
    await vi.waitFor(() => expect(resumedMessage).toHaveBeenCalledTimes(1));
    second.close();
  });

  it("sends a safe referenced reply and bounds rate-limit retry", async () => {
    const socket = new FakeSocket();
    const sleeps: number[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(429, { retry_after: 0.25 }))
      .mockResolvedValueOnce(response(200, { id: "401" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
      sleep: async (ms) => { sleeps.push(ms); },
    }).connect("token", { onReady() {}, onMessage() {} });
    await expect(connection.sendReply({
      guildId: "100", channelId: "200", messageId: "400", content: "answer",
      idempotencyKey: "reply:binding:400:0",
    })).resolves.toBe("401");
    expect(sleeps).toEqual([250]);
    const request = fetcher.mock.calls[1]!;
    expect(request[0]).toContain("/channels/200/messages");
    expect(JSON.parse((request[1] as RequestInit).body as string)).toEqual({
      content: "answer",
      message_reference: { message_id: "400", channel_id: "200", guild_id: "100", fail_if_not_exists: false },
      allowed_mentions: { parse: [], replied_user: false },
      nonce: expect.stringMatching(/^[0-9a-f]{24}$/),
      enforce_nonce: true,
    });
  });

  it("retries an ambiguous transport failure only with a stable enforced nonce", async () => {
    const socket = new FakeSocket();
    const sleeps: number[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockRejectedValueOnce(new TypeError("network failed"))
      .mockResolvedValueOnce(response(200, { id: "402" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
      sleep: async (ms) => { sleeps.push(ms); },
    }).connect("token", { onReady() {}, onMessage() {} });
    await expect(connection.sendReply({
      guildId: "100",
      channelId: "200",
      messageId: "400",
      content: "answer",
      idempotencyKey: "reply:binding:400:0",
    })).resolves.toBe("402");
    expect(sleeps).toEqual([250]);
    const firstBody = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    const secondBody = JSON.parse(fetcher.mock.calls[2]![1]!.body as string);
    expect(firstBody.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(secondBody).toMatchObject({ nonce: firstBody.nonce, enforce_nonce: true });
  });

  it("retries a successful response with an invalid message id using the same nonce", async () => {
    const socket = new FakeSocket();
    const sleeps: number[] = [];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, { id: "not-a-snowflake" }))
      .mockResolvedValueOnce(response(200, { id: "403" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
      sleep: async (ms) => { sleeps.push(ms); },
    }).connect("token", { onReady() {}, onMessage() {} });
    await expect(connection.sendReply({
      guildId: "100", channelId: "200", messageId: "400", content: "answer",
      idempotencyKey: "reply:binding:400:0",
    })).resolves.toBe("403");
    const firstBody = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    const secondBody = JSON.parse(fetcher.mock.calls[2]![1]!.body as string);
    expect(sleeps).toEqual([250]);
    expect(secondBody).toMatchObject({ nonce: firstBody.nonce, enforce_nonce: true });
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

  it("serializes concurrent replies behind a connection-scoped 429 wait", async () => {
    const socket = new FakeSocket();
    const wait = deferred<void>();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(429, { retry_after: 1, global: true }))
      .mockResolvedValueOnce(response(200, { id: "401" }))
      .mockResolvedValueOnce(response(200, { id: "402" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
      sleep: () => wait.promise,
    }).connect("token", { onReady() {}, onMessage() {} });

    const first = connection.sendReply({
      guildId: "100", channelId: "200", messageId: "400", content: "first",
    });
    const second = connection.sendReply({
      guildId: "100", channelId: "200", messageId: "401", content: "second",
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
    wait.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["401", "402"]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it.each([200, 429])(
    "times out a %s reply whose headers arrive but body stalls, then releases the connection queue",
    async (status) => {
      vi.useFakeTimers();
      const socket = new FakeSocket();
      const fetcher = vi.fn()
        .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
        .mockImplementationOnce((_url: string | URL | Request, init?: RequestInit) =>
          Promise.resolve(stalledBodyResponse(status, init?.signal ?? undefined)))
        .mockResolvedValueOnce(response(200, { id: "402" }));
      const connection = await makeDiscordGateway({
        fetch: fetcher as typeof fetch,
        socket: () => socket,
        replyTimeoutMs: 100,
      }).connect("token", { onReady() {}, onMessage() {} });

      const stalled = connection.sendReply({
        guildId: "100", channelId: "200", messageId: "400", content: "stalled",
      });
      const stalledRejection = expect(stalled).rejects.toMatchObject({ code: "http_error" });
      const next = connection.sendReply({
        guildId: "100", channelId: "200", messageId: "401", content: "next",
      });
      await vi.advanceTimersByTimeAsync(100);
      await stalledRejection;
      await expect(next).resolves.toBe("402");
      expect(fetcher).toHaveBeenCalledTimes(3);
    },
  );

  it("aborts a stalled reply body through the caller signal and releases the connection queue", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockImplementationOnce((_url: string | URL | Request, init?: RequestInit) =>
        Promise.resolve(stalledBodyResponse(200, init?.signal ?? undefined)))
      .mockResolvedValueOnce(response(200, { id: "402" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage() {} });
    const abort = new AbortController();

    const stalled = connection.sendReply({
      guildId: "100", channelId: "200", messageId: "400", content: "stalled", signal: abort.signal,
    });
    const stalledRejection = expect(stalled).rejects.toMatchObject({ code: "http_error" });
    const next = connection.sendReply({
      guildId: "100", channelId: "200", messageId: "401", content: "next",
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    abort.abort();
    await stalledRejection;
    await expect(next).resolves.toBe("402");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects an oversized chunked reply body and releases the connection queue", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(new Response(new Uint8Array((64 * 1_024) + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(response(200, { id: "402" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage() {} });

    const oversized = connection.sendReply({
      guildId: "100", channelId: "200", messageId: "400", content: "oversized",
    });
    const next = connection.sendReply({
      guildId: "100", channelId: "200", messageId: "401", content: "next",
    });
    await expect(oversized).rejects.toMatchObject({ code: "http_error" });
    await expect(next).resolves.toBe("402");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("fails closed when Discord omits the created message snowflake", async () => {
    const socket = new FakeSocket();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(200, { url: "wss://gateway.discord.test" }))
      .mockResolvedValueOnce(response(200, { id: "not-a-snowflake" }));
    const connection = await makeDiscordGateway({
      fetch: fetcher as typeof fetch,
      socket: () => socket,
    }).connect("token", { onReady() {}, onMessage() {} });

    await expect(connection.sendReply({
      guildId: "100", channelId: "200", messageId: "400", content: "answer",
    })).rejects.toMatchObject({ code: "http_error" });
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
