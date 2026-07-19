// UC8 BGM skill 테스트 — agent-local(action 라우팅 + 도메인 clamp + injected 외부dep mock). 외부 youtubei.js/player 불요.
import { describe, it, expect } from "vitest";
import { makeYoutubeBgmExecutor, clampVolume, type BgmDeps } from "../main/adapters/youtube-bgm-skills.js";
import type { ToolCall } from "../main/domain/chat.js";

const call = (args: Record<string, unknown>): ToolCall => ({ id: "1", name: "youtube_bgm", args });

function mkControl() {
  const log: string[] = [];
  const control = {
    play: async (v: string, t: string) => { log.push(`play:${v}:${t}`); },
    stop: async () => { log.push("stop"); },
    pause: async () => { log.push("pause"); },
    resume: async () => { log.push("resume"); },
    setVolume: async (v: number) => { log.push(`vol:${v}`); },
  };
  return { control, log };
}

describe("UC8 youtube_bgm skill", () => {
  it("tier=ask(환경변경 승인) + tool spec", () => {
    const ex = makeYoutubeBgmExecutor();
    const spec = ex.specs().find((s) => s.name === "youtube_bgm");
    expect(spec?.tier).toBe("ask");
    expect(spec?.processing).toMatchObject({
      workload: "network_tool",
      destination: "external_cloud",
      when: { key: "action", values: ["search"] },
    });
  });

  it("search → MusicSearch + 첫 결과 자동재생", async () => {
    const { control, log } = mkControl();
    const deps: BgmDeps = { control, search: async () => [{ videoId: "v1", title: "Lofi" }, { videoId: "v2", title: "B" }] };
    const r = await makeYoutubeBgmExecutor(deps).execute(call({ action: "search", query: "lofi" }), {});
    expect(r.isError).toBeUndefined();
    expect(log).toEqual(["play:v1:Lofi"]); // 첫 결과만 재생
  });

  it("search 미주입 → 정직 unsupported(외부 미연결)", async () => {
    const r = await makeYoutubeBgmExecutor().execute(call({ action: "search", query: "x" }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/unavailable|미주입/);
  });

  it("volume → 도메인 clamp 0..1", async () => {
    const { control, log } = mkControl();
    await makeYoutubeBgmExecutor({ control }).execute(call({ action: "volume", volume: 2.5 }), {});
    await makeYoutubeBgmExecutor({ control }).execute(call({ action: "volume", volume: -1 }), {});
    expect(log).toEqual(["vol:1", "vol:0"]); // clamp
  });
  it("clampVolume 순수: 비유한→0.5, 범위밖→clamp", () => {
    expect(clampVolume(0.3)).toBe(0.3);
    expect(clampVolume(5)).toBe(1);
    expect(clampVolume(-2)).toBe(0);
    expect(clampVolume("x")).toBe(0.5);
    expect(clampVolume(NaN)).toBe(0.5);
  });

  it("stop/pause/resume → control 위임", async () => {
    const { control, log } = mkControl();
    const ex = makeYoutubeBgmExecutor({ control });
    await ex.execute(call({ action: "stop" }), {});
    await ex.execute(call({ action: "pause" }), {});
    await ex.execute(call({ action: "resume" }), {});
    expect(log).toEqual(["stop", "pause", "resume"]);
  });

  it("unknown action / play videoId 누락 → 정직 isError", async () => {
    const { control } = mkControl();
    const ex = makeYoutubeBgmExecutor({ control });
    expect((await ex.execute(call({ action: "explode" }), {})).isError).toBe(true);
    expect((await ex.execute(call({ action: "play" }), {})).isError).toBe(true); // videoId 없음
    expect((await ex.execute(call({}), {})).isError).toBe(true); // action 없음
  });

  it("control 미주입(play) → 정직 unsupported", async () => {
    expect((await makeYoutubeBgmExecutor().execute(call({ action: "play", videoId: "v" }), {})).isError).toBe(true);
  });
});
