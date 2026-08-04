// adapters/activity-radio-dj-bgm — self-init activity의 좁은 shell panel BGM 왕복.
// 일반 ToolExecutor를 열지 않고 skill_youtube_bgm의 관측된 play/status/next/stop 결과만 사용한다.
import type { RadioDjBgmPort, RadioDjPlaybackState } from "../ports/speech-activity.js";
import type { ToolSpec } from "../domain/chat.js";
import type {
  ActivityRouteRegistry,
  ActivityWireEgress,
} from "./activity-speech-egress.js";

export interface ActivityRadioDjBgmAdapter extends RadioDjBgmPort {
  resolveResult(
    requestId: string,
    activityId: string | undefined,
    toolCallId: string,
    output: string,
    success: boolean,
  ): void;
}

type Track = { videoId?: string; title?: string };
type StructuredResult = {
  action?: string;
  videoId?: string;
  title?: string;
  selected?: Track;
  currentTrack?: Track | null;
  recentTracks?: Track[];
  favoriteTracks?: Track[];
  announceTrack?: boolean;
  playback?: {
    playbackId?: string;
    sequence?: number;
    status?: RadioDjPlaybackState["status"];
    reason?: string;
  } | null;
  ok?: boolean;
  reason?: string;
};

function boundedTracks(values: Track[] | undefined, limit: number) {
  if (!Array.isArray(values)) return undefined;
  const tracks = values
    .flatMap((value) => {
      const videoId = value?.videoId?.trim();
      const title = value?.title?.trim();
      return videoId && title ? [{ videoId, title }] : [];
    })
    .slice(0, limit);
  return tracks.length ? tracks : undefined;
}

function observedState(data: StructuredResult | undefined): RadioDjPlaybackState | undefined {
  const playback = data?.playback;
  if (!data || !playback?.status) return undefined;
  const videoId = data.currentTrack?.videoId?.trim();
  const title = data.currentTrack?.title?.trim();
  const recentTracks = boundedTracks(data.recentTracks, 20);
  const favoriteTracks = boundedTracks(data.favoriteTracks, 10);
  return {
    status: playback.status,
    ...(playback.playbackId ? { playbackId: playback.playbackId } : {}),
    ...(Number.isSafeInteger(playback.sequence) ? { sequence: playback.sequence } : {}),
    ...(videoId && title && data.announceTrack === true ? { track: { videoId, title } } : {}),
    ...(playback.reason ? { reason: playback.reason } : {}),
    ...(recentTracks ? { recentTracks } : {}),
    ...(favoriteTracks ? { favoriteTracks } : {}),
  };
}

export function makeActivityRadioDjBgm(deps: {
  readonly wire: ActivityWireEgress;
  readonly routes: ActivityRouteRegistry;
  readonly specs: () => readonly ToolSpec[];
  readonly timeoutMs?: number;
  readonly observationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly now?: () => number;
}): ActivityRadioDjBgmAdapter {
  const timeoutMs = deps.timeoutMs ?? 15_000;
  const observationTimeoutMs = deps.observationTimeoutMs ?? 15_000;
  const pollIntervalMs = deps.pollIntervalMs ?? 100;
  const wait = deps.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const now = deps.now ?? Date.now;
  const pending = new Map<string, {
    activityId: string;
    action: string;
    settle: (result: { ok: boolean; data?: StructuredResult; reason?: string }) => void;
  }>();
  let sequence = 0;
  let nowPlaying: RadioDjPlaybackState | undefined;
  let lastRoute: { requestId: string; activityId: string } | undefined;

  const spec = (): ToolSpec | undefined =>
    deps.specs().find((candidate) => candidate.name === "skill_youtube_bgm");
  const supports = (action: string): boolean => {
    const parameters = spec()?.parameters as {
      properties?: { action?: { enum?: unknown[] } };
    } | undefined;
    const actions = parameters?.properties?.action?.enum;
    return Array.isArray(actions) ? actions.includes(action) : action !== "next" && action !== "status";
  };

  async function call(
    action: string,
    args: Record<string, unknown>,
    opts: { requestId: string; activityId: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; data?: StructuredResult; reason?: string }> {
    const route = deps.routes.get(opts.activityId);
    if (!route || route.requestId !== opts.requestId) return { ok: false, reason: "activity route unavailable" };
    const toolCallId = `activity-bgm-${++sequence}`;
    const key = `${opts.requestId}\0${toolCallId}`;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: { ok: boolean; data?: StructuredResult; reason?: string }) => {
        if (settled) return;
        settled = true;
        pending.delete(key);
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => settle({ ok: false, reason: "panel BGM timeout" }), timeoutMs);
      pending.set(key, { activityId: opts.activityId, action, settle });
      if (opts.signal?.aborted) { settle({ ok: false, reason: "cancelled" }); return; }
      deps.wire.emit(
        route.sessionId,
        route.requestId,
        route.activityId,
        route.profileGeneration,
        {
          kind: "panelToolCall",
          toolCallId,
          toolName: "skill_youtube_bgm",
          args: { action, ...args },
        },
      );
    });
  }

  async function readObservedStatus(opts: { requestId: string; activityId: string; signal?: AbortSignal }) {
    const result = await call("status", {}, opts);
    if (!result.ok) return undefined;
    const state = observedState(result.data);
    nowPlaying = state;
    return state;
  }

  return {
    capabilities: () => ({
      ready: spec() !== undefined && supports("play") && supports("status"),
      // Shell next currently returns command acceptance without a target playbackId.
      // Radio therefore reselects through the exact play receipt/status contract.
      next: false,
    }),
    async searchAndPlay(query, opts) {
      lastRoute = { requestId: opts.requestId, activityId: opts.activityId };
      const result = await call("play", { query, mode: "radio_dj" }, opts);
      const selectedVideoId = result.data?.selected?.videoId?.trim();
      const selectedTitle = result.data?.selected?.title?.trim();
      const playbackId = result.data?.playback?.playbackId;
      if (!result.ok || !selectedVideoId || !selectedTitle || !playbackId) {
        return { ok: false, reason: result.reason ?? "invalid BGM play receipt" };
      }
      const deadline = now() + observationTimeoutMs;
      while (!opts.signal?.aborted && now() <= deadline) {
        const state = await readObservedStatus(opts);
        if (!state) return { ok: false, reason: "BGM status unavailable" };
        if (state.playbackId === playbackId && state.status === "playing" && state.track) {
          if (state.track.videoId !== selectedVideoId) return { ok: false, reason: "BGM observed track mismatch" };
          return { ok: true, videoId: state.track.videoId, title: state.track.title };
        }
        if (state.playbackId === playbackId && ["ended", "error", "timeout"].includes(state.status)) {
          return { ok: false, reason: state.reason ?? `BGM ${state.status}` };
        }
        await wait(pollIntervalMs);
      }
      return { ok: false, reason: opts.signal?.aborted ? "cancelled" : "BGM playing observation timeout" };
    },
    async next(_opts) {
      return { ok: false, reason: "uncorrelated_next_receipt" };
    },
    async stop(opts) {
      const result = await call("stop", {}, opts);
      if (result.ok) nowPlaying = undefined;
      return { ok: result.ok };
    },
    async status() {
      if (!lastRoute || !supports("status")) return nowPlaying;
      return readObservedStatus(lastRoute);
    },
    resolveResult(requestId, activityId, toolCallId, output, success): void {
      const entry = pending.get(`${requestId}\0${toolCallId}`);
      if (!entry) return;
      const routeMatches = activityId === entry.activityId;
      if (!success || !routeMatches) {
        entry.settle({ ok: false, reason: success ? "activity correlation mismatch" : output });
        return;
      }
      try {
        const data = JSON.parse(output) as StructuredResult;
        if (data.action !== entry.action) {
          entry.settle({ ok: false, reason: "BGM action mismatch" });
          return;
        }
        if (data.ok !== true) {
          entry.settle({ ok: false, data, reason: data.reason ?? "BGM action rejected" });
          return;
        }
        entry.settle({ ok: true, data, ...(data.reason ? { reason: data.reason } : {}) });
      } catch {
        entry.settle({ ok: false, reason: "BGM result is not structured JSON" });
      }
    },
  };
}
