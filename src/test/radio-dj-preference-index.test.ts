import { describe, expect, it, vi } from "vitest";
import {
  makeFileRadioDjPreferencePersistence,
  makeRadioDjPreferenceStore,
  type RadioDjPreferenceDocument,
} from "../main/adapters/radio-dj-runtime.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function persistence(initial?: RadioDjPreferenceDocument) {
  let document = initial;
  let commitCount = 0;
  let failAt = -1;
  return {
    load: vi.fn(async () => document),
    commit: vi.fn(async (next: RadioDjPreferenceDocument) => {
      commitCount++;
      if (commitCount === failAt) throw new Error("injected commit failure");
      document = structuredClone(next);
    }),
    read: () => document,
    failCommit: (call: number) => { failAt = call; },
  };
}

const signal = (
  sentiment: "like" | "dislike" | "forget",
  subject: string,
  requestId: string,
) => ({
  sentiment,
  subject,
  sessionId: "agent:main:main",
  requestId,
  statedAt: "2026-07-20T00:00:00.000Z",
  source: "explicit_user_turn" as const,
});

describe("PA-DJ-01 exact preference index", () => {
  it("orders same-time updates by persisted sequence", async () => {
    const durable = persistence();
    const store = makeRadioDjPreferenceStore({ persistence: durable });
    await store.handoff(signal("like", "  Jazz  ", "uuid-z"));
    await store.handoff(signal("dislike", "Ｊａｚｚ", "uuid-a"));
    expect(await store.explicitLikes()).toEqual([]);
    expect(durable.read()?.records.jazz?.sequence).toBe(2);
  });

  it("keeps exact latest state when semantic tombstones are absent from top-K", async () => {
    const durable = persistence();
    const memory = {
      recall: vi.fn(async () => ({
        facts: ["old like: jazz"],
        episodes: [{ content: "old like: jazz", role: "user" as const }],
      })),
      save: vi.fn(async () => undefined),
    };
    const first = makeRadioDjPreferenceStore({ persistence: durable, memory });
    await first.handoff(signal("like", "Jazz", "r1"));
    await first.handoff(signal("forget", "Jazz", "r2"));

    const restarted = makeRadioDjPreferenceStore({ persistence: durable, memory });
    expect(await restarted.explicitLikes()).toEqual([]);
    expect(memory.recall).not.toHaveBeenCalled();
  });

  it("recovers every index and memory outbox failure boundary", async () => {
    const durable = persistence();
    const memory = {
      recall: vi.fn(),
      save: vi.fn()
        .mockRejectedValueOnce(new Error("memory unavailable"))
        .mockResolvedValue(undefined),
    };
    const first = makeRadioDjPreferenceStore({ persistence: durable, memory });
    await first.handoff(signal("like", "ambient", "r1"));
    expect(durable.read()?.outbox).toHaveLength(1);

    const restarted = makeRadioDjPreferenceStore({ persistence: durable, memory });
    await restarted.flushOutbox();
    expect(durable.read()?.outbox).toEqual([]);
    expect(memory.save).toHaveBeenCalledTimes(2);
  });

  it("retries cleanup with the same sink idempotency key", async () => {
    const durable = persistence();
    const memory = {
      recall: vi.fn(),
      save: vi.fn(async (
        _user: string,
        _assistant: string,
        _opts?: { idempotencyKey?: string },
      ) => undefined),
    };
    const store = makeRadioDjPreferenceStore({ persistence: durable, memory });
    durable.failCommit(2);
    await store.handoff(signal("like", "ambient", "retry-id"));
    expect(durable.read()?.outbox).toHaveLength(1);
    durable.failCommit(-1);
    const restarted = makeRadioDjPreferenceStore({ persistence: durable, memory });
    await restarted.flushOutbox();
    const retryPayloads = memory.save.mock.calls.map(([user]) => user);
    expect(retryPayloads.filter((value) => String(value).includes("retry-id"))).toHaveLength(2);
    expect(retryPayloads.at(-1)).toBe(retryPayloads.at(-2));
    expect(memory.save.mock.calls.at(-1)?.[2]).toEqual(
      memory.save.mock.calls.at(-2)?.[2],
    );
    expect((await restarted.document()).outbox).toEqual([]);
  });

  it("does not resurrect a preference when an old request is replayed", async () => {
    const durable = persistence();
    const store = makeRadioDjPreferenceStore({ persistence: durable });
    await store.handoff(signal("like", "jazz", "r1"));
    await store.handoff(signal("dislike", "jazz", "r2"));
    await store.handoff(signal("like", "jazz", "r1"));
    expect(await store.explicitLikes()).toEqual([]);
    expect((await store.document()).nextSequence).toBe(3);
  });

  it("quarantines malformed records and outbox entries on load", async () => {
    const malformed = {
      version: 1,
      nextSequence: 2,
      records: { jazz: null },
      outbox: [null],
      processedRequests: {},
    } as unknown as RadioDjPreferenceDocument;
    const durable = persistence(malformed);
    const memory = { recall: vi.fn(), save: vi.fn() };
    const store = makeRadioDjPreferenceStore({ persistence: durable, memory });
    expect(await store.explicitLikes()).toEqual([]);
    await expect(store.flushOutbox()).resolves.toBeUndefined();
    expect(memory.save).not.toHaveBeenCalled();
  });

  it("quarantines an unsafe dedup sequence without resetting valid preferences", async () => {
    const valid = {
      ...signal("like", "jazz", "r1"),
      schema: "naia.dj.preference.v1" as const,
      idempotencyKey: "1:r1",
      subjectKey: "jazz",
      sequence: 1,
    };
    const damaged = {
      version: 1,
      nextSequence: 2,
      records: { jazz: valid },
      outbox: [],
      processedRequests: { bad: Number.MAX_SAFE_INTEGER },
    } as RadioDjPreferenceDocument;
    const durable = persistence(damaged);
    const store = makeRadioDjPreferenceStore({ persistence: durable });
    expect(await store.explicitLikes()).toEqual(["jazz"]);
    expect((await store.document()).nextSequence).toBe(2);
  });

  it("repairs unsafe next/record/outbox sequences without resetting valid preferences", async () => {
    const valid = {
      ...signal("like", "jazz", "r1"),
      schema: "naia.dj.preference.v1" as const,
      idempotencyKey: "1:r1",
      subjectKey: "jazz",
      sequence: 1,
    };
    const unsafe = {
      ...valid,
      subject: "unsafe",
      subjectKey: "unsafe",
      sequence: Number.MAX_SAFE_INTEGER,
    };
    const damaged = {
      version: 1,
      nextSequence: Number.MAX_SAFE_INTEGER,
      records: { jazz: valid, unsafe },
      outbox: [unsafe],
      processedRequests: {},
    } as RadioDjPreferenceDocument;
    const store = makeRadioDjPreferenceStore({ persistence: persistence(damaged) });
    expect(await store.explicitLikes()).toEqual(["jazz"]);
    expect((await store.document()).outbox).toEqual([]);
    expect((await store.document()).nextSequence).toBe(2);
  });

  it("keeps active state unchanged when the atomic index+outbox commit fails", async () => {
    const durable = persistence();
    durable.failCommit(1);
    const memory = { recall: vi.fn(), save: vi.fn() };
    const store = makeRadioDjPreferenceStore({ persistence: durable, memory });
    await expect(store.handoff(signal("like", "jazz", "r1"))).rejects.toThrow("injected");
    expect(await store.explicitLikes()).toEqual([]);
    expect(memory.save).not.toHaveBeenCalled();
  });

  it("reopens the serialized index, tombstone and pending outbox from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "naia-dj-index-"));
    const path = join(dir, "preferences.json");
    try {
      const memory = {
        recall: vi.fn(),
        save: vi.fn().mockRejectedValue(new Error("offline")),
      };
      const first = makeRadioDjPreferenceStore({
        persistence: makeFileRadioDjPreferencePersistence(path),
        memory,
      });
      await first.handoff(signal("like", "jazz", "r1"));
      await first.handoff(signal("forget", "jazz", "r2"));

      const restarted = makeRadioDjPreferenceStore({
        persistence: makeFileRadioDjPreferencePersistence(path),
        memory: { recall: vi.fn(), save: vi.fn(async () => undefined) },
      });
      expect(await restarted.explicitLikes()).toEqual([]);
      expect((await restarted.document()).records.jazz?.sequence).toBe(2);
      expect((await restarted.document()).outbox).toHaveLength(2);
      await restarted.flushOutbox();
      expect((await restarted.document()).outbox).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
