import { createHash } from "node:crypto";
import type {
  DiscordGatewayClose,
  DiscordGatewayConnection,
  DiscordGatewayMessage,
  DiscordGatewayPort,
} from "../ports/discord.js";

interface SocketEvent {
  readonly data?: unknown;
  readonly code?: number;
}

export interface DiscordSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: SocketEvent) => void): void;
}

export interface DiscordGatewayAdapterOptions {
  readonly fetch?: typeof fetch;
  readonly socket?: (url: string) => DiscordSocket;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly apiBase?: string;
  readonly maxRateLimitRetries?: number;
  readonly discoveryTimeoutMs?: number;
  readonly replyTimeoutMs?: number;
}

export class DiscordGatewayError extends Error {
  constructor(readonly code:
    | "gateway_unavailable"
    | "auth_failed"
    | "permission_denied"
    | "rate_limited"
    | "http_error"
    | "invalid_reply",
  ) {
    super(code);
    this.name = "DiscordGatewayError";
  }
}

const MESSAGE_INTENTS = 1 | 512 | 4_096 | 32_768;
const MAX_TOKEN_LENGTH = 512;
const MAX_REPLY_LENGTH = 2_000;
const MAX_EVENT_LENGTH = 1_000_000;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_PENDING_MESSAGES = 256;
const MAX_IN_FLIGHT_CHANNEL_LOOKUPS = 64;
const MAX_IDEMPOTENCY_KEY_LENGTH = 512;
const MAX_REPLY_RESPONSE_BYTES = 64 * 1_024;
const MAX_CHANNEL_METADATA = 4_096;
const SNOWFLAKE = /^\d{1,128}$/;
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) {
    throw new DiscordGatewayError("gateway_unavailable");
  }
  return timeout;
}

async function abortableSleep(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DiscordGatewayError("http_error");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(new DiscordGatewayError("http_error")));
    signal?.addEventListener("abort", onAbort, { once: true });
    void sleep(ms).then(
      () => finish(resolve),
      () => finish(() => reject(new DiscordGatewayError("http_error"))),
    );
  });
}

async function fetchGatewayUrl(
  fetchImpl: typeof fetch,
  apiBase: string,
  token: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new DiscordGatewayError("gateway_unavailable");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const discovery = await fetchImpl(`${apiBase}/gateway/bot`, {
      headers: { authorization: `Bot ${token}` },
      signal: controller.signal,
    });
    if (discovery.status === 401) throw new DiscordGatewayError("auth_failed");
    if (!discovery.ok) throw new DiscordGatewayError("gateway_unavailable");
    const body = await discovery.json() as { url?: unknown };
    if (typeof body.url !== "string" || !body.url.startsWith("wss://")) {
      throw new DiscordGatewayError("gateway_unavailable");
    }
    return body.url;
  } catch (error) {
    if (error instanceof DiscordGatewayError) throw error;
    throw new DiscordGatewayError("gateway_unavailable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      throw new DiscordGatewayError("http_error");
    }
  }
  if (!response.body) throw new DiscordGatewayError("http_error");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new DiscordGatewayError("http_error");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DiscordGatewayError("http_error");
  }
}

async function fetchReplyWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ readonly response: Response; readonly bodyText?: string }> {
  if (signal?.aborted) throw new DiscordGatewayError("http_error");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const bodyText = response.ok || response.status === 429
      ? await readBoundedResponseText(response, MAX_REPLY_RESPONSE_BYTES)
      : undefined;
    return { response, ...(bodyText !== undefined ? { bodyText } : {}) };
  } catch (error) {
    if (error instanceof DiscordGatewayError) throw error;
    throw new DiscordGatewayError("http_error");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function parsePayload(data: unknown): { op: number; t?: string; s?: number; d?: unknown } | undefined {
  try {
    const text = typeof data === "string" ? data : String(data);
    if (text.length > MAX_EVENT_LENGTH) return undefined;
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Record<string, unknown>;
    if (!Number.isInteger(value.op)) return undefined;
    return {
      op: Number(value.op),
      ...(typeof value.t === "string" ? { t: value.t } : {}),
      ...(Number.isInteger(value.s) ? { s: Number(value.s) } : {}),
      d: value.d,
    };
  } catch {
    return undefined;
  }
}

interface ChannelMetadata {
  readonly type: number;
  readonly guildId?: string;
  readonly parentChannelId?: string;
  readonly recipientIds?: readonly string[];
}

function rememberChannel(
  value: unknown,
  channels: Map<string, ChannelMetadata>,
  expectedChannelId?: string,
): ChannelMetadata | undefined {
  if (!value || typeof value !== "object") return;
  const channel = value as Record<string, unknown>;
  if (typeof channel.id !== "string" || !SNOWFLAKE.test(channel.id)
    || (expectedChannelId !== undefined && channel.id !== expectedChannelId)
    || !Number.isSafeInteger(channel.type) || Number(channel.type) < 0 || Number(channel.type) > 20) return;
  const parent = channel.parent_id;
  const guildId = channel.guild_id;
  const channelType = Number(channel.type);
  let recipientIds: string[] | undefined;
  if (channel.recipients !== undefined) {
    if (!Array.isArray(channel.recipients) || channel.recipients.length > 100) {
      channels.delete(channel.id);
      return;
    }
    recipientIds = [];
    for (const recipient of channel.recipients) {
      const id = recipient && typeof recipient === "object"
        ? (recipient as Record<string, unknown>).id
        : undefined;
      if (typeof id !== "string" || !SNOWFLAKE.test(id)) {
        channels.delete(channel.id);
        return;
      }
      recipientIds.push(id);
    }
  }
  if (guildId !== undefined && guildId !== null
    && (typeof guildId !== "string" || !SNOWFLAKE.test(guildId))) {
    channels.delete(channel.id);
    return undefined;
  }
  if (parent !== undefined && parent !== null && (typeof parent !== "string" || !SNOWFLAKE.test(parent))) {
    channels.delete(channel.id);
    return undefined;
  }
  if (!channels.has(channel.id) && channels.size >= MAX_CHANNEL_METADATA) {
    const oldest = channels.keys().next().value;
    if (oldest !== undefined) channels.delete(oldest);
  }
  channels.delete(channel.id);
  const metadata: ChannelMetadata = {
    type: channelType,
    ...(typeof guildId === "string" ? { guildId } : {}),
    ...(THREAD_CHANNEL_TYPES.has(channelType) && typeof parent === "string" ? { parentChannelId: parent } : {}),
    ...(recipientIds !== undefined ? { recipientIds } : {}),
  };
  channels.set(channel.id, metadata);
  return metadata;
}

function rememberChannelList(value: unknown, channels: Map<string, ChannelMetadata>): void {
  if (!Array.isArray(value) || value.length > MAX_CHANNEL_METADATA) return;
  for (const item of value) rememberChannel(item, channels);
}

function asMessage(
  value: unknown,
  channels: ReadonlyMap<string, ChannelMetadata>,
): DiscordGatewayMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  const author = message.author as Record<string, unknown> | undefined;
  if (message.webhook_id !== undefined && message.webhook_id !== null) return undefined;
  if (typeof message.id !== "string" || !SNOWFLAKE.test(message.id)
    || typeof message.channel_id !== "string" || !SNOWFLAKE.test(message.channel_id)
    || (message.guild_id !== undefined && (typeof message.guild_id !== "string" || !SNOWFLAKE.test(message.guild_id)))
    || typeof message.content !== "string" || !author || typeof author.id !== "string"
    || !SNOWFLAKE.test(author.id)
    || (author.bot !== undefined && typeof author.bot !== "boolean")
    || message.content.length > MAX_MESSAGE_LENGTH) {
    return undefined;
  }
  if (Array.isArray(message.mentions) && message.mentions.length > 256) return undefined;
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.flatMap((item) =>
      item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string"
        ? [(item as Record<string, unknown>).id as string]
        : [])
    : [];
  const referenced = message.referenced_message as Record<string, unknown> | undefined;
  const referencedAuthor = referenced?.author as Record<string, unknown> | undefined;
  const channelMetadata = channels.get(message.channel_id);
  const metadataMatchesGuild = message.guild_id === undefined
    ? channelMetadata?.guildId === undefined
    : channelMetadata?.guildId === message.guild_id;
  return {
    messageId: message.id,
    guildId: typeof message.guild_id === "string" ? message.guild_id : null,
    channelId: message.channel_id,
    ...(metadataMatchesGuild && channelMetadata?.parentChannelId
      ? { parentChannelId: channelMetadata.parentChannelId }
      : {}),
    ...(metadataMatchesGuild && channelMetadata ? { channelType: channelMetadata.type } : {}),
    authorId: author.id,
    authorIsBot: author.bot === true,
    content: message.content,
    mentionedUserIds: mentions,
    ...(typeof referencedAuthor?.id === "string" ? { replyToAuthorId: referencedAuthor.id } : {}),
  };
}

function closeReason(code: number | undefined): DiscordGatewayClose {
  if (code === 4_004) return { code: "auth_failed", retryable: false };
  if (code === 4_013) return { code: "intent_invalid", retryable: false };
  if (code === 4_014) return { code: "intent_missing", retryable: false };
  return { code: "closed", retryable: true };
}

function nativeSocket(url: string): DiscordSocket {
  const Constructor = globalThis.WebSocket;
  if (!Constructor) throw new DiscordGatewayError("gateway_unavailable");
  return new Constructor(url) as unknown as DiscordSocket;
}

export function makeDiscordGateway(options: DiscordGatewayAdapterOptions = {}): DiscordGatewayPort {
  const fetchImpl = options.fetch ?? fetch;
  const socketFactory = options.socket ?? nativeSocket;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const apiBase = options.apiBase ?? "https://discord.com/api/v10";
  const maxRetries = options.maxRateLimitRetries ?? 2;
  const discoveryTimeoutMs = boundedTimeout(options.discoveryTimeoutMs);
  const replyTimeoutMs = boundedTimeout(options.replyTimeoutMs);
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let resumeSequence: number | null = null;
  let resumedSelfUserId: string | undefined;
  const channelMetadata = new Map<string, ChannelMetadata>();
  const channelLookups = new Map<string, Promise<ChannelMetadata | undefined>>();

  return {
    async connect(token, handlers, connectOptions) {
      if (typeof token !== "string" || token.length < 1 || token.length > MAX_TOKEN_LENGTH) {
        throw new DiscordGatewayError("auth_failed");
      }
      let gatewayUrl = resumeUrl;
      if (!gatewayUrl) {
        gatewayUrl = await fetchGatewayUrl(
          fetchImpl,
          apiBase,
          token,
          discoveryTimeoutMs,
          connectOptions?.signal,
        );
      }

      const socket = socketFactory(`${gatewayUrl}?v=10&encoding=json`);
      let sequence: number | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let reconnectFallback: ReturnType<typeof setTimeout> | undefined;
      let awaitingHeartbeatAck = false;
      let reconnectRequested = false;
      let authenticated = false;
      const pendingMessages: DiscordGatewayMessage[] = [];
      let replyQueue: Promise<void> = Promise.resolve();
      let settled = false;
      let resolveClosed!: (value: DiscordGatewayClose) => void;
      const closed = new Promise<DiscordGatewayClose>((resolve) => { resolveClosed = resolve; });
      const settle = (reason: DiscordGatewayClose) => {
        if (settled) return;
        settled = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (reconnectFallback !== undefined) clearTimeout(reconnectFallback);
        resolveClosed(reason);
      };
      const send = (payload: unknown) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(payload));
      };
      const becomeReady = (selfUserId: string) => {
        authenticated = true;
        handlers.onReady(selfUserId);
        for (const message of pendingMessages.splice(0)) deliverMessage(message);
      };
      const lookupChannel = (channelId: string): Promise<ChannelMetadata | undefined> => {
        const cached = channelMetadata.get(channelId);
        if (cached) return Promise.resolve(cached);
        const pending = channelLookups.get(channelId);
        if (pending) return pending;
        if (channelLookups.size >= MAX_IN_FLIGHT_CHANNEL_LOOKUPS) return Promise.resolve(undefined);
        const lookup = (async () => {
          try {
            const result = await fetchReplyWithTimeout(
              fetchImpl,
              `${apiBase}/channels/${encodeURIComponent(channelId)}`,
              { method: "GET", headers: { authorization: `Bot ${token}` } },
              replyTimeoutMs,
              connectOptions?.signal,
            );
            if (!result.response.ok) return undefined;
            let body: unknown;
            try { body = JSON.parse(result.bodyText ?? "") as unknown; }
            catch { return undefined; }
            return rememberChannel(body, channelMetadata, channelId);
          } catch {
            return undefined;
          }
        })().finally(() => channelLookups.delete(channelId));
        channelLookups.set(channelId, lookup);
        return lookup;
      };
      const deliverMessage = (message: DiscordGatewayMessage) => {
        const alreadyKnown = channelMetadata.has(message.channelId);
        void lookupChannel(message.channelId).then((metadata) => {
          if (settled || !metadata) return;
          if (message.guildId === null) {
            if (metadata.guildId !== undefined || metadata.parentChannelId !== undefined
              || metadata.type !== 1
              || (!alreadyKnown && !metadata.recipientIds?.includes(message.authorId))
              || (metadata.recipientIds && !metadata.recipientIds.includes(message.authorId))) return;
          } else if (metadata.guildId !== message.guildId
            || (THREAD_CHANNEL_TYPES.has(metadata.type) && !metadata.parentChannelId)
            || (metadata.parentChannelId !== undefined && !THREAD_CHANNEL_TYPES.has(metadata.type))) {
            return;
          }
          handlers.onMessage({
            ...message,
            channelType: metadata.type,
            ...(metadata.parentChannelId ? { parentChannelId: metadata.parentChannelId } : {}),
          });
        }).catch(() => {});
      };
      const requestReconnect = () => {
        if (reconnectRequested || settled) return;
        reconnectRequested = true;
        if (sequence !== null) resumeSequence = sequence;
        // Do not resolve `closed` until the old socket has actually closed.
        // Resolving first lets the runtime open a replacement while Discord
        // still considers this connection active, which can cause an opcode-7
        // reconnect loop. The timeout is only a bounded fallback for broken
        // WebSocket implementations that never emit `close`.
        reconnectFallback = setTimeout(() => {
          settle({ code: "reconnect_requested", retryable: true });
        }, 5_000);
        try { socket.close(1_000, "reconnect"); }
        catch { settle({ code: "reconnect_requested", retryable: true }); }
      };

      socket.addEventListener("message", (event) => {
        const payload = parsePayload(event.data);
        if (!payload || settled) return;
        if (payload.s !== undefined) sequence = payload.s;
        if (payload.op === 10) {
          const hello = payload.d as { heartbeat_interval?: unknown } | undefined;
          const interval = Number(hello?.heartbeat_interval);
          if (!Number.isFinite(interval) || interval < 250 || interval > 120_000) {
            requestReconnect();
            return;
          }
          if (sessionId && resumeSequence !== null) {
            send({ op: 6, d: { token, session_id: sessionId, seq: resumeSequence } });
          } else {
            send({
              op: 2,
              d: {
                token,
                intents: MESSAGE_INTENTS,
                properties: { os: process.platform, browser: "naia-agent", device: "naia-agent" },
              },
            });
          }
          heartbeat = setInterval(() => {
            if (awaitingHeartbeatAck) {
              requestReconnect();
              return;
            }
            awaitingHeartbeatAck = true;
            send({ op: 1, d: sequence });
          }, interval);
          return;
        }
        if (payload.op === 11) {
          awaitingHeartbeatAck = false;
          return;
        }
        if (payload.op === 1) {
          awaitingHeartbeatAck = true;
          send({ op: 1, d: sequence });
          return;
        }
        if (payload.op === 7 || payload.op === 9) {
          if (payload.op === 9 && payload.d !== true) {
            sessionId = undefined;
            resumeUrl = undefined;
            resumeSequence = null;
            resumedSelfUserId = undefined;
          }
          requestReconnect();
          return;
        }
        if (payload.op !== 0) return;
        if (payload.t === "READY") {
          const ready = payload.d as {
            user?: { id?: unknown };
            session_id?: unknown;
            resume_gateway_url?: unknown;
            private_channels?: unknown;
            guilds?: unknown;
          } | undefined;
          if (ready && typeof ready === "object") {
            rememberChannelList(ready.private_channels, channelMetadata);
            if (Array.isArray(ready.guilds) && ready.guilds.length <= 1_000) {
              for (const guild of ready.guilds) {
                if (guild && typeof guild === "object") {
                  rememberChannelList((guild as Record<string, unknown>).threads, channelMetadata);
                }
              }
            }
          }
          if (typeof ready?.user?.id === "string") becomeReady(ready.user.id);
          if (typeof ready?.user?.id === "string"
            && typeof ready.session_id === "string"
            && typeof ready.resume_gateway_url === "string"
            && ready.resume_gateway_url.startsWith("wss://")) {
            sessionId = ready.session_id;
            resumeUrl = ready.resume_gateway_url;
            resumeSequence = sequence;
            resumedSelfUserId = ready.user.id;
          }
          return;
        }
        if (payload.t === "RESUMED") {
          resumeSequence = sequence;
          if (resumedSelfUserId) becomeReady(resumedSelfUserId);
          return;
        }
        if (["CHANNEL_CREATE", "CHANNEL_UPDATE", "THREAD_CREATE", "THREAD_UPDATE"].includes(payload.t ?? "")) {
          rememberChannel(payload.d, channelMetadata);
          return;
        }
        if (payload.t === "THREAD_LIST_SYNC") {
          const sync = payload.d as { threads?: unknown } | undefined;
          rememberChannelList(sync?.threads, channelMetadata);
          return;
        }
        if (payload.t === "GUILD_CREATE") {
          const guild = payload.d as Record<string, unknown> | undefined;
          rememberChannelList(guild?.threads, channelMetadata);
          return;
        }
        if (payload.t === "CHANNEL_DELETE" || payload.t === "THREAD_DELETE") {
          const deleted = payload.d as { id?: unknown } | undefined;
          if (typeof deleted?.id === "string") channelMetadata.delete(deleted.id);
          return;
        }
        if (payload.t === "MESSAGE_CREATE") {
          const message = asMessage(payload.d, channelMetadata);
          if (!message) return;
          if (authenticated) deliverMessage(message);
          else if (pendingMessages.length < MAX_PENDING_MESSAGES) pendingMessages.push(message);
        }
      });
      socket.addEventListener("close", (event) => {
        if (event.code === 4_007 || event.code === 4_009) {
          sessionId = undefined;
          resumeUrl = undefined;
          resumeSequence = null;
          resumedSelfUserId = undefined;
        } else if (sequence !== null) {
          resumeSequence = sequence;
        }
        settle(reconnectRequested
          ? { code: "reconnect_requested", retryable: true }
          : closeReason(event.code));
      });
      socket.addEventListener("error", () => settle({ code: "network_error", retryable: true }));

      const connection: DiscordGatewayConnection = {
        closed,
        async createThreadFromMessage(input) {
          if (!SNOWFLAKE.test(input.guildId) || !SNOWFLAKE.test(input.channelId)
            || !SNOWFLAKE.test(input.messageId) || !input.name || input.name.length > 100
            || /[\u0000-\u001f\u007f]/.test(input.name)) {
            throw new DiscordGatewayError("invalid_reply");
          }
          const result = await fetchReplyWithTimeout(
            fetchImpl,
            `${apiBase}/channels/${encodeURIComponent(input.channelId)}/messages/${encodeURIComponent(input.messageId)}/threads`,
            {
              method: "POST",
              headers: {
                authorization: `Bot ${token}`,
                "content-type": "application/json",
              },
              signal: input.signal,
              body: JSON.stringify({ name: input.name, auto_archive_duration: 1_440 }),
            },
            replyTimeoutMs,
            input.signal,
          );
          if (result.response.status === 401) throw new DiscordGatewayError("auth_failed");
          if (result.response.status === 403) throw new DiscordGatewayError("permission_denied");
          if (result.response.status === 429) throw new DiscordGatewayError("rate_limited");
          if (!result.response.ok) throw new DiscordGatewayError("http_error");
          let thread: Record<string, unknown>;
          try { thread = JSON.parse(result.bodyText ?? "") as Record<string, unknown>; }
          catch { throw new DiscordGatewayError("http_error"); }
          if (typeof thread.id !== "string" || !SNOWFLAKE.test(thread.id)
            || thread.parent_id !== input.channelId || thread.guild_id !== input.guildId
            || !THREAD_CHANNEL_TYPES.has(Number(thread.type))) {
            throw new DiscordGatewayError("invalid_reply");
          }
          rememberChannel(thread, channelMetadata);
          return thread.id;
        },
        close() {
          if (settled) return;
          try { socket.close(1_000, "shutdown"); } finally {
            settle({ code: "closed", retryable: false });
          }
        },
        async sendReply(input) {
          if (!input.content || Array.from(input.content).length > MAX_REPLY_LENGTH
            || !SNOWFLAKE.test(input.channelId)
            || (input.guildId !== null && !SNOWFLAKE.test(input.guildId))
            || (input.messageId !== undefined && !SNOWFLAKE.test(input.messageId))
            || (input.idempotencyKey !== undefined
              && (input.idempotencyKey.length < 1
                || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
                || /[\u0000-\u001f\u007f]/.test(input.idempotencyKey)))) {
            throw new DiscordGatewayError("invalid_reply");
          }
          const nonce = input.idempotencyKey === undefined
            ? undefined
            : createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 24);
          let resolveReply!: (value: string) => void;
          let rejectReply!: (error: unknown) => void;
          const result = new Promise<string>((resolve, reject) => {
            resolveReply = resolve;
            rejectReply = reject;
          });
          const queued = replyQueue.then(async () => {
            try {
              if (input.signal?.aborted) throw new DiscordGatewayError("http_error");
              for (let attempt = 0; attempt <= maxRetries; attempt++) {
                let reply: Awaited<ReturnType<typeof fetchReplyWithTimeout>>;
                try {
                  reply = await fetchReplyWithTimeout(
                    fetchImpl,
                    `${apiBase}/channels/${encodeURIComponent(input.channelId)}/messages`,
                    {
                      method: "POST",
                      headers: {
                        authorization: `Bot ${token}`,
                        "content-type": "application/json",
                      },
                      signal: input.signal,
                      body: JSON.stringify({
                        content: input.content,
                        ...(input.messageId ? { message_reference: {
                          message_id: input.messageId,
                          channel_id: input.channelId,
                          ...(input.guildId !== null ? { guild_id: input.guildId } : {}),
                          fail_if_not_exists: false,
                        } } : {}),
                        allowed_mentions: { parse: [], replied_user: false },
                        ...(nonce ? { nonce, enforce_nonce: true } : {}),
                      }),
                    },
                    replyTimeoutMs,
                    input.signal,
                  );
                } catch (error) {
                  if (!nonce || attempt === maxRetries || input.signal?.aborted) throw error;
                  await abortableSleep(sleep, Math.min(2_000, 250 * (2 ** attempt)), input.signal);
                  continue;
                }
                const { response, bodyText } = reply;
                if (response.ok) {
                  let body: { id?: unknown };
                  try {
                    body = JSON.parse(bodyText ?? "") as { id?: unknown };
                  } catch {
                    if (nonce && attempt < maxRetries) {
                      await abortableSleep(sleep, Math.min(2_000, 250 * (2 ** attempt)), input.signal);
                      continue;
                    }
                    throw new DiscordGatewayError("http_error");
                  }
                  const replyMessageId = String(body.id ?? "");
                  if (!SNOWFLAKE.test(replyMessageId)) {
                    if (nonce && attempt < maxRetries) {
                      await abortableSleep(sleep, Math.min(2_000, 250 * (2 ** attempt)), input.signal);
                      continue;
                    }
                    throw new DiscordGatewayError("http_error");
                  }
                  resolveReply(replyMessageId);
                  return;
                }
                if (response.status === 401) throw new DiscordGatewayError("auth_failed");
                if (response.status === 403) throw new DiscordGatewayError("permission_denied");
                if (response.status !== 429) {
                  if (nonce && response.status >= 500 && attempt < maxRetries) {
                    await abortableSleep(sleep, Math.min(2_000, 250 * (2 ** attempt)), input.signal);
                    continue;
                  }
                  throw new DiscordGatewayError("http_error");
                }
                if (attempt === maxRetries) throw new DiscordGatewayError("rate_limited");
                let retryAfterMs = 1_000;
                try {
                  const rate = JSON.parse(bodyText ?? "") as { retry_after?: unknown };
                  const seconds = Number(rate.retry_after);
                  if (Number.isFinite(seconds)) {
                    retryAfterMs = Math.min(30_000, Math.max(0, Math.ceil(seconds * 1_000)));
                  }
                } catch { /* fixed bounded fallback */ }
                await abortableSleep(sleep, retryAfterMs, input.signal);
              }
              throw new DiscordGatewayError("rate_limited");
            } catch (error) {
              rejectReply(error);
            }
          });
          replyQueue = queued.catch(() => {});
          return result;
        },
      };
      return connection;
    },
  };
}
