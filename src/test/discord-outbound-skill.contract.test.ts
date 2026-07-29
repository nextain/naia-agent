import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeDiscordOutboundExecutor } from "../main/adapters/discord-outbound-skill.js";

describe("discord_send skill", () => {
  it("is ask-gated and sends only through the host delivery port", async () => {
    const calls: unknown[] = [];
    const root = await mkdtemp(join(tmpdir(), "naia-discord-send-"));
    await writeFile(join(root, "result.txt"), "done");
    const executor = makeDiscordOutboundExecutor({ workspace: () => root, delivery: { send: async (input) => { calls.push(input); return { messageId: "1" }; } } });
    expect(executor.specs()[0]?.tier).toBe("ask");
    const result = await executor.execute({ id: "x", name: "discord_send", args: { destinationId: "approved", content: "result", files: ["result.txt"] } }, {});
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("rejects private and escaping file paths before delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "naia-discord-send-"));
    await mkdir(join(root, "data-private"));
    await writeFile(join(root, "data-private", "secret.txt"), "secret");
    const executor = makeDiscordOutboundExecutor({ workspace: () => root, delivery: { send: async () => ({ messageId: "1" }) } });
    const result = await executor.execute({ id: "x", name: "discord_send", args: { destinationId: "approved", content: "result", files: ["data-private/secret.txt"] } }, {});
    expect(result.isError).toBe(true);
  });

  it("lists only host-approved opaque destination ids", async () => {
    const executor = makeDiscordOutboundExecutor({ workspace: () => undefined, destinationIds: () => ["dm_10", "course_channel"] });
    await expect(executor.execute({ id: "x", name: "discord_send", args: { action: "list" } }, {})).resolves.toEqual({ output: "Approved Discord destinations: dm_10, course_channel" });
  });
});
