import type { OutboundAttachment, OutboundDeliveryPort } from "../ports/outbound-delivery.js";

export type DiscordOutboundDestination =
  | { readonly id: string; readonly kind: "dm"; readonly userId: string }
  | { readonly id: string; readonly kind: "channel"; readonly guildId: string; readonly channelId: string };

export interface DiscordOutboundPolicy {
  readonly destinations: readonly DiscordOutboundDestination[];
}

export class DiscordOutboundError extends Error {
  constructor(readonly code: "unavailable" | "invalid_destination" | "invalid_content" | "permission_denied" | "rate_limited" | "http_error") {
    super(code);
    this.name = "DiscordOutboundError";
  }
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SNOWFLAKE = /^\d{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_CONTENT = 2_000;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !CONTROL.test(value);
}

export function parseDiscordOutboundPolicy(value: unknown): DiscordOutboundPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.destinations) || root.destinations.length > 128
    || Object.keys(root).some((key) => key !== "version" && key !== "destinations")) return undefined;
  const ids = new Set<string>();
  const destinations: DiscordOutboundDestination[] = [];
  for (const raw of root.destinations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const item = raw as Record<string, unknown>;
    if (!ID.test(String(item.id ?? "")) || ids.has(String(item.id))) return undefined;
    if (item.kind === "dm" && SNOWFLAKE.test(String(item.userId ?? ""))
      && Object.keys(item).every((key) => ["id", "kind", "userId", "label"].includes(key))) {
      ids.add(item.id as string);
      destinations.push({ id: item.id as string, kind: "dm", userId: item.userId as string });
      continue;
    }
    if (item.kind === "channel" && SNOWFLAKE.test(String(item.guildId ?? "")) && SNOWFLAKE.test(String(item.channelId ?? ""))
      && Object.keys(item).every((key) => ["id", "kind", "guildId", "channelId", "label"].includes(key))) {
      ids.add(item.id as string);
      destinations.push({ id: item.id as string, kind: "channel", guildId: item.guildId as string, channelId: item.channelId as string });
      continue;
    }
    return undefined;
  }
  return { destinations };
}

async function responseText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!Number.isSafeInteger(Number(length)) || Number(length) > MAX_RESPONSE_BYTES)) {
    throw new DiscordOutboundError("http_error");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new DiscordOutboundError("http_error");
  return text;
}

function validateAttachments(attachments: readonly OutboundAttachment[]): void {
  if (attachments.length > MAX_FILES) throw new DiscordOutboundError("invalid_content");
  let total = 0;
  for (const attachment of attachments) {
    if (!boundedString(attachment.name, 180) || attachment.name.includes("/") || attachment.name.includes("\\")
      || !boundedString(attachment.mimeType, 128) || attachment.bytes.byteLength > MAX_FILE_BYTES) {
      throw new DiscordOutboundError("invalid_content");
    }
    total += attachment.bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) throw new DiscordOutboundError("invalid_content");
  }
}

export function makeDiscordOutbound(options: {
  readonly token: string;
  readonly policy: DiscordOutboundPolicy;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
}): OutboundDeliveryPort {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? "https://discord.com/api/v10";
  const destinations = new Map(options.policy.destinations.map((destination) => [destination.id, destination]));
  const dmChannels = new Map<string, string>();
  if (!boundedString(options.token, 512)) throw new DiscordOutboundError("unavailable");

  const request = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch { throw new DiscordOutboundError("http_error"); }
    const text = await responseText(response);
    if (response.status === 401) throw new DiscordOutboundError("unavailable");
    if (response.status === 403) throw new DiscordOutboundError("permission_denied");
    if (response.status === 429) throw new DiscordOutboundError("rate_limited");
    if (!response.ok) throw new DiscordOutboundError("http_error");
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch { throw new DiscordOutboundError("http_error"); }
  };

  const channelFor = async (destination: DiscordOutboundDestination, signal?: AbortSignal): Promise<string> => {
    if (destination.kind === "channel") return destination.channelId;
    const cached = dmChannels.get(destination.userId);
    if (cached) return cached;
    const body = await request(`${apiBase}/users/@me/channels`, {
      method: "POST",
      headers: { authorization: `Bot ${options.token}`, "content-type": "application/json" },
      signal,
      body: JSON.stringify({ recipient_id: destination.userId }),
    });
    const id = String(body.id ?? "");
    if (!SNOWFLAKE.test(id)) throw new DiscordOutboundError("http_error");
    dmChannels.set(destination.userId, id);
    return id;
  };

  return {
    async send(input) {
      const destination = destinations.get(input.destinationId);
      if (!destination) throw new DiscordOutboundError("invalid_destination");
      if (!boundedString(input.content, MAX_CONTENT)) throw new DiscordOutboundError("invalid_content");
      const attachments = input.attachments ?? [];
      validateAttachments(attachments);
      const channelId = await channelFor(destination, input.signal);
      const headers = { authorization: `Bot ${options.token}` };
      let body: BodyInit;
      if (!attachments.length) {
        body = JSON.stringify({ content: input.content, allowed_mentions: { parse: [] } });
        Object.assign(headers, { "content-type": "application/json" });
      } else {
        const form = new FormData();
        form.set("payload_json", JSON.stringify({ content: input.content, allowed_mentions: { parse: [] } }));
        attachments.forEach((attachment, index) => {
          // Copy into an owned ArrayBuffer: Uint8Array may otherwise expose a
          // SharedArrayBuffer view, which is not a valid BlobPart in Node's DOM typings.
          const bytes = Uint8Array.from(attachment.bytes);
          form.set(`files[${index}]`, new Blob([bytes.buffer], { type: attachment.mimeType }), attachment.name);
        });
        body = form;
      }
      const result = await request(`${apiBase}/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST", headers, body, signal: input.signal,
      });
      const messageId = String(result.id ?? "");
      if (!SNOWFLAKE.test(messageId)) throw new DiscordOutboundError("http_error");
      return { messageId };
    },
  };
}
