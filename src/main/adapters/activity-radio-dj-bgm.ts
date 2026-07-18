// adapters/activity-radio-dj-bgm — self-init activity의 좁은 shell panel BGM 왕복.
// 일반 ToolExecutor를 열지 않고 skill_youtube_bgm의 play/next/stop만 구조 결과로 사용한다.
import type { RadioDjBgmPort } from "../ports/speech-activity.js";
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

type StructuredResult = {
  action?: string;
  videoId?: string;
  title?: string;
  ok?: boolean;
  reason?: string;
};

export function makeActivityRadioDjBgm(deps: {
  readonly wire: ActivityWireEgress;
  readonly routes: ActivityRouteRegistry;
  readonly specs: () => readonly ToolSpec[];
  readonly timeoutMs?: number;
}): ActivityRadioDjBgmAdapter {
  const timeoutMs = deps.timeoutMs ?? 50_000;
  const pending = new Map<string, {
    activityId: string;
    settle: (result: { ok: boolean; data?: StructuredResult; reason?: string }) => void;
  }>();
  let sequence = 0;
  let nowPlaying: { videoId: string; title: string } | undefined;

  const spec = (): ToolSpec | undefined =>
    deps.specs().find((candidate) => candidate.name === "skill_youtube_bgm");
  const supports = (action: string): boolean => {
    const parameters = spec()?.parameters as {
      properties?: { action?: { enum?: unknown[] } };
    } | undefined;
    const actions = parameters?.properties?.action?.enum;
    return Array.isArray(actions) ? actions.includes(action) : action !== "next";
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
      pending.set(key, { activityId: opts.activityId, settle });
      if (opts.signal?.aborted) { settle({ ok: false, reason: "cancelled" }); return; }
      // emit 이후 abort는 결과를 기다린다. 늦은 play 성공을 controller가 stop 보상해야 하기 때문이다.
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

  return {
    capabilities: () => ({ ready: spec() !== undefined && supports("play"), next: supports("next") }),
    async searchAndPlay(query, opts) {
      const result = await call("play", { query }, opts);
      const videoId = result.data?.videoId?.trim();
      const title = result.data?.title?.trim();
      if (!result.ok || !videoId || !title) return { ok: false, reason: result.reason ?? "invalid BGM result" };
      nowPlaying = { videoId, title };
      return { ok: true, videoId, title };
    },
    async next(opts) {
      if (!supports("next")) return { ok: false, reason: "unsupported" };
      const result = await call("next", {}, opts);
      if (!result.ok) return { ok: false, reason: result.reason ?? "next failed" };
      const videoId = result.data?.videoId?.trim();
      const title = result.data?.title?.trim();
      if (videoId && title) nowPlaying = { videoId, title };
      return { ok: true, ...(videoId ? { videoId } : {}), ...(title ? { title } : {}) };
    },
    async stop(opts) {
      const result = await call("stop", {}, opts);
      if (result.ok) nowPlaying = undefined;
      return { ok: result.ok };
    },
    async status() { return nowPlaying; },
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
        entry.settle({ ok: data.ok !== false, data, ...(data.reason ? { reason: data.reason } : {}) });
      } catch {
        entry.settle({ ok: false, reason: "BGM result is not structured JSON" });
      }
    },
  };
}
