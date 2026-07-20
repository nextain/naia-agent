import { describe, expect, it, vi } from "vitest";
import {
  makeFileDiscordDedupe,
  type DiscordDedupeFs,
} from "../main/adapters/discord-dedupe-store.js";

function memoryFs(initial?: string): DiscordDedupeFs & { value?: string } {
  return {
    value: initial,
    read() { return this.value; },
    replace(_path, contents) { this.value = contents; },
  };
}

const reserve = (bindingId: string, messageId: string, now: number) => ({ bindingId, messageId, now });

describe("T-DISCORD-RT-04 — binding-scoped durable reply state", () => {
  it("rejects a live duplicate but releases an unfinished reservation after reconstruction", async () => {
    const fs = memoryFs();
    const first = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 4, ttlMs: 1_000 });
    expect(await first.reserve(reserve("binding_1", "message_1", 100))).toEqual({ decision: "process" });
    expect(await first.reserve(reserve("binding_1", "message_1", 101))).toEqual({ decision: "duplicate" });
    const reconstructed = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 4, ttlMs: 1_000 });
    expect(await reconstructed.reserve(reserve("binding_1", "message_1", 102))).toEqual({ decision: "process" });
  });

  it("does not collide when two trusted bindings use the same message id", async () => {
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs: memoryFs() });
    expect(await store.reserve(reserve("binding_1", "same", 100))).toEqual({ decision: "process" });
    expect(await store.reserve(reserve("binding_2", "same", 100))).toEqual({ decision: "process" });
  });

  it("allows exactly one reservation winner in one runtime", async () => {
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs: memoryFs() });
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      store.reserve(reserve("binding_1", "same", 100))));
    expect(results.filter((result) => result.decision === "process")).toHaveLength(1);
  });

  it("recovers a durable outbox at the first unsent chunk", async () => {
    const fs = memoryFs();
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    await store.reserve(reserve("binding_1", "m1", 100));
    expect(await store.beginReply({
      bindingId: "binding_1", messageId: "m1", chunks: ["one", "two"], now: 101,
    })).toBe(true);
    expect(await store.claimChunk({
      bindingId: "binding_1", messageId: "m1", nextChunk: 1, now: 102,
    })).toBe(true);
    expect(await store.confirmChunk({
      bindingId: "binding_1", messageId: "m1", confirmedChunk: 1, now: 102,
    })).toBe(true);
    const reconstructed = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    expect(await reconstructed.reserve(reserve("binding_1", "m1", 103))).toEqual({
      decision: "resume_reply", chunks: ["one", "two"], nextChunk: 1,
    });
    expect(await reconstructed.claimChunk({
      bindingId: "binding_1", messageId: "m1", nextChunk: 2, now: 104,
    })).toBe(true);
    expect(await reconstructed.confirmChunk({
      bindingId: "binding_1", messageId: "m1", confirmedChunk: 2, now: 104,
    })).toBe(true);
    expect(await reconstructed.reserve(reserve("binding_1", "m1", 105))).toEqual({ decision: "duplicate" });
  });

  it("records a partial multi-chunk reply truthfully and never replays it", async () => {
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs: memoryFs() });
    await store.reserve(reserve("binding_1", "m1", 100));
    await store.beginReply({ bindingId: "binding_1", messageId: "m1", chunks: ["one", "two"], now: 101 });
    await store.claimChunk({ bindingId: "binding_1", messageId: "m1", nextChunk: 1, now: 102 });
    await store.confirmChunk({ bindingId: "binding_1", messageId: "m1", confirmedChunk: 1, now: 102 });
    expect(await store.partial({
      bindingId: "binding_1", messageId: "m1", confirmedChunk: 1, now: 103,
    })).toBe(true);
    expect(await store.reserve(reserve("binding_1", "m1", 104))).toEqual({ decision: "duplicate" });
  });

  it("keeps the confirmed cursor monotonic when shutdown records an older partial", async () => {
    const fs = memoryFs();
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    await store.reserve(reserve("binding_1", "m1", 100));
    await store.beginReply({ bindingId: "binding_1", messageId: "m1", chunks: ["one", "two"], now: 101 });
    await store.claimChunk({ bindingId: "binding_1", messageId: "m1", nextChunk: 1, now: 102 });
    await store.confirmChunk({ bindingId: "binding_1", messageId: "m1", confirmedChunk: 1, now: 103 });

    expect(await store.partial({
      bindingId: "binding_1", messageId: "m1", confirmedChunk: 0, now: 104,
    })).toBe(true);
    expect(await store.partial({
      bindingId: "binding_1", messageId: "m1", confirmedChunk: 0, now: 105,
    })).toBe(true);

    expect(JSON.parse(fs.value!).entries[0]).toMatchObject({
      state: "partial",
      confirmedChunk: 1,
    });
    expect(await store.reserve(reserve("binding_1", "m1", 106))).toEqual({ decision: "duplicate" });
  });

  it("never resends a chunk that was claimed before an ambiguous crash", async () => {
    const fs = memoryFs();
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    await store.reserve(reserve("binding_1", "m1", 100));
    await store.beginReply({ bindingId: "binding_1", messageId: "m1", chunks: ["uncertain"], now: 101 });
    await store.claimChunk({ bindingId: "binding_1", messageId: "m1", nextChunk: 1, now: 102 });
    const reconstructed = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    expect(await reconstructed.reserve(reserve("binding_1", "m1", 103))).toEqual({ decision: "duplicate" });
    expect(JSON.parse(fs.value!).entries[0].state).toBe("partial");
  });

  it("does not prune in-progress reservations or outboxes at capacity", async () => {
    const fs = memoryFs();
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 1 });
    await store.reserve(reserve("binding_1", "m1", 100));
    await store.beginReply({ bindingId: "binding_1", messageId: "m1", chunks: ["pending"], now: 101 });
    expect(await store.reserve(reserve("binding_1", "m2", 102))).toEqual({ decision: "duplicate" });
    const reconstructed = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 1 });
    expect(await reconstructed.reserve(reserve("binding_1", "m1", 103))).toEqual({
      decision: "resume_reply", chunks: ["pending"], nextChunk: 0,
    });
  });

  it("bounds records and permits expiry", async () => {
    const fs = memoryFs();
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 2, ttlMs: 10 });
    await store.reserve(reserve("b1", "m1", 100));
    await store.complete({ bindingId: "b1", messageId: "m1", now: 100 });
    await store.reserve(reserve("b1", "m2", 101));
    await store.complete({ bindingId: "b1", messageId: "m2", now: 101 });
    await store.reserve(reserve("b1", "m3", 102));
    await store.complete({ bindingId: "b1", messageId: "m3", now: 102 });
    expect((JSON.parse(fs.value!) as { entries: unknown[] }).entries).toHaveLength(2);
    expect(await store.reserve(reserve("b1", "m1", 111))).toEqual({ decision: "process" });
  });

  it("fails closed on invalid identity/time and persistence failure", async () => {
    const fs = memoryFs();
    const replace = vi.spyOn(fs, "replace").mockImplementation(() => { throw new Error("disk full"); });
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    expect(await store.reserve(reserve("bad id", "m1", 1))).toEqual({ decision: "duplicate" });
    expect(await store.reserve(reserve("b1", "m1", Number.NaN))).toEqual({ decision: "duplicate" });
    expect(await store.reserve(reserve("b1", "m1", 1))).toEqual({ decision: "duplicate" });
    replace.mockRestore();
    expect(await store.reserve(reserve("b1", "m1", 1))).toEqual({ decision: "process" });
  });

  it.each([
    "{",
    "null",
    JSON.stringify({ version: 2, entries: [{ bindingId: "b", messageId: "same", updatedAt: 1, state: "reserved" }, { bindingId: "b", messageId: "same", updatedAt: 2, state: "reserved" }] }),
    JSON.stringify({ version: 2, entries: [{ bindingId: "b", messageId: "m", updatedAt: 1, state: "replying", chunks: [], nextChunk: 0, confirmedChunk: 0 }] }),
  ])("rejects corrupt state without resetting it: %s", (raw) => {
    expect(() => makeFileDiscordDedupe({ path: "dedupe.json", fs: memoryFs(raw) }))
      .toThrow("DISCORD_DEDUPE_CORRUPT");
  });

  it("stores no token or original user message fields", async () => {
    const fs = memoryFs();
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    await store.reserve(reserve("b1", "m1", 1));
    expect(fs.value).not.toMatch(/token|secret|userMessage|prompt/i);
  });
});
