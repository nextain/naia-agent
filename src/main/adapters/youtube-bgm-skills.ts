// adapters/youtube-bgm-skills — UC8(공간분위기/BGM) ToolExecutorPort. agent-local skill 구조 이식.
// old skills/built-in/youtube-bgm.ts(11액션) 패턴 이식 — search/play/stop/pause/resume/volume 핵심.
// ⚠️ external = injected dep: MusicSearchPort(youtubei.js)·BgmControlPort(shell player). 미주입=unsupported(정직).
// §E 동일 규약(github-skills): no-throw 경계(arg/dep/format 단일 try, abort만 reject), abort 가드, arg 검증, 도메인 volume clamp.
// tier="ask": BGM=환경 변경 → UC13 승인(자동 환경변경 방지).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

/** external 검색(youtubei.js Innertube). 미주입 시 search 불가(정직 unsupported). */
export type MusicSearchPort = (query: string, signal?: AbortSignal) => Promise<readonly { videoId: string; title: string }[]>;
/** external 재생 제어(shell BGM player, os EnvironmentPort.space). 미주입 시 제어 불가. */
export interface BgmControlPort {
  play(videoId: string, title: string): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  setVolume(v: number): Promise<void>; // 0..1 (도메인이 clamp 후 전달)
}
export interface BgmDeps { search?: MusicSearchPort; control?: BgmControlPort; }

const BGM_ACTIONS = ["search", "play", "stop", "pause", "resume", "volume"] as const;
type BgmAction = (typeof BGM_ACTIONS)[number];

const TOOLS: readonly ToolSpec[] = [
  {
    name: "youtube_bgm",
    description: "YouTube BGM 플레이어 제어. search(검색+첫결과 재생)/play(videoId)/stop/pause/resume/volume(0-1). 사용자가 배경음악/공간 분위기를 원할 때.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...BGM_ACTIONS], description: BGM_ACTIONS.join(" | ") },
        query: { type: "string", description: "검색어(search)" },
        videoId: { type: "string", description: "YouTube video id(play)" },
        title: { type: "string", description: "제목(play, 선택)" },
        volume: { type: "number", description: "0.0~1.0(volume)" },
      },
      required: ["action"],
    },
    tier: "ask", // 환경 변경 → 승인(UC13)
    processing: {
      workload: "network_tool",
      destination: "external_cloud",
      provider: "youtube",
      model: "search",
      when: { key: "action", values: ["search"] },
    },
  },
];

const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "tool error"; }
}
/** 도메인: volume 0..1 clamp(순수). 비유한=기본 0.5. */
export function clampVolume(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0.5;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function makeYoutubeBgmExecutor(deps: BgmDeps = {}): ToolExecutorPort {
  return {
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined;
      let aborted = false;
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard();
        if (!isObj(call.args)) return err("args must be object");
        const a = call.args;
        const action = a.action;
        if (typeof action !== "string" || !(BGM_ACTIONS as readonly string[]).includes(action)) return err(`unknown action (allowed: ${BGM_ACTIONS.join("/")})`);
        const act = action as BgmAction;

        if (act === "search") {
          if (!deps.search || !deps.control) return err("BGM search unavailable (external youtubei.js/player 미주입)");
          const query = a.query;
          if (typeof query !== "string" || !query.trim()) return err("query required for search");
          const results = await deps.search(query, signal);
          abortGuard(); // await 후 가드
          if (!results.length) return ok(`'${query}' 검색 결과 없음`);
          const top = results[0];
          await deps.control.play(top.videoId, top.title); // 첫 결과 자동재생(old 동일)
          return ok(`재생: ${top.title} (${top.videoId})`);
        }
        if (act === "play") {
          if (!deps.control) return err("BGM control unavailable (player 미주입)");
          const videoId = a.videoId;
          if (typeof videoId !== "string" || !videoId.trim()) return err("videoId required for play");
          await deps.control.play(videoId, typeof a.title === "string" ? a.title : "");
          return ok(`재생: ${videoId}`);
        }
        if (act === "volume") {
          if (!deps.control) return err("BGM control unavailable");
          const v = clampVolume(a.volume); // 도메인 clamp 0..1
          await deps.control.setVolume(v);
          return ok(`볼륨 ${v}`);
        }
        // stop/pause/resume
        if (!deps.control) return err("BGM control unavailable");
        if (act === "stop") { await deps.control.stop(); return ok("정지"); }
        if (act === "pause") { await deps.control.pause(); return ok("일시정지"); }
        await deps.control.resume(); return ok("재개");
      } catch (e) {
        if (aborted || isAborted(signal)) throw new Error("aborted"); // abort만 reject(no-throw 경계)
        return err(`youtube_bgm 실패: ${safeMsg(e)}`);
      }
    },
  };
}
