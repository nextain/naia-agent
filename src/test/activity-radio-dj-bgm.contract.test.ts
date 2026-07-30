import { describe, expect, it, vi } from "vitest";
import { makeActivityRadioDjBgm } from "../main/adapters/activity-radio-dj-bgm.js";
import { makeActivityRouteRegistry } from "../main/adapters/activity-speech-egress.js";

describe("DJ-GRPC-01 activity panel BGM correlation", () => {
  it("Shell의 requested receipt 뒤 status=playing 관측이 와야만 성공한다", async () => {
    const routes = makeActivityRouteRegistry();
    routes.set({
      sessionId: "s1",
      requestId: "radio-dj:a1",
      activityId: "a1",
      profileGeneration: 1,
    });
    const emitted: { requestId: string; activityId: string; event: unknown }[] = [];
    const bgm = makeActivityRadioDjBgm({
      routes,
      wire: {
        emit: (_sessionId, requestId, activityId, _generation, event) => {
          emitted.push({ requestId, activityId, event });
        },
      },
      specs: () => [{
        name: "skill_youtube_bgm",
        description: "bgm",
        parameters: {
          type: "object",
          properties: { action: { enum: ["play", "status", "next", "stop"] } },
        },
      }],
      timeoutMs: 1_000,
    });

    const play = bgm.searchAndPlay("저녁 재즈", { requestId: "radio-dj:a1", activityId: "a1" });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      requestId: "radio-dj:a1",
      activityId: "a1",
      event: {
        kind: "panelToolCall",
        toolName: "skill_youtube_bgm",
        args: { action: "play", query: "저녁 재즈" },
      },
    });
    const toolCallId = (emitted[0]!.event as { toolCallId: string }).toolCallId;
    bgm.resolveResult(
      "radio-dj:a1",
      "a1",
      toolCallId,
      JSON.stringify({
        ok: true,
        action: "play",
        commandId: "bgm-command-1",
        playback: { playbackId: "bgm-playback-1", sequence: 1, status: "requested", updatedAt: 1_000, freshUntil: 6_000 },
        selected: { videoId: "v1", title: "긴 재즈 믹스" },
        announceTrack: false,
      }),
      true,
    );
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    const statusCall = emitted[1]!.event as { toolCallId: string; args: { action: string } };
    expect(statusCall.args.action).toBe("status");
    bgm.resolveResult(
      "radio-dj:a1",
      "a1",
      statusCall.toolCallId,
      JSON.stringify({
        ok: true,
        action: "status",
        playback: {
          playbackId: "bgm-playback-1",
          sequence: 2,
          status: "playing",
          updatedAt: 1_100,
          freshUntil: Date.now() + 5_000,
        },
        currentTrack: { videoId: "v1", title: "긴 재즈 믹스" },
        announceTrack: true,
      }),
      true,
    );
    await expect(play).resolves.toEqual({ ok: true, videoId: "v1", title: "긴 재즈 믹스" });
    const endedStatus = bgm.status();
    await vi.waitFor(() => expect(emitted).toHaveLength(3));
    const endedCall = emitted[2]!.event as { toolCallId: string };
    bgm.resolveResult(
      "radio-dj:a1",
      "a1",
      endedCall.toolCallId,
      JSON.stringify({
        ok: true,
        action: "status",
        playback: { playbackId: "bgm-playback-1", sequence: 3, status: "ended" },
        currentTrack: null,
        announceTrack: false,
      }),
      true,
    );
    await expect(endedStatus).resolves.toMatchObject({ status: "ended", playbackId: "bgm-playback-1" });
  });

  it.each([undefined, "other"])("plain text/누락·다른 activity(%s) result는 성공으로 파싱하지 않는다", async (activityId) => {
    const routes = makeActivityRouteRegistry();
    routes.set({ sessionId: "s", requestId: "r", activityId: "a", profileGeneration: 1 });
    let toolCallId = "";
    const bgm = makeActivityRadioDjBgm({
      routes,
      wire: {
        emit: (_s, _r, _a, _g, event) => {
          toolCallId = event.kind === "panelToolCall" ? event.toolCallId : "";
        },
      },
      specs: () => [{ name: "skill_youtube_bgm", description: "", parameters: {} }],
    });
    const play = bgm.searchAndPlay("x", { requestId: "r", activityId: "a" });
    bgm.resolveResult("r", activityId, toolCallId, "재생: 제목", true);
    await expect(play).resolves.toMatchObject({ ok: false });
  });


  it("DJ-GRPC-02: 구형 top-level 재생 결과와 action 불일치를 성공으로 인정하지 않는다", async () => {
    const routes = makeActivityRouteRegistry();
    routes.set({ sessionId: "s", requestId: "r", activityId: "a", profileGeneration: 1 });
    const calls: { toolCallId: string; action: string }[] = [];
    const bgm = makeActivityRadioDjBgm({
      routes,
      wire: {
        emit: (_s, _r, _a, _g, event) => {
          if (event.kind === "panelToolCall") calls.push({
            toolCallId: event.toolCallId,
            action: String((event.args as { action?: unknown }).action),
          });
        },
      },
      specs: () => [{
        name: "skill_youtube_bgm",
        description: "",
        parameters: { type: "object", properties: { action: { enum: ["play", "status", "next", "stop"] } } },
      }],
    });

    const stale = bgm.searchAndPlay("첫 곡", { requestId: "r", activityId: "a" });
    bgm.resolveResult("r", "a", calls[0]!.toolCallId, JSON.stringify({
      ok: true, action: "play", videoId: "v1", title: "첫 영상",
    }), true);
    await expect(stale).resolves.toEqual({ ok: false, reason: "invalid BGM play receipt" });

  });
  it("DJ-GRPC-03: 목표 playbackId 없는 Shell next는 radio에서 사용하지 않는다", async () => {
    const routes = makeActivityRouteRegistry();
    routes.set({ sessionId: "s", requestId: "r", activityId: "a", profileGeneration: 1 });
    let emitted = 0;
    const bgm = makeActivityRadioDjBgm({
      routes,
      wire: { emit: () => { emitted++; } },
      specs: () => [{
        name: "skill_youtube_bgm",
        description: "",
        parameters: { type: "object", properties: { action: { enum: ["play", "status", "next", "stop"] } } },
      }],
    });

    expect(bgm.capabilities().next).toBe(false);
    await expect(bgm.next({ requestId: "r", activityId: "a" })).resolves.toEqual({
      ok: false,
      reason: "uncorrelated_next_receipt",
    });
    expect(emitted).toBe(0);
  });
});
