import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFileDiscordInbox } from "../main/adapters/discord-inbox-store.js";

function record(index: number) {
  return {
    recordId: `incoming_${index}`,
    direction: "incoming" as const,
    bindingId: "binding_1",
    guildId: "100",
    channelId: "200",
    sourceMessageId: String(300 + index),
    authorId: "400",
    content: `message-${index}`,
    createdAt: 1_000 + index,
  };
}

describe("FR-DISCORD.5/6 — owner-only inbox cache", () => {
  it("serializes concurrent appends and bounds each channel", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-discord-inbox-")), "inbox.json");
    const inbox = makeFileDiscordInbox({
      path,
      generation: "generation_1",
      maxRecordsPerChannel: 2,
      maxBytesPerChannel: 1_024,
    });
    await Promise.all([inbox.append(record(1)), inbox.append(record(2)), inbox.append(record(3))]);
    const document = JSON.parse(readFileSync(path, "utf8"));
    expect(document).toEqual({
      version: 1,
      generation: "generation_1",
      channels: {
        "binding_1:100:200": [record(2), record(3)],
      },
    });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("quarantines corruption and starts an empty future-event cache", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-discord-inbox-")), "inbox.json");
    writeFileSync(path, "{not-json", { mode: 0o600 });
    const inbox = makeFileDiscordInbox({ path, generation: "generation_1" });
    await expect(inbox.append(record(1))).resolves.toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).channels["binding_1:100:200"]).toEqual([record(1)]);
  });

  it("rejects malformed records without writing content", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-discord-inbox-")), "inbox.json");
    const inbox = makeFileDiscordInbox({ path, generation: "generation_1" });
    await expect(inbox.append({ ...record(1), content: "" })).resolves.toBe(false);
  });

  it("fails closed on non-corruption read errors without moving the target", async () => {
    const root = mkdtempSync(join(tmpdir(), "naia-discord-inbox-"));
    const path = join(root, "inbox.json");
    mkdirSync(path);
    const inbox = makeFileDiscordInbox({ path, generation: "generation_1" });

    await expect(inbox.append(record(1))).resolves.toBe(false);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(root)).toEqual(["inbox.json"]);
  });
});
