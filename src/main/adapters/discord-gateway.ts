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

const GUILD_MESSAGES_INTENTS = 1 | 512 | 32_768;
const MAX_TOKEN_LENGTH = 512;
const MAX_REPLY_LENGTH = 2_000;
const MAX_EVENT_LENGTH = 1_000_000;
const MAX_MESSAGE_LENGTH = 4_000;
const SNOWFLAKE = /^\d{1,128}$/;

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

function asMessage(value: unknown): DiscordGatewayMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  const author = message.author as Record<string, unknown> | undefined;
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
  return {
    messageId: message.id,
    guildId: typeof message.guild_id === "string" ? message.guild_id : null,
    channelId: message.channel_id,
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
  let sessionId: string | undefined;
  let resumeUrl: string | undefined;
  let resumeSequence: number | null = null;
  let resumedSelfUserId: string | undefined;

  return {
    async connect(token, handlers) {
      if (typeof token !== "string" || token.length < 1 || token.length > MAX_TOKEN_LENGTH) {
        throw new DiscordGatewayError("auth_failed");
      }
      let gatewayUrl = resumeUrl;
      if (!gatewayUrl) {
        const discovery = await fetchImpl(`${apiBase}/gateway/bot`, {
          headers: { authorization: `Bot ${token}` },
        });
        if (discovery.status === 401) throw new DiscordGatewayError("auth_failed");
        if (!discovery.ok) throw new DiscordGatewayError("gateway_unavailable");
        const body = await discovery.json() as { url?: unknown };
        if (typeof body.url !== "string" || !body.url.startsWith("wss://")) {
          throw new DiscordGatewayError("gateway_unavailable");
        }
        gatewayUrl = body.url;
      }

      const socket = socketFactory(`${gatewayUrl}?v=10&encoding=json`);
      let sequence: number | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let awaitingHeartbeatAck = false;
      let settled = false;
      let resolveClosed!: (value: DiscordGatewayClose) => void;
      const closed = new Promise<DiscordGatewayClose>((resolve) => { resolveClosed = resolve; });
      const settle = (reason: DiscordGatewayClose) => {
        if (settled) return;
        settled = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        resolveClosed(reason);
      };
      const send = (payload: unknown) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(payload));
      };
      const requestReconnect = () => {
        try { socket.close(4_000, "reconnect"); } catch { /* close event settles */ }
        settle({ code: "reconnect_requested", retryable: true });
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
                intents: GUILD_MESSAGES_INTENTS,
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
          } | undefined;
          if (typeof ready?.user?.id === "string") handlers.onReady(ready.user.id);
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
          if (resumedSelfUserId) handlers.onReady(resumedSelfUserId);
          return;
        }
        if (payload.t === "MESSAGE_CREATE") {
          const message = asMessage(payload.d);
          if (message) handlers.onMessage(message);
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
        settle(closeReason(event.code));
      });
      socket.addEventListener("error", () => settle({ code: "network_error", retryable: true }));

      const connection: DiscordGatewayConnection = {
        closed,
        close() {
          if (settled) return;
          try { socket.close(1_000, "shutdown"); } finally {
            settle({ code: "closed", retryable: false });
          }
        },
        async sendReply(input) {
          if (!input.content || input.content.length > MAX_REPLY_LENGTH
            || !SNOWFLAKE.test(input.channelId) || !SNOWFLAKE.test(input.guildId)
            || !SNOWFLAKE.test(input.messageId)) {
            throw new DiscordGatewayError("invalid_reply");
          }
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const response = await fetchImpl(
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
                  message_reference: {
                    message_id: input.messageId,
                    channel_id: input.channelId,
                    guild_id: input.guildId,
                    fail_if_not_exists: false,
                  },
                  allowed_mentions: { parse: [], replied_user: false },
                }),
              },
            );
            if (response.ok) return;
            if (response.status === 401) throw new DiscordGatewayError("auth_failed");
            if (response.status === 403) throw new DiscordGatewayError("permission_denied");
            if (response.status !== 429) throw new DiscordGatewayError("http_error");
            if (attempt === maxRetries) throw new DiscordGatewayError("rate_limited");
            let retryAfterMs = 1_000;
            try {
              const rate = await response.json() as { retry_after?: unknown };
              const seconds = Number(rate.retry_after);
              if (Number.isFinite(seconds)) retryAfterMs = Math.min(30_000, Math.max(0, Math.ceil(seconds * 1_000)));
            } catch { /* fixed bounded fallback */ }
            if (input.signal?.aborted) throw new DiscordGatewayError("http_error");
            await new Promise<void>((resolve, reject) => {
              let settledSleep = false;
              const finish = (action: () => void) => {
                if (settledSleep) return;
                settledSleep = true;
                input.signal?.removeEventListener("abort", onAbort);
                action();
              };
              const onAbort = () => finish(() => reject(new DiscordGatewayError("http_error")));
              input.signal?.addEventListener("abort", onAbort, { once: true });
              void sleep(retryAfterMs).then(
                () => finish(resolve),
                () => finish(() => reject(new DiscordGatewayError("http_error"))),
              );
            });
          }
        },
      };
      return connection;
    },
  };
}
