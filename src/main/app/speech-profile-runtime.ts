// app/speech-profile-runtime — Issue #82 두 proactive profile의 얇은 composition facade.
// profile 선택/구독/yield/stop 및 exhibition Q&A privacy bypass만 소유한다.
import type { ChatRequest } from "../domain/chat.js";
import type {
  ExhibitionResumeBinding,
  SpeechProfileConfig,
  YieldSpeechResult,
} from "../ports/speech-activity.js";
import type { AgentEgressPort } from "../ports/uc1.js";
import type { PersonalRadioDjController } from "./personal-radio-dj-controller.js";
import type { ExhibitionIntroController } from "./exhibition-intro-controller.js";

export class SpeechProfileRuntime {
  private activeKind: "disabled" | "personal_radio_dj" | "exhibition_intro" = "disabled";
  private activeSessionId = "";
  private subscribedSessions = new Set<string>();

  constructor(private readonly d: {
    readonly dj: PersonalRadioDjController;
    readonly exhibition: ExhibitionIntroController;
    readonly chatEgress: AgentEgressPort;
  }) {}

  configure(profile: SpeechProfileConfig): void {
    this.activeKind = profile.kind;
    this.activeSessionId =
      profile.kind === "disabled" ? profile.sessionId : profile.config.sessionId;
    if (profile.kind === "personal_radio_dj") {
      this.d.exhibition.configure(undefined);
      this.d.dj.configure(profile.config);
      this.d.dj.setSubscriberReady(this.subscribedSessions.has(this.activeSessionId));
      return;
    }
    if (profile.kind === "exhibition_intro") {
      this.d.dj.configure(undefined);
      this.d.exhibition.configure(profile.config);
      this.d.exhibition.setSubscriberReady(this.subscribedSessions.has(this.activeSessionId));
      return;
    }
    this.d.dj.configure(undefined);
    this.d.exhibition.configure(undefined);
  }

  subscriberChanged(sessionId: string, ready: boolean): void {
    if (ready) this.subscribedSessions.add(sessionId);
    else this.subscribedSessions.delete(sessionId);
    if (sessionId !== this.activeSessionId) return;
    if (this.activeKind === "personal_radio_dj") this.d.dj.setSubscriberReady(ready);
    if (this.activeKind === "exhibition_intro") this.d.exhibition.setSubscriberReady(ready);
  }

  capabilitiesChanged(): void {
    if (this.activeKind === "personal_radio_dj") this.d.dj.refreshAvailability();
  }

  yield(sessionId: string, activityId: string): YieldSpeechResult {
    if (
      this.activeKind !== "exhibition_intro"
      || sessionId !== this.activeSessionId
      || activityId !== this.d.exhibition.currentActivityId()
    ) return { ok: false };
    const binding = this.d.exhibition.yieldForQuestion();
    return binding ? { ok: true, binding } : { ok: false };
  }

  async stop(sessionId: string, activityId?: string): Promise<void> {
    if (sessionId !== this.activeSessionId) return;
    if (this.activeKind === "personal_radio_dj") {
      await this.d.dj.stop();
      return;
    }
    if (
      this.activeKind === "exhibition_intro"
      && (!activityId || activityId === this.d.exhibition.currentActivityId())
    ) {
      this.d.exhibition.stop();
    }
  }

  async control(sessionId: string, activityId: string | undefined, action: string): Promise<boolean> {
    if (sessionId !== this.activeSessionId) return false;
    if (this.activeKind === "personal_radio_dj") {
      if (activityId && activityId !== this.d.dj.currentActivityId()) return false;
      if (!["music_only", "talk_less", "talk_more", "change_vibe", "next", "stop"].includes(action)) return false;
      await this.d.dj.control({ kind: action as "music_only" | "talk_less" | "talk_more" | "change_vibe" | "next" | "stop" });
      return true;
    }
    if (this.activeKind !== "exhibition_intro") return false;
    if (activityId && activityId !== this.d.exhibition.currentActivityId()) return false;
    if (action === "quiet") this.d.exhibition.quiet();
    else if (action === "resume") this.d.exhibition.resume();
    else if (action === "restart") this.d.exhibition.restart();
    else if (action === "stop") this.d.exhibition.stop();
    else return false;
    return true;
  }

  /**
   * 검증된 exhibition activityResume Q&A를 ordinary ChatTurnHandler보다 먼저 처리한다.
   * 이 경로는 controller의 read-only KB만 사용하므로 MemoryPort/ConversationLogPort에 닿지 않는다.
   */
  async handleProfileChat(req: ChatRequest): Promise<boolean> {
    const resume = req.activityResume;
    if (
      this.activeKind !== "exhibition_intro"
      || !resume
      || !req.sessionId
      || req.sessionId !== this.activeSessionId
    ) return false;
    const last = req.messages.at(-1);
    if (last?.role !== "user") return false;
    const binding: ExhibitionResumeBinding = {
      sessionId: req.sessionId,
      activityId: resume.activityId,
      profileGeneration: resume.profileGeneration,
      yieldGeneration: resume.yieldGeneration,
      resumeToken: resume.resumeToken,
    };
    let emitted = false;
    const handled = await this.d.exhibition.answerQuestion(binding, last.content, {
      speak: async ({ text }) => {
        this.d.chatEgress.emit(req.requestId, { kind: "text", text });
        emitted = true;
        return "completed";
      },
    });
    if (!handled) return false;
    this.d.chatEgress.emit(req.requestId, {
      kind: "usage",
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      model: "exhibition-kb",
    });
    if (!emitted) {
      this.d.chatEgress.emit(req.requestId, {
        kind: "error",
        message: "exhibition question was interrupted",
      });
    } else {
      this.d.chatEgress.emit(req.requestId, { kind: "finish" });
    }
    return true;
  }
}
