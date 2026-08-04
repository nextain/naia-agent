import { describe, expect, it } from "vitest";
import { makeActivityRadioDjBgm, type ActivityRadioDjBgmAdapter } from "../main/adapters/activity-radio-dj-bgm.js";
import { makeActivityRouteRegistry, makeActivitySpeechEgress } from "../main/adapters/activity-speech-egress.js";
import { PersonalRadioDjController, type ProactiveScheduler } from "../main/app/personal-radio-dj-controller.js";
import type { AgentEmit } from "../main/domain/chat.js";

class Scheduler implements ProactiveScheduler {
  nowMs = Date.parse("2026-08-04T12:00:00.000Z");
  private jobs: Array<{ at: number; run: () => void | Promise<void>; cancelled: boolean }> = [];
  now(): number { return this.nowMs; }
  schedule(delayMs: number, run: () => void | Promise<void>): () => void {
    const job = { at: this.nowMs + delayMs, run, cancelled: false };
    this.jobs.push(job);
    return () => { job.cancelled = true; };
  }
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.jobs.filter((job) => !job.cancelled && job.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) { this.nowMs = target; return; }
      this.nowMs = due.at;
      due.cancelled = true;
      await due.run();
    }
  }
}

describe("Radio DJ Agent↔Shell handoff integration", () => {
  it("observed ended → transition speech → fresh mode=radio_dj play → observed playing", async () => {
    const scheduler = new Scheduler();
    const routes = makeActivityRouteRegistry();
    const timeline: Array<{ kind: string; text?: string; action?: string; mode?: string }> = [];
    let bgm!: ActivityRadioDjBgmAdapter;
    let statusCalls = 0;
    let playCalls = 0;
    const wire = {
      emit: (_sessionId: string, requestId: string, activityId: string, _generation: number, event: AgentEmit) => {
        if (event.kind === "text") {
          timeline.push({ kind: "text", text: event.text });
          return;
        }
        if (event.kind !== "panelToolCall") return;
        const args = event.args as { action?: string; mode?: string };
        timeline.push({ kind: "panel", action: args.action, ...(args.mode ? { mode: args.mode } : {}) });
        queueMicrotask(() => {
          if (args.action === "status") {
            statusCalls++;
            const status = statusCalls === 1
              ? { playbackId: "p1", sequence: 2, status: "playing" }
              : statusCalls === 4
                ? { playbackId: "p2", sequence: 5, status: "playing" }
                : { playbackId: "p1", sequence: statusCalls, status: "ended" };
            bgm.resolveResult(requestId, activityId, event.toolCallId, JSON.stringify({
              ok: true,
              action: "status",
              playback: status,
              currentTrack: status.status === "playing"
                ? { videoId: status.playbackId === "p1" ? "v1" : "v2", title: status.playbackId === "p1" ? "첫 곡" : "다음 곡" }
                : null,
              recentTracks: [{ videoId: "v1", title: "첫 곡" }],
              favoriteTracks: [{ videoId: "fav", title: "즐겨찾기 곡" }],
              announceTrack: status.status === "playing",
            }), true);
            return;
          }
          if (args.action === "play") {
            playCalls++;
            bgm.resolveResult(requestId, activityId, event.toolCallId, JSON.stringify({
              ok: true,
              action: "play",
              selected: { videoId: playCalls === 1 ? "v1" : "v2", title: playCalls === 1 ? "첫 곡" : "다음 곡" },
              playback: { playbackId: playCalls === 1 ? "p1" : "p2", sequence: playCalls, status: "requested" },
              announceTrack: false,
            }), true);
          }
        });
      },
    };
    bgm = makeActivityRadioDjBgm({
      routes,
      wire,
      specs: () => [{
        name: "skill_youtube_bgm",
        description: "BGM",
        parameters: { type: "object", properties: { action: { enum: ["play", "status", "stop"] } } },
      }],
      wait: async () => undefined,
      now: () => scheduler.now(),
    });
    const controller = new PersonalRadioDjController({
      scheduler,
      ids: { next: () => "activity-414" },
      context: { snapshot: async () => ({
        localTime: { iso: new Date(scheduler.now()).toISOString(), timezone: "UTC", source: "configured" },
        preferences: [{ text: "재즈", source: "user-memory", confidence: "explicit" }],
      }) },
      selector: { select: async (snapshot) => ({
        query: snapshot.favoriteTracks?.length ? "재즈 즐겨찾기 다음 곡" : "재즈 첫 곡",
        reason: "preference",
      }) },
      bgm,
      speech: makeActivitySpeechEgress(wire, routes),
      preferences: { handoff: async () => undefined },
    });
    controller.configure({
      sessionId: "agent:main:main",
      idleMs: 1,
      djIntervalMs: 1,
      timezone: "UTC",
      bgmAutoPlayOptIn: true,
    });
    controller.setSubscriberReady(true);

    await scheduler.advance(1);
    expect(controller.state()).toBe("dj_speaking");
    await scheduler.advance(1);
    expect(controller.state()).toBe("dj_speaking");

    const secondPlayIndex = timeline.findIndex((entry, index) => index > 0 && entry.kind === "panel" && entry.action === "play" && entry.mode === "radio_dj" && timeline.slice(0, index).some((prior) => prior.action === "play"));
    const transitionIndex = timeline.findIndex((entry) => entry.text?.includes("한 곡이 마무리됐어요"));
    expect(transitionIndex).toBeGreaterThan(-1);
    expect(secondPlayIndex).toBeGreaterThan(transitionIndex);
    expect(timeline.filter((entry) => entry.kind === "panel" && entry.action === "play")).toHaveLength(2);
    expect(timeline.filter((entry) => entry.kind === "panel" && entry.action === "play").every((entry) => entry.mode === "radio_dj")).toBe(true);
    expect(timeline.at(-1)?.text).toContain("다음 곡");
  });
});
