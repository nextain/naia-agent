import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeFileDiscordDedupe,
  repairFileDiscordDedupeLock,
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
  it("keeps an accepted reservation duplicate after a crash during a post-reserve await", async () => {
    const fs = memoryFs();
    const first = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 4, ttlMs: 1_000 });
    expect(await first.reserve(reserve("binding_1", "message_1", 100))).toEqual({ decision: "process" });
    expect(await first.reserve(reserve("binding_1", "message_1", 101))).toEqual({ decision: "duplicate" });

    // Simulate a process crash while inbox/config work after reserve never resolves.
    expect(JSON.parse(fs.value!).entries[0]).toMatchObject({
      bindingId: "binding_1",
      messageId: "message_1",
      state: "reserved",
    });
    const reconstructed = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 4, ttlMs: 1_000 });
    expect(JSON.parse(fs.value!).entries[0]).toMatchObject({
      bindingId: "binding_1",
      messageId: "message_1",
      state: "partial",
      confirmedChunk: 0,
    });
    expect(await reconstructed.reserve(reserve("binding_1", "message_1", 102))).toEqual({ decision: "duplicate" });
    expect(await reconstructed.refresh?.()).toBe(true);
    expect(await reconstructed.reserve(reserve("binding_1", "message_1", 103))).toEqual({ decision: "duplicate" });
  });

  it("recovers capacity after a reconstructed reservation reaches its TTL", async () => {
    const fs = memoryFs();
    const first = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 1, ttlMs: 1_000 });
    expect(await first.reserve(reserve("binding_1", "message_1", 100))).toEqual({ decision: "process" });

    const reconstructed = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 1, ttlMs: 1_000 });
    expect(await reconstructed.reserve(reserve("binding_1", "message_2", 1_099))).toEqual({ decision: "duplicate" });
    expect(await reconstructed.reserve(reserve("binding_1", "message_2", 1_101))).toEqual({ decision: "process" });
    expect(JSON.parse(fs.value!).entries).toEqual([
      expect.objectContaining({ messageId: "message_2", state: "reserved" }),
    ]);
  });

  it("terminalizes an accepted reservation discovered at an authority refresh", async () => {
    const fs = memoryFs();
    const nextAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs, ttlMs: 1_000 });
    const oldAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs, ttlMs: 1_000 });
    expect(await oldAuthority.reserve(reserve("binding_1", "message_1", 100))).toEqual({ decision: "process" });

    expect(await nextAuthority.refresh?.()).toBe(true);
    expect(JSON.parse(fs.value!).entries[0]).toMatchObject({
      state: "partial",
      confirmedChunk: 0,
    });
    expect(await nextAuthority.reserve(reserve("binding_1", "message_1", 101))).toEqual({ decision: "duplicate" });
  });

  it("fails refresh closed when recovered reservation persistence fails", async () => {
    const fs = memoryFs();
    const writer = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    await writer.reserve(reserve("binding_1", "completed", 90));
    await writer.complete({ bindingId: "binding_1", messageId: "completed", now: 91 });
    const nextAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    fs.value = JSON.stringify({
      version: 2,
      entries: [{
        bindingId: "binding_1",
        messageId: "interrupted",
        updatedAt: 100,
        state: "reserved",
      }],
    });
    const replace = vi.spyOn(fs, "replace").mockImplementation(() => { throw new Error("disk full"); });

    expect(await nextAuthority.refresh?.()).toBe(false);
    replace.mockRestore();
    expect(await nextAuthority.reserve(reserve("binding_1", "completed", 101))).toEqual({ decision: "duplicate" });
  });

  it("does not let a late old-authority partial erase a new reservation", async () => {
    const fs = memoryFs();
    const oldAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 4 });
    expect(await oldAuthority.reserve(reserve("binding_1", "old_message", 100))).toEqual({ decision: "process" });

    const nextAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 4 });
    expect(await nextAuthority.reserve(reserve("binding_1", "new_message", 101))).toEqual({ decision: "process" });
    expect(await oldAuthority.partial({
      bindingId: "binding_1", messageId: "old_message", confirmedChunk: 0, now: 102,
    })).toBe(false);

    expect(JSON.parse(fs.value!).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "old_message", state: "partial", confirmedChunk: 0 }),
      expect.objectContaining({ messageId: "new_message", state: "reserved" }),
    ]));
    const afterHandoff = makeFileDiscordDedupe({ path: "dedupe.json", fs, maxEntries: 4 });
    expect(await afterHandoff.reserve(reserve("binding_1", "new_message", 103))).toEqual({ decision: "duplicate" });
  });

  it("rejects a late old owner write after the same message id is reserved again", async () => {
    const fs = memoryFs();
    const oldAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs, ttlMs: 10 });
    await oldAuthority.reserve(reserve("binding_1", "same_message", 100));
    const nextAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs, ttlMs: 10 });
    expect(await nextAuthority.reserve(reserve("binding_1", "same_message", 111))).toEqual({ decision: "process" });

    expect(await oldAuthority.partial({
      bindingId: "binding_1", messageId: "same_message", confirmedChunk: 0, now: 112,
    })).toBe(false);
    expect(JSON.parse(fs.value!).entries[0]).toMatchObject({ messageId: "same_message", state: "reserved" });
  });

  it("rotates a resumable reply owner and fences the old authority", async () => {
    const fs = memoryFs();
    const oldAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    await oldAuthority.reserve(reserve("binding_1", "reply", 100));
    await oldAuthority.beginReply({ bindingId: "binding_1", messageId: "reply", chunks: ["one", "two"], now: 101 });
    await oldAuthority.claimChunk({ bindingId: "binding_1", messageId: "reply", nextChunk: 1, now: 102 });
    await oldAuthority.confirmChunk({ bindingId: "binding_1", messageId: "reply", confirmedChunk: 1, now: 103 });

    const nextAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    expect(await oldAuthority.partial({
      bindingId: "binding_1", messageId: "reply", confirmedChunk: 1, now: 104,
    })).toBe(false);
    expect(await nextAuthority.reserve(reserve("binding_1", "reply", 105))).toEqual({
      decision: "resume_reply", chunks: ["one", "two"], nextChunk: 1,
    });
    expect(await oldAuthority.claimChunk({
      bindingId: "binding_1", messageId: "reply", nextChunk: 2, now: 106,
    })).toBe(false);
    expect(await nextAuthority.claimChunk({
      bindingId: "binding_1", messageId: "reply", nextChunk: 2, now: 107,
    })).toBe(true);
  });

  it("does not resurrect an unrelated reservation removed by the new owner", async () => {
    const fs = memoryFs();
    const oldAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs, ttlMs: 10 });
    await oldAuthority.reserve(reserve("binding_1", "released", 100));
    await oldAuthority.reserve(reserve("binding_1", "late_partial", 105));
    const nextAuthority = makeFileDiscordDedupe({ path: "dedupe.json", fs, ttlMs: 10 });
    await nextAuthority.reserve(reserve("binding_1", "released", 111));
    expect(await nextAuthority.releaseReservation?.({
      bindingId: "binding_1", messageId: "released", now: 112,
    })).toBe(true);

    expect(await oldAuthority.partial({
      bindingId: "binding_1", messageId: "late_partial", confirmedChunk: 0, now: 113,
    })).toBe(false);
    expect(JSON.parse(fs.value!).entries).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "released" }),
    ]));
  });

  it("requires explicit dead-owner lock repair and cleans the owned lock after failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "naia-discord-dedupe-"));
    const path = join(directory, "dedupe.json");
    const lockPath = `${path}.lock`;
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 2_147_483_647, token: "dead" }));
      expect(() => makeFileDiscordDedupe({ path })).toThrow("DISCORD_DEDUPE_BUSY");
      expect(repairFileDiscordDedupeLock(path)).toBe(true);
      const store = makeFileDiscordDedupe({ path });
      expect(existsSync(lockPath)).toBe(false);

      writeFileSync(path, "{");
      expect(await store.refresh?.()).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not leak a candidate when a live owner holds the lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "naia-discord-dedupe-"));
    const path = join(directory, "dedupe.json");
    const lockPath = `${path}.lock`;
    try {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, token: "live" }));
      expect(repairFileDiscordDedupeLock(path)).toBe(false);
      expect(() => makeFileDiscordDedupe({ path })).toThrow("DISCORD_DEDUPE_BUSY");
      expect(readdirSync(directory)).toEqual(["dedupe.json.lock"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

  it("reclaims only an explicit host lifecycle partial from its confirmed cursor", async () => {
    const fs = memoryFs();
    const store = makeFileDiscordDedupe({ path: "dedupe.json", fs });
    await store.reserve(reserve("binding_1", "course_received_abc", 100));
    await store.beginReply({
      bindingId: "binding_1", messageId: "course_received_abc", chunks: ["received"], now: 101,
    });
    await store.claimChunk({
      bindingId: "binding_1", messageId: "course_received_abc", nextChunk: 1, now: 102,
    });
    expect(await store.partial({
      bindingId: "binding_1", messageId: "course_received_abc", confirmedChunk: 0, now: 103,
    })).toBe(true);

    // The generic reservation remains a duplicate: it must never re-run an
    // inbound model turn. A host lifecycle sender explicitly opts into retry.
    expect(await store.reserve(reserve("binding_1", "course_received_abc", 104))).toEqual({ decision: "duplicate" });
    expect(await store.resumePartialReply?.({
      bindingId: "binding_1", messageId: "course_received_abc", chunks: ["received"], now: 105,
    })).toEqual({ decision: "resumed", nextChunk: 0 });
    expect(await store.claimChunk({
      bindingId: "binding_1", messageId: "course_received_abc", nextChunk: 1, now: 106,
    })).toBe(true);
    expect(await store.confirmChunk({
      bindingId: "binding_1", messageId: "course_received_abc", confirmedChunk: 1, now: 106,
    })).toBe(true);
    expect(await store.reserve(reserve("binding_1", "course_received_abc", 107))).toEqual({ decision: "duplicate" });
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
