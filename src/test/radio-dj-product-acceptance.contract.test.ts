import { describe, expect, it, vi } from "vitest";
import {
  makeRadioDjContext,
  makeRadioDjPreferenceStore,
  makeDeterministicRadioDjSelector,
} from "../main/adapters/radio-dj-runtime.js";

describe("radio DJ product acceptance", () => {
  it("uses weather only when its observation is valid and at most 60 minutes old", async () => {
    const config = {
      sessionId: "s1",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
      weatherLocation: { latitude: 37.5, longitude: 127, consented: true as const },
    };
    const snapshot = async (observedAt: string) => makeRadioDjContext({
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      explicitLikes: () => [],
      fetchWeather: vi.fn(async () => ({ code: 1, tempC: 25, observedAt })),
    }).snapshot(config);
    expect((await snapshot("2026-07-20T11:00:00.000Z")).weather).toBeDefined();
    expect((await snapshot("2026-07-20T10:59:59.999Z")).weather).toBeUndefined();
    expect((await snapshot("2026-07-20T12:00:00.001Z")).weather).toBeUndefined();
    expect((await snapshot("invalid")).weather).toBeUndefined();
    const malformed = await makeRadioDjContext({
      now: () => new Date("2026-07-20T12:00:00.000Z"),
      explicitLikes: () => [],
      fetchWeather: vi.fn(async () => ({
        code: Number.NaN,
        tempC: Number.NaN,
        observedAt: "2026-07-20T12:00:00.000Z",
      })),
    }).snapshot(config);
    expect(malformed.weather).toBeUndefined();
  });

  it("PA-DJ-02 keeps explicit mood session-bound and fresh for six hours", async () => {
    const store = makeRadioDjPreferenceStore();
    store.recordMood({
      sessionId: "s1",
      quote: "집중해서 문서를 쓰는 중",
      statedAt: "2026-07-20T00:00:00.000Z",
    });
    const context = makeRadioDjContext({
      now: () => new Date("2026-07-20T05:59:59.000Z"),
      explicitLikes: () => store.explicitLikes(),
      explicitMood: (sessionId) => store.explicitMood(sessionId),
    });
    const fresh = await context.snapshot({
      sessionId: "s1",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
    });
    expect(fresh.moodActivity?.quote).toBe("집중해서 문서를 쓰는 중");

    const boundaryContext = makeRadioDjContext({
      now: () => new Date("2026-07-20T06:00:00.000Z"),
      explicitLikes: () => store.explicitLikes(),
      explicitMood: (sessionId) => store.explicitMood(sessionId),
    });
    const boundary = await boundaryContext.snapshot({
      sessionId: "s1",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
    });
    expect(boundary.moodActivity).toBeDefined();

    const expiredContext = makeRadioDjContext({
      now: () => new Date("2026-07-20T06:00:00.001Z"),
      explicitLikes: () => store.explicitLikes(),
      explicitMood: (sessionId) => store.explicitMood(sessionId),
    });
    expect((await expiredContext.snapshot({
      sessionId: "s1",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
    })).moodActivity).toBeUndefined();

    store.recordMood({
      sessionId: "future",
      quote: "미래 입력",
      statedAt: "2026-07-21T00:00:00.000Z",
    });
    expect((await context.snapshot({
      sessionId: "future",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
    })).moodActivity).toBeUndefined();

    store.recordMood({ sessionId: "s1", quote: "", statedAt: "not-a-date" });
    expect((await context.snapshot({
      sessionId: "s1",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
    })).moodActivity?.quote).toBe("집중해서 문서를 쓰는 중");

    const other = await context.snapshot({
      sessionId: "s2",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
    });
    expect(other.moodActivity).toBeUndefined();

    const selected = await makeDeterministicRadioDjSelector().select(fresh);
    expect(selected.reason).toBe("mood");
    expect(selected.query).toContain("집중해서 문서를 쓰는 중");
  });

  it("PA-DJ-01 persists, recalls, overrides and forgets only explicit preferences", async () => {
    const memory = { recall: vi.fn(), save: vi.fn(async () => undefined) };
    const store = makeRadioDjPreferenceStore({ memory });
    await store.handoff({
      sentiment: "like",
      subject: "재즈",
      sessionId: "s1",
      requestId: "r1",
      statedAt: "2026-07-20T00:00:00.000Z",
      source: "explicit_user_turn",
    });
    expect(await store.explicitLikes()).toEqual(["재즈"]);
    expect(memory.save).toHaveBeenCalledTimes(1);
    await store.handoff({
      sentiment: "dislike",
      subject: "  재즈 ",
      sessionId: "s1",
      requestId: "r2",
      statedAt: "2026-07-20T00:00:00.000Z",
      source: "explicit_user_turn",
    });
    expect(await store.explicitLikes()).toEqual([]);
    await store.handoff({
      sentiment: "like",
      subject: "ＡＭＢＩＥＮＴ",
      sessionId: "s1",
      requestId: "r3",
      statedAt: "2026-07-20T00:00:00.000Z",
      source: "explicit_user_turn",
    });
    expect(await store.explicitLikes()).toEqual(["ＡＭＢＩＥＮＴ"]);
    await store.handoff({
      sentiment: "forget",
      subject: "ambient",
      sessionId: "s1",
      requestId: "r4",
      statedAt: "2026-07-20T00:00:00.000Z",
      source: "explicit_user_turn",
    });
    expect(await store.explicitLikes()).toEqual([]);
  });

  it("PA-DJ-01 recalls tagged explicit memory without resurrecting a local tombstone and combines a fresh favorite", async () => {
    const record = (
      sentiment: "like" | "dislike" | "forget",
      subject: string,
      subjectKey: string,
      sequence: number,
    ) => `[NAIA_DJ_PREFERENCE_V1] ${JSON.stringify({
      schema: "naia.dj.preference.v1",
      sentiment,
      subject,
      subjectKey,
      sequence,
      sessionId: "old-session",
      requestId: `old-${sequence}`,
      statedAt: `2026-07-1${sequence}T00:00:00.000Z`,
      source: "explicit_user_turn",
      idempotencyKey: `${sequence}:old-${sequence}`,
    })}`;
    const memory = {
      recall: vi.fn(async () => ({
        facts: [record("like", "출처 불명 팝", "pop", 9)],
        episodes: [
          { role: "user" as const, content: record("like", "재즈", "재즈", 1) },
          { role: "user" as const, content: record("like", "앰비언트", "앰비언트", 2) },
          { role: "assistant" as const, content: record("like", "모델 추측 록", "록", 3) },
        ],
      })),
      save: vi.fn(async () => undefined),
    };
    const store = makeRadioDjPreferenceStore({ memory });
    await store.handoff({
      sentiment: "dislike",
      subject: "재즈",
      sessionId: "s1",
      requestId: "local-tombstone",
      statedAt: "2026-07-20T00:00:00.000Z",
      source: "explicit_user_turn",
    });

    expect(await store.activeExplicitLikes()).toEqual(["앰비언트"]);
    const snapshot = await makeRadioDjContext({
      now: () => new Date("2026-07-20T18:00:00.000Z"),
      explicitLikes: () => store.activeExplicitLikes(),
    }).snapshot({
      sessionId: "s1",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
    });
    const selected = await makeDeterministicRadioDjSelector().select({
      ...snapshot,
      recentTracks: [{ videoId: "recent", title: "Favorite One" }],
      favoriteTracks: [
        { videoId: "recent", title: "Favorite One" },
        { videoId: "fresh", title: "Favorite Two" },
      ],
    });
    expect(selected.reason).toBe("preference");
    expect(selected.query).toContain("앰비언트");
    expect(selected.query).toContain("Favorite Two");
    expect(selected.query).not.toContain("Favorite One");
    expect(memory.recall).toHaveBeenCalledWith(
      "NAIA_DJ_PREFERENCE_V1 explicit music preference",
    );
  });
});
