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
import { replaceOwnerOnlyAtomic } from "../main/adapters/owner-only-atomic-file.js";

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

  it("treats replay of the same recordId as an idempotent append", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-discord-inbox-")), "inbox.json");
    const inbox = makeFileDiscordInbox({ path, generation: "generation_1" });
    await expect(inbox.append(record(1))).resolves.toBe(true);
    await expect(inbox.append(record(1))).resolves.toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).channels["binding_1:100:200"])
      .toEqual([record(1)]);
  });

  it("retries the same record after an atomic replace failure without a phantom commit", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-discord-inbox-")), "inbox.json");
    let attempts = 0;
    const inbox = makeFileDiscordInbox({
      path,
      generation: "generation_1",
      replaceAtomic(target, contents) {
        attempts += 1;
        if (attempts === 1) throw new Error("simulated replace failure");
        replaceOwnerOnlyAtomic(target, contents);
      },
    });

    await expect(inbox.append(record(1))).resolves.toBe(false);
    await expect(inbox.append(record(1))).resolves.toBe(true);

    expect(attempts).toBe(2);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      generation: "generation_1",
      channels: {
        "binding_1:100:200": [record(1)],
      },
    });
  });

  it("quarantines corruption and starts an empty future-event cache", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "naia-discord-inbox-")), "inbox.json");
    writeFileSync(path, "{not-json", { mode: 0o600 });
    const inbox = makeFileDiscordInbox({ path, generation: "generation_1" });
    await expect(inbox.append(record(1))).resolves.toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).channels["binding_1:100:200"]).toEqual([record(1)]);
  });

  it("quarantines a loaded channel that exceeds configured record bounds", async () => {
    const root = mkdtempSync(join(tmpdir(), "naia-discord-inbox-"));
    const path = join(root, "inbox.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      generation: "generation_1",
      channels: {
        "binding_1:100:200": [record(1), record(2)],
      },
    }), { mode: 0o600 });
    const inbox = makeFileDiscordInbox({
      path,
      generation: "generation_1",
      maxRecordsPerChannel: 1,
    });

    await expect(inbox.append(record(3))).resolves.toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).channels["binding_1:100:200"])
      .toEqual([record(3)]);
    expect(readdirSync(root).some((name) => name.startsWith("inbox.json.corrupt-")))
      .toBe(true);
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
