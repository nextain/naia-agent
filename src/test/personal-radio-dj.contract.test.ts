import { describe, expect, it, vi } from "vitest";
import {
  PersonalRadioDjController,
  type DjContextSnapshot,
  type ProactiveScheduler,
  type RadioDjBgmPort,
} from "../main/app/personal-radio-dj-controller.js";

class ManualScheduler implements ProactiveScheduler {
  nowMs = Date.parse("2026-07-18T12:00:00+09:00");
  private jobs: { at: number; run: () => void | Promise<void>; cancelled: boolean }[] = [];
  now(): number { return this.nowMs; }
  schedule(delayMs: number, run: () => void | Promise<void>): () => void {
    const job = { at: this.nowMs + delayMs, run, cancelled: false };
    this.jobs.push(job);
    return () => { job.cancelled = true; };
  }
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.jobs
        .filter((j) => !j.cancelled && j.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) {
        this.nowMs = target;
        return;
      }
      this.nowMs = due.at;
      due.cancelled = true;
      await due.run();
    }
  }
  pendingCount(): number {
    return this.jobs.filter((job) => !job.cancelled).length;
  }
}

function harness(overrides: {
  optIn?: boolean;
  subscriberReady?: boolean;
  bgmReady?: boolean;
  playOk?: boolean;
  snapshot?: DjContextSnapshot;
  selectorReason?: "time" | "weather" | "mood" | "preference" | "generic";
  lease?: { durationMs: number; maxUtterances: number };
  djIntervalMs?: number;
  currentBgm?: { videoId: string; title: string };
  nextResult?:
    | { ok: true; videoId: string; title: string }
    | { ok: false; reason: string };
} = {}) {
  const scheduler = new ManualScheduler();
  const spoken: string[] = [];
  const bgmCalls: string[] = [];
  const preferenceHandoffs: {
    sentiment: "like" | "dislike";
    subject: string;
    sessionId: string;
    requestId: string;
    statedAt: string;
    source: "explicit_user_turn";
  }[] = [];
  const selectedSnapshots: DjContextSnapshot[] = [];
  const bgm: RadioDjBgmPort = {
    capabilities: () => ({ ready: overrides.bgmReady ?? true, next: overrides.nextResult !== undefined }),
    searchAndPlay: vi.fn(async (query) => {
      bgmCalls.push(`play:${query}`);
      return overrides.playOk === false
        ? { ok: false as const, reason: "not found" }
        : { ok: true as const, videoId: "v1", title: "집중할 때 듣는 긴 재즈 믹스" };
    }),
    next: vi.fn(async () => overrides.nextResult ?? ({ ok: false as const, reason: "unsupported" })),
    stop: vi.fn(async () => { bgmCalls.push("stop"); return { ok: true }; }),
    status: vi.fn(async () => overrides.currentBgm),
  };
  const controller = new PersonalRadioDjController({
    scheduler,
    ids: { next: () => "activity-dj-1" },
    context: {
      snapshot: vi.fn(async () => overrides.snapshot ?? ({
        localTime: { iso: new Date(scheduler.now()).toISOString(), timezone: "Asia/Seoul", source: "configured" },
        preferences: [{ text: "재즈를 좋아함", source: "user-memory", confidence: "explicit" }],
      } satisfies DjContextSnapshot)),
    },
    selector: {
      select: vi.fn(async (snapshot) => {
        selectedSnapshots.push(snapshot);
        return { query: "저녁 집중 재즈 믹스", reason: overrides.selectorReason ?? "preference" };
      }),
    },
    bgm,
    speech: {
      open: vi.fn(),
      speak: vi.fn(async ({ text }) => { spoken.push(text); return "completed" as const; }),
      interrupt: vi.fn(),
      close: vi.fn(),
    },
    preferences: {
      handoff: vi.fn(async (signal) => { preferenceHandoffs.push(signal); }),
    },
    ...(overrides.lease ? { lease: overrides.lease } : {}),
  });
  controller.configure({
    sessionId: "agent:main:main",
    idleMs: 1_000,
    djIntervalMs: overrides.djIntervalMs ?? 500,
    timezone: "Asia/Seoul",
    bgmAutoPlayOptIn: overrides.optIn ?? true,
  });
  controller.setSubscriberReady(overrides.subscriberReady ?? true);
  return { controller, scheduler, spoken, bgmCalls, preferenceHandoffs, selectedSnapshots, bgm };
}

describe("personal radio DJ MVP contract", () => {
  it("DJ-01: opt-in+subscriber+BGM ready 뒤 idle에서 한 번 시작하고 미준비면 시작하지 않는다", async () => {
    const ready = harness();
    await ready.scheduler.advance(999);
    expect(ready.bgmCalls).toEqual([]);
    await ready.scheduler.advance(1);
    expect(ready.bgmCalls).toEqual(["play:저녁 집중 재즈 믹스"]);

    for (const blocked of [
      harness({ optIn: false }),
      harness({ subscriberReady: false }),
      harness({ bgmReady: false }),
    ]) {
      await blocked.scheduler.advance(10_000);
      expect(blocked.bgmCalls).toEqual([]);
    }
  });

  it("DJ-02/03/04: stale context를 제거하고 BGM 성공 뒤 영상 제목만 재생 소개한다", async () => {
    const h = harness({
      snapshot: {
        localTime: { iso: "2026-07-18T03:00:00.000Z", timezone: "Asia/Seoul", source: "configured" },
        weather: { code: 1, tempC: 28, observedAt: "2026-07-18T00:00:00.000Z", source: "open-meteo" },
        moodActivity: { quote: "지금 집중하고 싶어", sessionId: "other-session", statedAt: "2026-07-18T02:59:00.000Z" },
        preferences: [],
      },
    });
    await h.scheduler.advance(1_000);
    expect(h.spoken.join(" ")).toContain("집중할 때 듣는 긴 재즈 믹스");
    expect(h.spoken.join(" ")).not.toContain("28");
    expect(h.spoken.join(" ")).not.toContain("지금 집중하고 싶어");
    expect(h.spoken.join(" ")).not.toMatch(/현재 곡|지금 나오는 곡/);
    expect(h.selectedSnapshots[0]?.weather).toBeUndefined();
    expect(h.selectedSnapshots[0]?.moodActivity).toBeUndefined();

    const failed = harness({ playOk: false });
    await failed.scheduler.advance(1_000);
    expect(failed.spoken.join(" ")).not.toContain("재생 중");
  });

  it("DJ-05/06: DJ 멘트 뒤 music-only는 BGM을 유지하고 stop은 발화와 BGM을 끝낸다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(500);
    await h.scheduler.advance(500);
    expect(h.spoken.slice(1)).toHaveLength(2);
    expect(new Set(h.spoken.slice(1)).size).toBe(2);

    await h.controller.control({ kind: "music_only" });
    const count = h.spoken.length;
    await h.scheduler.advance(5_000);
    expect(h.spoken).toHaveLength(count);
    expect(h.bgmCalls).not.toContain("stop");

    await h.controller.control({ kind: "stop" });
    expect(h.bgmCalls).toContain("stop");
    await h.scheduler.advance(60_000);
    expect(h.spoken).toHaveLength(count);
  });

  it("PA-DJ-03 emits eight grounded non-repeating remarks", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(4_000);
    const remarks = h.spoken.slice(1);
    expect(remarks).toHaveLength(8);
    expect(new Set(remarks).size).toBe(8);
    expect(remarks).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/현재 곡|트랙명|기온|습도/),
    ]));
    for (let index = 6; index < remarks.length; index++) {
      expect(remarks.slice(index - 6, index)).not.toContain(remarks[index]);
    }
  });

  it("DJ-06: talk-less/change-vibe/next fallback이 닫힌 BGM 경로만 사용한다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    await h.controller.control({ kind: "talk_less" });
    await h.controller.control({ kind: "talk_more" });
    const before = h.bgmCalls.length;
    await h.controller.control({ kind: "change_vibe" });
    await h.controller.control({ kind: "next" });
    expect(h.bgmCalls.slice(before)).toEqual([
      "play:저녁 집중 재즈 믹스",
      "play:저녁 집중 재즈 믹스",
    ]);
  });

  it("DJ-06: next는 player가 확인한 다른 영상 제목만 말하고, 중복 결과는 새 선곡으로 되돌린다", async () => {
    const changed = harness({
      currentBgm: { videoId: "v1", title: "처음 영상" },
      nextResult: { ok: true, videoId: "v2", title: "확인된 다음 영상" },
    });
    await changed.scheduler.advance(1_000);
    await changed.controller.control({ kind: "next" });
    expect(changed.spoken.at(-1)).toContain("확인된 다음 영상");

    const duplicate = harness({
      currentBgm: { videoId: "v1", title: "처음 영상" },
      nextResult: { ok: true, videoId: "v1", title: "말하면 안 되는 중복 제목" },
    });
    await duplicate.scheduler.advance(1_000);
    const playsBefore = duplicate.bgmCalls.filter((call) => call.startsWith("play:")).length;
    await duplicate.controller.control({ kind: "next" });
    expect(duplicate.spoken.join(" ")).not.toContain("말하면 안 되는 중복 제목");
    expect(duplicate.bgmCalls.filter((call) => call.startsWith("play:")).length).toBe(playsBefore + 1);
  });

  it("DJ-06: 사용자가 계속 이야기하라고 하면 music-only에서 DJ 멘트를 재개한다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    await h.controller.control({ kind: "music_only" });
    const count = h.spoken.length;
    await h.controller.control({ kind: "talk_more" });
    await h.scheduler.advance(500);
    expect(h.spoken.length).toBeGreaterThan(count);
  });

  it("DJ-07: lease 두 번을 갱신해도 controller/BGM은 하나이며 명시적 좋아요만 provenance handoff한다", async () => {
    const h = harness({ lease: { durationMs: 1_000, maxUtterances: 2 } });
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(4_000);
    expect(h.controller.stats().leaseRenewals).toBeGreaterThanOrEqual(2);
    expect(h.controller.stats().controllerStarts).toBe(1);
    expect(h.bgmCalls.filter((c) => c.startsWith("play:"))).toHaveLength(1);
    expect(h.preferenceHandoffs).toEqual([]);
    await h.controller.recordExplicitPreference("like", "집중 재즈", {
      requestId: "ordinary-turn-1",
      statedAt: "2026-07-18T03:00:00.000Z",
    });
    expect(h.preferenceHandoffs).toEqual([{
      sentiment: "like",
      subject: "집중 재즈",
      sessionId: "agent:main:main",
      requestId: "ordinary-turn-1",
      statedAt: "2026-07-18T03:00:00.000Z",
      source: "explicit_user_turn",
    }]);
  });

  it("DJ-07: music-only에서도 독립 시간 lease를 계속 갱신한다", async () => {
    const h = harness({ lease: { durationMs: 1_000, maxUtterances: 60 } });
    await h.scheduler.advance(1_000);
    await h.controller.control({ kind: "music_only" });
    await h.scheduler.advance(2_100);
    expect(h.controller.stats().leaseRenewals).toBeGreaterThanOrEqual(2);
    expect(h.controller.state()).toBe("music_only");
    expect(h.bgmCalls).not.toContain("stop");
  });

  it("PA-DJ-06 survives an eight-hour bounded lease soak and terminal stop", async () => {
    const thirtyMinutes = 30 * 60 * 1_000;
    const h = harness({
      djIntervalMs: thirtyMinutes,
      lease: { durationMs: thirtyMinutes, maxUtterances: 1_000_000 },
    });
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(8 * 60 * 60 * 1_000);
    expect(h.controller.stats().leaseRenewals).toBeGreaterThanOrEqual(16);
    expect(h.controller.stats().controllerStarts).toBe(1);
    expect(h.bgmCalls.filter((call) => call.startsWith("play:"))).toHaveLength(1);
    expect(h.scheduler.pendingCount()).toBeLessThanOrEqual(2);

    const spokenBeforeStop = h.spoken.length;
    const playsBeforeStop = h.bgmCalls.filter((call) => call.startsWith("play:")).length;
    await h.controller.control({ kind: "stop" });
    await h.scheduler.advance(thirtyMinutes);
    expect(h.spoken).toHaveLength(spokenBeforeStop);
    expect(h.bgmCalls.filter((call) => call.startsWith("play:"))).toHaveLength(playsBeforeStop);
    expect(h.scheduler.pendingCount()).toBe(0);
    expect(h.controller.state()).toBe("stopped");
  });

  it("DJ-06 race: stop 중 늦은 play 성공은 보상 stop되고 발화가 되살아나지 않는다", async () => {
    let resolvePlay!: (value: { ok: true; videoId: string; title: string }) => void;
    const h = harness();
    vi.mocked(h.bgm.searchAndPlay).mockImplementationOnce(
      () => new Promise((resolve) => { resolvePlay = resolve; }),
    );
    const idle = h.scheduler.advance(1_000);
    for (let i = 0; i < 10 && !resolvePlay; i++) await Promise.resolve();
    expect(resolvePlay).toBeTypeOf("function");
    await h.controller.stop();
    resolvePlay({ ok: true, videoId: "late", title: "늦은 재생" });
    await idle;
    expect(h.bgmCalls.filter((c) => c === "stop").length).toBeGreaterThanOrEqual(2);
    expect(h.spoken.join(" ")).not.toContain("늦은 재생");
    expect(h.controller.state()).toBe("stopped");
  });

  it("DJ-05 race: change-vibe 중 music-only는 늦은 재생 소개를 무효화한다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    let resolveChange!: (value: { ok: true; videoId: string; title: string }) => void;
    vi.mocked(h.bgm.searchAndPlay).mockImplementationOnce(
      () => new Promise((resolve) => { resolveChange = resolve; }),
    );
    const change = h.controller.control({ kind: "change_vibe" });
    for (let i = 0; i < 10 && !resolveChange; i++) await Promise.resolve();
    await h.controller.control({ kind: "music_only" });
    resolveChange({ ok: true, videoId: "late-vibe", title: "늦은 분위기" });
    await change;
    expect(h.controller.state()).toBe("music_only");
    expect(h.spoken.join(" ")).not.toContain("늦은 분위기");
    expect(h.bgmCalls).not.toContain("stop");
  });

  it("DJ-05 race: music-only 직후 talk-more여도 허용한 늦은 BGM은 보상 정지하지 않는다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    let resolveChange!: (value: { ok: true; videoId: string; title: string }) => void;
    vi.mocked(h.bgm.searchAndPlay).mockImplementationOnce(
      () => new Promise((resolve) => { resolveChange = resolve; }),
    );
    const change = h.controller.control({ kind: "change_vibe" });
    for (let i = 0; i < 10 && !resolveChange; i++) await Promise.resolve();
    await h.controller.control({ kind: "music_only" });
    await h.controller.control({ kind: "talk_more" });
    resolveChange({ ok: true, videoId: "late-vibe", title: "늦은 분위기" });
    await change;
    expect(h.bgmCalls).not.toContain("stop");
    expect(h.controller.state()).toBe("dj_speaking");
  });

  it("DJ-01 lifecycle: active profile disable/subscriber loss는 TTS와 BGM을 정리한다", async () => {
    const disabled = harness();
    await disabled.scheduler.advance(1_000);
    disabled.controller.configure(undefined);
    await Promise.resolve();
    expect(disabled.controller.state()).toBe("disabled");
    expect(disabled.bgmCalls).toContain("stop");

    const disconnected = harness();
    await disconnected.scheduler.advance(1_000);
    disconnected.controller.setSubscriberReady(false);
    await Promise.resolve();
    expect(disconnected.controller.state()).toBe("idle");
    expect(disconnected.bgmCalls).toContain("stop");
  });
});
