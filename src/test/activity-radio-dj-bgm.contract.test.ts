import { describe, expect, it } from "vitest";
import { makeActivityRadioDjBgm } from "../main/adapters/activity-radio-dj-bgm.js";
import { makeActivityRouteRegistry } from "../main/adapters/activity-speech-egress.js";

describe("DJ-GRPC-01 activity panel BGM correlation", () => {
  it("activityId가 있는 structured play result 뒤에만 성공한다", async () => {
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
          properties: { action: { enum: ["play", "next", "stop"] } },
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
      JSON.stringify({ ok: true, action: "play", videoId: "v1", title: "긴 재즈 믹스" }),
      true,
    );
    await expect(play).resolves.toEqual({ ok: true, videoId: "v1", title: "긴 재즈 믹스" });
    await expect(bgm.status()).resolves.toEqual({ videoId: "v1", title: "긴 재즈 믹스" });
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

  it("DJ-GRPC-02: 요청 action과 다른 결과 또는 같은 영상은 다음 곡으로 인정하지 않는다", async () => {
    const routes = makeActivityRouteRegistry();
    routes.set({ sessionId: "s", requestId: "r", activityId: "a", profileGeneration: 1 });
    const calls: { toolCallId: string; action: string }[] = [];
    const bgm = makeActivityRadioDjBgm({
      routes,
      wire: {
        emit: (_s, _r, _a, _g, event) => {
          if (event.kind === "panelToolCall") {
            calls.push({
              toolCallId: event.toolCallId,
              action: String((event.args as { action?: unknown }).action),
            });
          }
        },
      },
      specs: () => [{
        name: "skill_youtube_bgm",
        description: "",
        parameters: { type: "object", properties: { action: { enum: ["play", "next", "stop"] } } },
      }],
    });

    const first = bgm.searchAndPlay("첫 곡", { requestId: "r", activityId: "a" });
    bgm.resolveResult("r", "a", calls[0]!.toolCallId, JSON.stringify({
      ok: true, action: "play", videoId: "v1", title: "첫 영상",
    }), true);
    await expect(first).resolves.toMatchObject({ ok: true, videoId: "v1" });

    const wrongAction = bgm.next({ requestId: "r", activityId: "a" });
    bgm.resolveResult("r", "a", calls[1]!.toolCallId, JSON.stringify({
      ok: true, action: "play", videoId: "v2", title: "다른 영상",
    }), true);
    await expect(wrongAction).resolves.toEqual({ ok: false, reason: "BGM action mismatch" });
    await expect(bgm.status()).resolves.toEqual({ videoId: "v1", title: "첫 영상" });

    const duplicate = bgm.searchAndPlay("같은 곡", { requestId: "r", activityId: "a" });
    bgm.resolveResult("r", "a", calls[2]!.toolCallId, JSON.stringify({
      ok: true, action: "play", videoId: "v1", title: "첫 영상",
    }), true);
    await expect(duplicate).resolves.toEqual({ ok: false, reason: "duplicate_track" });
    await expect(bgm.status()).resolves.toEqual({ videoId: "v1", title: "첫 영상" });
  });
});
