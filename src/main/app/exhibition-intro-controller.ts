// app/exhibition-intro-controller — Issue #82 MVP-2.
// 전시 KB grounding, 비반복 cursor, 비-terminal yield/resume와 quiet를 닫힌 controller로 관리한다.
import type {
  ExhibitionIntroItem,
  ExhibitionProfileConfig,
  ExhibitionResumeBinding,
  ExhibitionScheduler,
  ExhibitionSpeechPort,
} from "../ports/speech-activity.js";
export type {
  ExhibitionIntroItem,
  ExhibitionProfileConfig,
  ExhibitionResumeBinding,
  ExhibitionScheduler,
  ExhibitionSpeechPort,
} from "../ports/speech-activity.js";

export type ExhibitionState =
  | "disabled"
  | "idle"
  | "attracting"
  | "speaking"
  | "yielded"
  | "answering"
  | "resume_wait"
  | "quiet"
  | "stopped";

interface ExhibitionDeps {
  readonly scheduler: ExhibitionScheduler;
  readonly ids: { activity(): string; resumeToken(): string };
  readonly knowledge: {
    ready(): boolean;
    listIntroItems(scope: string): Promise<readonly ExhibitionIntroItem[]>;
    answer(
      scope: string,
      question: string,
    ): Promise<{ readonly abstained: boolean; readonly answer: string; readonly sources: readonly string[] }>;
  };
  readonly speech: ExhibitionSpeechPort;
}

const ABSTAIN = "확인된 전시 자료에서는 그 답을 찾지 못했습니다.";

export class ExhibitionIntroController {
  private config?: ExhibitionProfileConfig;
  private subscriberReady = false;
  private currentState: ExhibitionState = "disabled";
  private activityId?: string;
  private profileGeneration = 0;
  private activeResumeToken?: string;
  private yieldGeneration = 0;
  private utteranceEpoch = 0;
  private cancelTimers: (() => void)[] = [];
  private items: ExhibitionIntroItem[] = [];
  private itemsLoading?: Promise<void>;
  private itemsReady = false;
  private introduced = new Set<string>();
  private nextItemIndex = 0;

  constructor(private readonly d: ExhibitionDeps) {}

  state(): ExhibitionState { return this.currentState; }
  currentActivityId(): string | undefined { return this.activityId; }

  dependencies(): Readonly<ExhibitionDeps> { return this.d; }

  configure(config: ExhibitionProfileConfig | undefined): void {
    const previousActivityId = this.activityId;
    this.cancelScheduled();
    this.utteranceEpoch++;
    this.profileGeneration++;
    if (previousActivityId) {
      this.d.speech.interrupt(previousActivityId);
      this.d.speech.close(previousActivityId, "cancelled");
    }
    this.config = config;
    this.activityId = undefined;
    this.activeResumeToken = undefined;
    this.yieldGeneration = 0;
    this.items = [];
    this.itemsLoading = undefined;
    this.itemsReady = false;
    this.introduced.clear();
    this.nextItemIndex = 0;
    this.currentState = config ? "idle" : "disabled";
    this.armIdle();
  }

  setSubscriberReady(ready: boolean): void {
    this.subscriberReady = ready;
    if (!ready) {
      this.cancelScheduled();
      return;
    }
    this.armIdle();
  }

  onUserActivity(): void {
    if (this.currentState !== "idle") return;
    this.cancelScheduled();
    this.armIdle();
  }

  yieldForQuestion(): ExhibitionResumeBinding | undefined {
    if (!this.config || !this.activityId) return undefined;
    if (!["attracting", "speaking", "resume_wait"].includes(this.currentState)) return undefined;
    this.cancelScheduled();
    this.utteranceEpoch++;
    this.d.speech.interrupt(this.activityId);
    this.currentState = "yielded";
    const resumeToken = this.d.ids.resumeToken();
    this.activeResumeToken = resumeToken;
    const yieldGeneration = ++this.yieldGeneration;
    return {
      sessionId: this.config.sessionId,
      activityId: this.activityId,
      profileGeneration: this.profileGeneration,
      yieldGeneration,
      resumeToken,
    };
  }

  async answerQuestion(
    binding: ExhibitionResumeBinding,
    question: string,
    speech: Pick<ExhibitionSpeechPort, "speak"> = this.d.speech,
  ): Promise<boolean> {
    if (!this.validBinding(binding) || this.currentState !== "yielded" || !this.config || !this.activityId) {
      return false;
    }
    const config = this.config;
    const activityId = this.activityId;
    const utteranceEpoch = this.utteranceEpoch;
    this.currentState = "answering";
    let text = ABSTAIN;
    let sources: readonly string[] = [];
    try {
      const answer = await this.d.knowledge.answer(config.knowledgeScope, question);
      const validSources = nonBlankSources(answer.sources);
      if (!answer.abstained && answer.answer.trim() && validSources.length > 0) {
        text = answer.answer.trim();
        sources = validSources;
      }
    } catch {
      // KB unavailable is a grounded abstention, never a general-knowledge fallback.
    }
    if (
      !this.validBinding(binding)
      || utteranceEpoch !== this.utteranceEpoch
      || this.currentState !== "answering"
      || activityId !== this.activityId
      || config !== this.config
    ) return true;
    await speech.speak({
      sessionId: config.sessionId,
      activityId,
      text,
      ...(sources.length ? { sourceUris: sources } : {}),
    });
    if (!this.validBinding(binding) || this.isPausedOrStopped()) {
      return true;
    }
    // A visitor may ask while the attraction list is still loading. Do not
    // mistake "not loaded yet" for "no remaining introductions".
    await this.itemsLoading;
    if (!this.validBinding(binding) || this.isPausedOrStopped()) {
      return true;
    }
    this.activeResumeToken = undefined;
    this.currentState = "resume_wait";
    this.scheduleRemaining();
    return true;
  }

  quiet(): void {
    this.cancelScheduled();
    this.utteranceEpoch++;
    this.activeResumeToken = undefined;
    if (this.activityId) this.d.speech.interrupt(this.activityId);
    this.currentState = "quiet";
  }

  resume(): void {
    if (this.currentState !== "quiet" || !this.config || !this.activityId) return;
    this.currentState = "resume_wait";
    void this.scheduleRemainingWhenReady();
  }

  restart(): void {
    if (!this.config) return;
    this.cancelScheduled();
    this.utteranceEpoch++;
    this.activeResumeToken = undefined;
    this.introduced.clear();
    this.nextItemIndex = 0;
    if (!this.activityId) this.activityId = this.d.ids.activity();
    this.currentState = "resume_wait";
    void this.scheduleRemainingWhenReady();
  }

  stop(): void {
    this.cancelScheduled();
    this.utteranceEpoch++;
    this.profileGeneration++;
    this.activeResumeToken = undefined;
    if (this.activityId) this.d.speech.interrupt(this.activityId);
    this.currentState = "stopped";
    if (this.activityId) this.d.speech.close(this.activityId, "finished");
  }

  private ready(): boolean {
    return Boolean(this.config && this.subscriberReady && this.d.knowledge.ready());
  }

  private armIdle(): void {
    if (!this.config || this.currentState !== "idle" || !this.ready() || this.cancelTimers.length) return;
    const generation = this.profileGeneration;
    const cancel = this.d.scheduler.schedule(finiteDelay(this.config.idleMs, 60_000), async () => {
      this.removeCancel(cancel);
      if (generation !== this.profileGeneration || this.currentState !== "idle" || !this.ready()) return;
      await this.start();
    });
    this.cancelTimers.push(cancel);
  }

  private async start(): Promise<void> {
    if (!this.config || !this.ready()) return;
    // Every attraction cycle owns its own list and cursor. Carrying these
    // across the next idle cycle either suppresses repeated item IDs forever
    // or lets a quiet/resume race schedule the previous activity's list.
    this.items = [];
    this.itemsLoading = undefined;
    this.itemsReady = false;
    this.introduced.clear();
    this.nextItemIndex = 0;
    this.currentState = "attracting";
    this.activityId = this.d.ids.activity();
    this.d.speech.open({
      sessionId: this.config.sessionId,
      activityId: this.activityId,
      requestId: `exhibition:${this.activityId}`,
      profileGeneration: this.profileGeneration,
    });
    const generation = this.profileGeneration;
    const utteranceEpoch = this.utteranceEpoch;
    const activityId = this.activityId;
    const config = this.config;
    this.itemsLoading = (async () => {
      let raw: readonly ExhibitionIntroItem[];
      try {
        raw = await this.d.knowledge.listIntroItems(config.knowledgeScope);
      } catch {
        raw = [];
      }
      if (
        generation !== this.profileGeneration
        || activityId !== this.activityId
        || config !== this.config
      ) return;
      const seen = new Set<string>();
      this.items = raw.filter((item) => {
        const id = item.itemId.trim();
        if (!id || !item.text.trim() || nonBlankSources(item.sourceUris).length === 0 || seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 3);
      this.nextItemIndex = 0;
      this.itemsReady = true;
    })();
    await this.itemsLoading;
    if (
      generation !== this.profileGeneration
      || utteranceEpoch !== this.utteranceEpoch
      || activityId !== this.activityId
      || config !== this.config
      || this.currentState !== "attracting"
    ) return;
    await this.d.speech.speak({
      sessionId: config.sessionId,
      activityId,
      text: "안녕하세요. 넥스테인 전시에 오신 것을 환영합니다.",
    });
    if (
      generation !== this.profileGeneration
      || utteranceEpoch !== this.utteranceEpoch
      || this.currentState !== "attracting"
    ) return;
    this.currentState = "speaking";
    this.scheduleRemaining();
  }

  private scheduleRemaining(): void {
    if (!this.config || !this.activityId || !["speaking", "resume_wait"].includes(this.currentState)) return;
    this.cancelScheduled();
    const generation = this.profileGeneration;
    const item = this.items[this.nextItemIndex];
    if (!item) {
      this.d.speech.close(this.activityId, "finished");
      this.activityId = undefined;
      this.currentState = "idle";
      this.armIdle();
      return;
    }
    const cancel = this.d.scheduler.schedule(
      finiteDelay(this.config.introIntervalMs, 10_000),
      async () => {
        this.removeCancel(cancel);
        if (
          generation !== this.profileGeneration
          || !this.config
          || !this.activityId
          || !["speaking", "resume_wait"].includes(this.currentState)
          || this.introduced.has(item.itemId)
        ) return;
        this.currentState = "speaking";
        // 중단된 항목을 답변 뒤 반복하지 않는다. 완료 집합과 진행 cursor는 별개다.
        this.nextItemIndex++;
        const utteranceEpoch = this.utteranceEpoch;
        const activityId = this.activityId;
        const sourceUris = nonBlankSources(item.sourceUris);
        const result = await this.d.speech.speak({
          sessionId: this.config.sessionId,
          activityId,
          text: item.text,
          sourceUris,
        });
        if (
          result !== "completed"
          || generation !== this.profileGeneration
          || utteranceEpoch !== this.utteranceEpoch
          || activityId !== this.activityId
          || this.currentState !== "speaking"
        ) return;
        this.introduced.add(item.itemId);
        this.scheduleRemaining();
      },
    );
    this.cancelTimers.push(cancel);
  }

  private async scheduleRemainingWhenReady(): Promise<void> {
    if (this.itemsReady) {
      this.scheduleRemaining();
      return;
    }
    await this.itemsLoading;
    this.scheduleRemaining();
  }

  private validBinding(binding: ExhibitionResumeBinding): boolean {
    return Boolean(
      this.config
      && binding.sessionId === this.config.sessionId
      && binding.activityId === this.activityId
      && binding.profileGeneration === this.profileGeneration
      && binding.yieldGeneration === this.yieldGeneration
      && binding.resumeToken === this.activeResumeToken,
    );
  }

  private cancelScheduled(): void {
    for (const cancel of this.cancelTimers.splice(0)) cancel();
  }

  private removeCancel(cancel: () => void): void {
    const index = this.cancelTimers.indexOf(cancel);
    if (index >= 0) this.cancelTimers.splice(index, 1);
  }

  private isPausedOrStopped(): boolean {
    return this.currentState === "quiet" || this.currentState === "stopped";
  }

}

function finiteDelay(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function nonBlankSources(sources: readonly string[]): string[] {
  return sources
    .filter((source): source is string => typeof source === "string")
    .map((source) => source.trim())
    .filter(Boolean);
}
