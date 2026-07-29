import { describe, expect, it } from "vitest";
import { DiscordOutboundError, makeDiscordOutbound, parseDiscordOutboundPolicy } from "../main/adapters/discord-outbound.js";

const policy = parseDiscordOutboundPolicy({
  version: 1,
  destinations: [
    { id: "owner-dm", kind: "dm", userId: "10" },
    { id: "reports", kind: "channel", guildId: "20", channelId: "30" },
  ],
});

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Discord outbound policy", () => {
  it("accepts only a bounded explicit DM/channel policy", () => {
    expect(policy?.destinations).toHaveLength(2);
    expect(parseDiscordOutboundPolicy({ version: 1, destinations: [{ id: "x", kind: "dm", userId: "not-a-snowflake", extra: true }] })).toBeUndefined();
    expect(parseDiscordOutboundPolicy({ version: 1, destinations: [{ id: "x", kind: "channel", guildId: "1", channelId: "2" }, { id: "x", kind: "dm", userId: "3" }] })).toBeUndefined();
  });

  it("opens an approved DM then sends with mentions disabled", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const send = makeDiscordOutbound({
      token: "token",
      policy: policy!,
      apiBase: "https://discord.test/api",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return calls.length === 1 ? reply({ id: "99" }) : reply({ id: "100" });
      },
    });
    await expect(send.send({ destinationId: "owner-dm", content: "done" })).resolves.toEqual({ messageId: "100" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://discord.test/api/users/@me/channels",
      "https://discord.test/api/channels/99/messages",
    ]);
    expect(JSON.parse(String(calls[1]!.init!.body))).toMatchObject({ content: "done", allowed_mentions: { parse: [] } });
  });

  it("does not send arbitrary destinations or over-limit content", async () => {
    const send = makeDiscordOutbound({ token: "token", policy: policy!, fetch: async () => reply({ id: "100" }) });
    await expect(send.send({ destinationId: "not-approved", content: "x" })).rejects.toMatchObject({ code: "invalid_destination" } satisfies Partial<DiscordOutboundError>);
    await expect(send.send({ destinationId: "reports", content: "x".repeat(2_001) })).rejects.toMatchObject({ code: "invalid_content" } satisfies Partial<DiscordOutboundError>);
  });

  it("uses multipart only for bounded attachments", async () => {
    let request: RequestInit | undefined;
    const send = makeDiscordOutbound({
      token: "token", policy: policy!,
      fetch: async (_url, init) => { request = init; return reply({ id: "100" }); },
    });
    await send.send({ destinationId: "reports", content: "report", attachments: [{ name: "summary.txt", mimeType: "text/plain", bytes: new Uint8Array([1, 2]) }] });
    expect(request!.body).toBeInstanceOf(FormData);
    await expect(send.send({ destinationId: "reports", content: "report", attachments: [{ name: "../secret", mimeType: "text/plain", bytes: new Uint8Array() }] })).rejects.toMatchObject({ code: "invalid_content" } satisfies Partial<DiscordOutboundError>);
  });
});
