// app/personal-radio-dj-controller — Issue #82 MVP-1.
// 개인 DJ의 닫힌 상태와 정책만 소유한다. 범용 tool executor를 열지 않고 좁은 BGM/context/speech 포트만 사용한다.
import type {
  DjContextSnapshot,
  PersonalRadioDjConfig,
  ProactiveScheduler,
  RadioDjBgmPort,
  RadioDjSpeechPort,
} from "../ports/speech-activity.js";
export type {
  DjContextSnapshot,
  PersonalRadioDjConfig,
  ProactiveScheduler,
  RadioDjBgmPort,
  RadioDjSpeechPort,
} from "../ports/speech-activity.js";

export type RadioDjControl =
  | { readonly kind: "music_only" }
  | { readonly kind: "talk_less" }
  | { readonly kind: "talk_more" }
  | { readonly kind: "change_vibe" }
  | { readonly kind: "next" }
  | { readonly kind: "stop" };

export type PersonalRadioDjState =
  | "disabled"
  | "idle"
  | "selecting"
  | "playing"
  | "dj_speaking"
  | "music_only"
  | "yielded"
  | "stopped";

interface DjDeps {
  readonly scheduler: ProactiveScheduler;
  readonly ids: { next(): string };
  readonly context: {
    snapshot(config: PersonalRadioDjConfig): Promise<DjContextSnapshot>;
    recordMood?: (input: { sessionId: string; quote: string; statedAt: string }) => void;
  };
  readonly selector: {
    select(
      snapshot: DjContextSnapshot,
      opts?: { readonly changeVibe?: boolean },
    ): Promise<{ readonly query: string; readonly reason: "time" | "weather" | "mood" | "preference" | "generic" }>;
  };
  readonly bgm: RadioDjBgmPort;
  readonly speech: RadioDjSpeechPort;
  readonly preferences: {
    handoff(signal: {
      readonly sentiment: "like" | "dislike" | "forget";
      readonly subject: string;
      readonly sessionId: string;
      readonly requestId: string;
      readonly statedAt: string;
      readonly source: "explicit_user_turn";
    }): Promise<void>;
  };
  readonly lease?: { readonly durationMs?: number; readonly maxUtterances?: number };
}

const WEATHER_FRESH_MS = 60 * 60_000;
const MOOD_FRESH_MS = 6 * 60 * 60_000;
const MAX_DJ_INTERVAL_MS = 60 * 60_000;
const DEFAULT_LEASE_MS = 30 * 60_000;
const DEFAULT_LEASE_UTTERANCES = 60;
const MAX_PREFERENCE_CODEPOINTS = 500;

function finiteDelay(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

export class PersonalRadioDjController {
  private config?: PersonalRadioDjConfig;
  private subscriberReady = false;
  private currentState: PersonalRadioDjState = "disabled";
  private activityId?: string;
  private requestId?: string;
  private cancelFlowTimer?: () => void;
  private cancelLeaseTimer?: () => void;
  private generation = 0;
  private operationEpoch = 0;
  private preserveLatePlaybackEpochs = new Set<number>();
  private intervalMs = 0;
  private commentIndex = 0;
  private lastSnapshot?: DjContextSnapshot;
  private lastReason: "time" | "weather" | "mood" | "preference" | "generic" = "generic";
  private activityAbort?: AbortController;
  private leaseUtterances = 0;
  private leaseRenewals = 0;
  private controllerStarts = 0;

  constructor(private readonly d: DjDeps) {}

  state(): PersonalRadioDjState { return this.currentState; }
  currentActivityId(): string | undefined { return this.activityId; }
  stats(): { leaseRenewals: number; controllerStarts: number; leaseUtterances: number } {
    return {
      leaseRenewals: this.leaseRenewals,
      controllerStarts: this.controllerStarts,
      leaseUtterances: this.leaseUtterances,
    };
  }

  configure(config: PersonalRadioDjConfig | undefined): void {
    this.deactivateCurrent();
    this.generation++;
    this.config = config;
    this.intervalMs = finiteDelay(config?.djIntervalMs ?? 0, 30_000);
    this.currentState = config ? "idle" : "disabled";
    this.leaseUtterances = 0;
    this.leaseRenewals = 0;
    this.controllerStarts = 0;
    this.armIdle();
  }

  setSubscriberReady(ready: boolean): void {
    this.subscriberReady = ready;
    if (!ready) {
      this.deactivateCurrent();
      this.currentState = this.config ? "idle" : "disabled";
      return;
    }
    this.armIdle();
  }

  /** Re-evaluate late-bound shell capabilities such as panel BGM registration. */
  refreshAvailability(): void {
    this.armIdle();
  }

  onUserActivity(): void {
    if (this.currentState !== "idle") return;
    this.cancelFlow();
    this.armIdle();
  }

  async control(control: RadioDjControl): Promise<void> {
    if (!this.config || !this.activityId || !this.requestId) return;
    const generation = this.generation;
    const activityId = this.activityId;
    const requestId = this.requestId;
    const operationEpoch = this.operationEpoch;
    switch (control.kind) {
      case "music_only":
        this.cancelFlow();
        this.preserveLatePlaybackEpochs.add(operationEpoch);
        this.operationEpoch++;
        this.activityAbort?.abort();
        this.activityAbort = new AbortController();
        this.d.speech.interrupt(activityId);
        this.currentState = "music_only";
        return;
      case "talk_less":
        this.intervalMs = Math.min(
          Math.max(this.intervalMs * 2, this.config.djIntervalMs),
          MAX_DJ_INTERVAL_MS,
        );
        if (this.currentState === "dj_speaking") {
          this.cancelFlow();
          this.scheduleComment();
        }
        return;
      case "talk_more":
        this.intervalMs = Math.max(
          this.config.djIntervalMs,
          Math.floor(this.intervalMs / 2),
        );
        if (this.currentState === "music_only") {
          this.currentState = "dj_speaking";
          this.armLease();
        }
        if (this.currentState === "dj_speaking") {
          this.cancelFlow();
          this.scheduleComment();
        }
        return;
      case "change_vibe":
        await this.replaceSelection(true, generation, operationEpoch);
        return;
      case "next": {
        if (this.d.bgm.capabilities().next) {
          let next;
          let previous: { videoId: string; title: string } | undefined;
          try {
            previous = await this.d.bgm.status();
            next = await this.d.bgm.next({
              requestId,
              activityId,
              signal: this.activityAbort?.signal,
            });
          } catch {
            await this.replaceSelection(true, generation, operationEpoch);
            return;
          }
          if (!this.isOperationCurrent(generation, activityId, operationEpoch)) {
            if (this.shouldCompensateLatePlayback(operationEpoch)) {
              await this.compensateLatePlayback(requestId, activityId);
            }
            return;
          }
          // A tool dispatch is not a track transition.  Announce only the exact
          // Player-accepted next track, and never narrate the same track as new.
          if (
            next.ok
            && next.videoId
            && next.title
            && next.videoId !== previous?.videoId
          ) {
            await this.speak(renderPlayIntro(next.title));
          } else {
            // Native next can be unavailable (empty/one-item queue) or reject a
            // duplicate.  Select a new track instead of claiming that it changed.
            await this.replaceSelection(true, generation, operationEpoch);
          }
        } else {
          await this.replaceSelection(true, generation, operationEpoch);
        }
        return;
      }
      case "stop":
        await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.cancelScheduled();
    this.preserveLatePlaybackEpochs.clear();
    this.generation++;
    this.operationEpoch++;
    this.activityAbort?.abort();
    const activityId = this.activityId;
    const requestId = this.requestId;
    if (activityId) this.d.speech.interrupt(activityId);
    this.currentState = "stopped";
    if (activityId && requestId) {
      try { await this.d.bgm.stop({ requestId, activityId }); } catch { /* stop is best-effort but terminal */ }
    }
    if (activityId) this.d.speech.close(activityId, "finished");
  }

  async recordExplicitPreference(
    sentiment: "like" | "dislike" | "forget",
    subject: string,
    provenance: { readonly requestId: string; readonly statedAt?: string },
  ): Promise<void> {
    if (!this.config || !provenance.requestId.trim()) return;
    const normalized = [...subject.trim()].slice(0, MAX_PREFERENCE_CODEPOINTS).join("");
    if (!normalized) return;
    await this.d.preferences.handoff({
      sentiment,
      subject: normalized,
      sessionId: this.config.sessionId,
      requestId: provenance.requestId,
      statedAt: provenance.statedAt ?? new Date(this.d.scheduler.now()).toISOString(),
      source: "explicit_user_turn",
    });
  }

  recordExplicitMood(
    quote: string,
    provenance: { readonly requestId: string; readonly statedAt?: string },
  ): void {
    if (!this.config || !provenance.requestId.trim()) return;
    const normalized = [...quote.trim()].slice(0, MAX_PREFERENCE_CODEPOINTS).join("");
    if (!normalized) return;
    this.d.context.recordMood?.({
      sessionId: this.config.sessionId,
      quote: normalized,
      statedAt: provenance.statedAt ?? new Date(this.d.scheduler.now()).toISOString(),
    });
  }

  private ready(): boolean {
    return Boolean(
      this.config?.bgmAutoPlayOptIn
      && this.subscriberReady
      && this.d.bgm.capabilities().ready,
    );
  }

  private armIdle(): void {
    if (!this.config || this.currentState !== "idle" || !this.ready() || this.cancelFlowTimer) return;
    const generation = this.generation;
    this.cancelFlowTimer = this.d.scheduler.schedule(
      finiteDelay(this.config.idleMs, 60_000),
      async () => {
        this.cancelFlowTimer = undefined;
        if (generation !== this.generation || this.currentState !== "idle" || !this.ready()) return;
        await this.start();
      },
    );
  }

  private async start(): Promise<void> {
    const config = this.config;
    if (!config || !this.ready()) return;
    this.currentState = "selecting";
    this.activityId = this.d.ids.next();
    this.requestId = `radio-dj:${this.activityId}`;
    this.activityAbort = new AbortController();
    const operationEpoch = ++this.operationEpoch;
    this.controllerStarts++;
    this.leaseUtterances = 0;
    this.armLease();
    const generation = this.generation;
    const activityId = this.activityId;
    const requestId = this.requestId;
    this.d.speech.open({
      sessionId: config.sessionId,
      activityId,
      requestId,
      profileGeneration: generation,
    });
    let played: Awaited<ReturnType<RadioDjBgmPort["searchAndPlay"]>>;
    try {
      const raw = await this.d.context.snapshot(config);
      if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
      const live = await this.d.bgm.status();
      if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
      const snapshot = this.freshSnapshot(raw, live);
      this.lastSnapshot = snapshot;
      const selection = await this.d.selector.select(snapshot);
      if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
      this.lastReason = sourceExists(selection.reason, snapshot) ? selection.reason : "generic";
      played = await this.d.bgm.searchAndPlay(selection.query, {
        requestId,
        activityId,
        signal: this.activityAbort.signal,
      });
    } catch {
      await this.failAndRearm(generation, activityId, operationEpoch, "음악을 준비하는 중 문제가 생겼어요.");
      return;
    }
    if (!this.isOperationCurrent(generation, activityId, operationEpoch)) {
      if (played.ok && this.shouldCompensateLatePlayback(operationEpoch)) {
        await this.compensateLatePlayback(requestId, activityId);
      }
      return;
    }
    if (!played.ok) {
      await this.speak("지금은 조건에 맞는 음악을 재생하지 못했어요.");
      if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
      this.currentState = "idle";
      this.cancelLease();
      this.d.speech.close(activityId, "finished");
      this.armIdle();
      return;
    }
    this.currentState = "playing";
    try {
      await this.speak(renderPlayIntro(played.title));
    } catch {
      await this.failAndRearm(generation, activityId, operationEpoch, "음악은 재생했지만 안내 음성을 준비하지 못했어요.");
      return;
    }
    if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
    this.currentState = "dj_speaking";
    this.commentIndex = 0;
    this.scheduleComment();
  }

  private async replaceSelection(changeVibe: boolean, generation: number, operationEpoch: number): Promise<void> {
    if (!this.config || !this.activityId || !this.requestId) return;
    const activityId = this.activityId;
    const requestId = this.requestId;
    this.cancelFlow();
    this.d.speech.interrupt(activityId);
    this.currentState = "selecting";
    let played: Awaited<ReturnType<RadioDjBgmPort["searchAndPlay"]>>;
    try {
      const raw = await this.d.context.snapshot(this.config);
      if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
      const live = await this.d.bgm.status();
      if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
      const snapshot = this.freshSnapshot(raw, live);
      this.lastSnapshot = snapshot;
      const selection = await this.d.selector.select(snapshot, { changeVibe });
      if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
      this.lastReason = sourceExists(selection.reason, snapshot) ? selection.reason : "generic";
      played = await this.d.bgm.searchAndPlay(selection.query, {
        requestId,
        activityId,
        signal: this.activityAbort?.signal,
      });
    } catch {
      await this.failAndResumeComments(generation, activityId, operationEpoch, "다른 분위기의 음악을 준비하지 못했어요.");
      return;
    }
    if (!this.isOperationCurrent(generation, activityId, operationEpoch)) {
      if (played.ok && this.shouldCompensateLatePlayback(operationEpoch)) {
        await this.compensateLatePlayback(requestId, activityId);
      }
      return;
    }
    if (!played.ok) {
      await this.speak("다른 분위기의 음악을 찾지 못했어요.");
      if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
      this.currentState = "dj_speaking";
      this.scheduleComment();
      return;
    }
    await this.speak(renderPlayIntro(played.title));
    if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
    this.currentState = "dj_speaking";
    this.scheduleComment();
  }

  private freshSnapshot(
    raw: DjContextSnapshot,
    live: { videoId: string; title: string } | undefined,
  ): DjContextSnapshot {
    const now = this.d.scheduler.now();
    const weatherAt = raw.weather ? Date.parse(raw.weather.observedAt) : Number.NaN;
    const moodAt = raw.moodActivity ? Date.parse(raw.moodActivity.statedAt) : Number.NaN;
    const weatherFresh = raw.weather
      && Number.isFinite(weatherAt)
      && now - weatherAt >= 0
      && now - weatherAt <= WEATHER_FRESH_MS;
    const moodFresh = raw.moodActivity
      && raw.moodActivity.sessionId === this.config?.sessionId
      && Number.isFinite(moodAt)
      && now - moodAt >= 0
      && now - moodAt <= MOOD_FRESH_MS;
    return {
      localTime: raw.localTime,
      ...(weatherFresh ? { weather: raw.weather } : {}),
      ...(moodFresh ? { moodActivity: raw.moodActivity } : {}),
      ...(live ? { nowPlaying: { ...live, source: "bgm-player" as const } } : {}),
      preferences: raw.preferences.filter((p) => p.confidence === "explicit"),
    };
  }

  private scheduleComment(): void {
    if (!this.config || this.currentState !== "dj_speaking" || this.cancelFlowTimer) return;
    const generation = this.generation;
    this.cancelFlowTimer = this.d.scheduler.schedule(this.intervalMs, async () => {
      this.cancelFlowTimer = undefined;
      if (generation !== this.generation || this.currentState !== "dj_speaking") return;
      await this.speak(renderDjComment(this.commentIndex++, this.lastSnapshot, this.lastReason));
      if (generation !== this.generation || this.currentState !== "dj_speaking") return;
      if (generation === this.generation && this.currentState === "dj_speaking") {
        this.scheduleComment();
      }
    });
  }

  private async speak(text: string): Promise<"completed" | "cancelled"> {
    if (!this.config || !this.activityId) return "cancelled";
    const result = await this.d.speech.speak({
      sessionId: this.config.sessionId,
      activityId: this.activityId,
      text,
    });
    if (result === "completed") {
      this.leaseUtterances++;
      this.renewLeaseForUtteranceLimit();
    }
    return result;
  }

  private cancelScheduled(): void {
    this.cancelFlow();
    this.cancelLease();
  }

  private cancelFlow(): void {
    this.cancelFlowTimer?.();
    this.cancelFlowTimer = undefined;
  }

  private cancelLease(): void {
    this.cancelLeaseTimer?.();
    this.cancelLeaseTimer = undefined;
  }

  private armLease(): void {
    if (!this.config || !this.activityId || this.currentState === "stopped") return;
    this.cancelLease();
    const generation = this.generation;
    const activityId = this.activityId;
    const durationMs = this.d.lease?.durationMs ?? DEFAULT_LEASE_MS;
    this.cancelLeaseTimer = this.d.scheduler.schedule(durationMs, () => {
      this.cancelLeaseTimer = undefined;
      if (!this.isCurrent(generation, activityId)) return;
      this.renewLease();
    });
  }

  private renewLeaseForUtteranceLimit(): void {
    const maxUtterances = this.d.lease?.maxUtterances ?? DEFAULT_LEASE_UTTERANCES;
    if (this.leaseUtterances < maxUtterances) return;
    this.renewLease();
  }

  private renewLease(): void {
    this.leaseUtterances = 0;
    this.leaseRenewals++;
    this.armLease();
  }

  private isCurrent(generation: number, activityId: string): boolean {
    return generation === this.generation
      && activityId === this.activityId
      && !this.activityAbort?.signal.aborted
      && this.currentState !== "stopped";
  }

  private isOperationCurrent(generation: number, activityId: string, operationEpoch: number): boolean {
    return this.isCurrent(generation, activityId) && operationEpoch === this.operationEpoch;
  }

  private shouldCompensateLatePlayback(operationEpoch: number): boolean {
    if (this.preserveLatePlaybackEpochs.delete(operationEpoch)) return false;
    return true;
  }

  private deactivateCurrent(): void {
    this.cancelScheduled();
    this.preserveLatePlaybackEpochs.clear();
    this.operationEpoch++;
    this.activityAbort?.abort();
    const activityId = this.activityId;
    const requestId = this.requestId;
    if (activityId) this.d.speech.interrupt(activityId);
    if (activityId) this.d.speech.close(activityId, "cancelled");
    if (activityId && requestId) {
      void this.d.bgm.stop({ requestId, activityId }).catch(() => {});
    }
    this.activityId = undefined;
    this.requestId = undefined;
  }

  private async compensateLatePlayback(requestId: string, activityId: string): Promise<void> {
    try { await this.d.bgm.stop({ requestId, activityId }); } catch { /* best-effort compensation */ }
  }

  private async failAndRearm(generation: number, activityId: string, operationEpoch: number, text: string): Promise<void> {
    if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
    try { await this.speak(text); } catch { /* speech failure must not wedge controller */ }
    if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
    this.currentState = "idle";
    this.cancelLease();
    this.armIdle();
  }

  private async failAndResumeComments(generation: number, activityId: string, operationEpoch: number, text: string): Promise<void> {
    if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
    try { await this.speak(text); } catch { /* no-throw activity boundary */ }
    if (!this.isOperationCurrent(generation, activityId, operationEpoch)) return;
    this.currentState = "dj_speaking";
    this.scheduleComment();
  }

}

function renderPlayIntro(videoTitle: string): string {
  // title은 player가 확인한 영상 제목이다. 현재 세부 곡을 나타내는 슬롯은 의도적으로 없다.
  return `“${videoTitle}” 영상을 재생 중이에요. 음악 흐름을 방해하지 않게 가끔 짧게 인사할게요.`;
}

function renderDjComment(
  index: number,
  snapshot: DjContextSnapshot | undefined,
  reason: "time" | "weather" | "mood" | "preference" | "generic",
): string {
  const groundedReason =
    reason === "preference" && snapshot?.preferences.length
      ? "말해 준 음악 취향을 참고해 이 분위기를 골랐어요."
      : reason === "weather" && snapshot?.weather
        ? "최근 확인된 날씨와 어울리는 흐름으로 골랐어요."
        : reason === "mood" && snapshot?.moodActivity
          ? "조금 전에 말해 준 기분과 어울리는 흐름으로 골랐어요."
          : "지금 분위기를 해치지 않도록 선곡 흐름을 유지할게요.";
  const variants = [
    "음악은 그대로 이어둘게요. 편하게 듣고 계세요.",
    groundedReason,
    "필요하면 음악만 들려 달라고 말해 주세요.",
    "지금 재생 흐름은 그대로 유지하고 있어요.",
    "말을 줄이고 싶으면 언제든 알려 주세요.",
    "다른 분위기가 필요하면 바로 바꿔 드릴게요.",
    "다음 곡이 필요하면 짧게 말씀해 주세요.",
    "음악 사이 여백을 지키며 곁에 있을게요.",
  ];
  return variants[index % variants.length]!;
}

function sourceExists(
  reason: "time" | "weather" | "mood" | "preference" | "generic",
  snapshot: DjContextSnapshot,
): boolean {
  if (reason === "weather") return snapshot.weather !== undefined;
  if (reason === "mood") return snapshot.moodActivity !== undefined;
  if (reason === "preference") return snapshot.preferences.length > 0;
  return true;
}
