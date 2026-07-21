import { describe, expect, it, vi } from "vitest";
import { ExhibitionIntroController } from "../main/app/exhibition-intro-controller.js";
import { PersonalRadioDjController } from "../main/app/personal-radio-dj-controller.js";
import { SpeechProfileRuntime } from "../main/app/speech-profile-runtime.js";
import { wireAgentUC1 } from "../main/composition/index.js";
import type { AgentEmit, AgentRequest } from "../main/domain/chat.js";
import type { AgentIngressPort } from "../main/ports/uc1.js";

describe("EX-06 profile-bound Q&A privacy integration", () => {
  it("accepts explicit DJ preference and mood commands without ordinary memory or provider calls", async () => {
    const dj = {
      configure: vi.fn(),
      setSubscriberReady: vi.fn(),
      recordExplicitPreference: vi.fn(async () => undefined),
      recordExplicitMood: vi.fn(),
    };
    const profiles = new SpeechProfileRuntime({
      dj: dj as never,
      exhibition: { configure: vi.fn(), setSubscriberReady: vi.fn() } as never,
      chatEgress: { emit: vi.fn() },
    });
    profiles.configure({
      kind: "personal_radio_dj",
      config: {
        sessionId: "s1",
        idleMs: 1,
        djIntervalMs: 1,
        timezone: "UTC",
        bgmAutoPlayOptIn: true,
      },
    });
    let route: ((request: AgentRequest) => void) | undefined;
    const memory = {
      recall: vi.fn(async () => ({ facts: [], episodes: [] })),
      save: vi.fn(async () => undefined),
    };
    const conversationLog = { append: vi.fn(async () => undefined) };
    const providerCalls = vi.fn();
    const wired = wireAgentUC1({
      ingress: { onRequest: (cb) => { route = cb; return () => {}; } },
      egress: { emit: vi.fn() },
      speechProfiles: profiles,
      provider: {
        chat: async function* () {
          providerCalls();
          yield { kind: "text" as const, text: "ordinary" };
          yield { kind: "finish" as const };
        },
      },
      memory,
      conversationLog,
    });
    wired.start?.();
    const commands = [
      ["DJ 좋아요: 재즈", "like"],
      ["DJ 싫어요: 트로트", "dislike"],
      ["DJ 취향 삭제: 재즈", "forget"],
      ["DJ 상태: 집중해서 문서를 쓰는 중", "mood"],
    ] as const;
    for (const [content] of commands) {
      route?.({
        kind: "chat",
        requestId: `r${content.length}`,
        sessionId: "s1",
        messages: [{ role: "user", content }],
      });
    }
    await wired.drain?.();
    expect(dj.recordExplicitPreference).toHaveBeenCalledTimes(3);
    expect(dj.recordExplicitMood).toHaveBeenCalledTimes(1);
    expect(memory.recall).not.toHaveBeenCalled();
    expect(memory.save).not.toHaveBeenCalled();
    expect(conversationLog.append).not.toHaveBeenCalled();
    expect(providerCalls).not.toHaveBeenCalled();

    route?.({
      kind: "chat",
      requestId: "ordinary",
      sessionId: "s1",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "DJ 좋아요 재즈" }],
    });
    await wired.drain?.();
    expect(providerCalls).toHaveBeenCalledTimes(1);
    expect(memory.recall).toHaveBeenCalledTimes(1);
    expect(memory.save).toHaveBeenCalledTimes(1);
    expect(conversationLog.append).toHaveBeenCalled();
    expect(dj.recordExplicitPreference).toHaveBeenCalledTimes(3);

    for (const content of ["DJ 좋아요:", `DJ 상태: ${"가".repeat(501)}`]) {
      route?.({
        kind: "chat",
        requestId: `invalid-${content.length}`,
        sessionId: "s1",
        provider: { provider: "fake", model: "m" },
        messages: [{ role: "user", content }],
      });
    }
    await wired.drain?.();
    expect(dj.recordExplicitPreference).toHaveBeenCalledTimes(3);
    expect(dj.recordExplicitMood).toHaveBeenCalledTimes(1);
    expect(providerCalls).toHaveBeenCalledTimes(3);
    route?.({
      kind: "chat",
      requestId: "wrong-session",
      sessionId: "s2",
      provider: { provider: "fake", model: "m" },
      messages: [{ role: "user", content: "DJ 좋아요: 클래식" }],
    });
    await wired.drain?.();
    expect(dj.recordExplicitPreference).toHaveBeenCalledTimes(3);
    expect(providerCalls).toHaveBeenCalledTimes(4);
  });

  it("구독이 profile configure보다 먼저 열려도 controller를 ready로 만든다", () => {
    const dj = { configure: vi.fn(), setSubscriberReady: vi.fn() };
    const exhibition = { configure: vi.fn(), setSubscriberReady: vi.fn() };
    const profiles = new SpeechProfileRuntime({
      dj: dj as never,
      exhibition: exhibition as never,
      chatEgress: { emit: vi.fn() },
    });
    profiles.subscriberChanged("agent:main:main", true);
    profiles.configure({
      kind: "personal_radio_dj",
      config: {
        sessionId: "agent:main:main",
        idleMs: 1,
        djIntervalMs: 1,
        timezone: "Asia/Seoul",
        bgmAutoPlayOptIn: true,
      },
    });
    expect(dj.setSubscriberReady).toHaveBeenCalledWith(true);
  });

  it("PA-EX-01/02 routes a yielded question to grounded KB with memory and transcript off", async () => {
    let route: ((request: AgentRequest) => void) | undefined;
    const ingress: AgentIngressPort = {
      onRequest: (cb) => { route = cb; return () => {}; },
    };
    const emitted: AgentEmit[] = [];
    const egress = { emit: (_requestId: string, event: AgentEmit) => { emitted.push(event); } };
    const memory = { recall: vi.fn(), save: vi.fn() };
    const conversationLog = { append: vi.fn() };
    const noopSpeech = {
      open: vi.fn(),
      speak: vi.fn(async () => "completed" as const),
      interrupt: vi.fn(),
      close: vi.fn(),
    };
    let scheduled: (() => void | Promise<void>) | undefined;
    const exhibition = new ExhibitionIntroController({
      scheduler: {
        now: () => 0,
        schedule: (_delay, run) => { scheduled = run; return () => {}; },
      },
      ids: { activity: () => "a1", resumeToken: () => "token-1" },
      knowledge: {
        ready: () => true,
        listIntroItems: async () => [{ itemId: "i1", text: "소개", sourceUris: ["kb://intro"] }],
        answer: async () => ({
          abstained: false,
          answer: "KB에 근거한 답변입니다.",
          sources: ["kb://answer"],
        }),
      },
      speech: noopSpeech,
    });
    const dj = new PersonalRadioDjController({
      scheduler: { now: () => 0, schedule: () => () => {} },
      ids: { next: () => "dj" },
      context: {
        snapshot: async () => ({
          localTime: { iso: "2026-07-18T00:00:00.000Z", timezone: "UTC", source: "configured" },
          preferences: [],
        }),
      },
      selector: { select: async () => ({ query: "x", reason: "generic" }) },
      bgm: {
        capabilities: () => ({ ready: false, next: false }),
        searchAndPlay: async () => ({ ok: false, reason: "off" }),
        next: async () => ({ ok: false, reason: "off" }),
        stop: async () => ({ ok: true }),
        status: async () => undefined,
      },
      speech: noopSpeech,
      preferences: { handoff: async () => {} },
    });
    const profiles = new SpeechProfileRuntime({ dj, exhibition, chatEgress: egress });
    profiles.configure({
      kind: "exhibition_intro",
      config: {
        sessionId: "expo",
        knowledgeScope: "scope",
        idleMs: 1,
        introIntervalMs: 1,
      },
    });
    profiles.subscriberChanged("expo", true);
    await scheduled?.(); // idle start → activity open, intro timer는 아직 실행하지 않음
    const activityId = exhibition.currentActivityId()!;
    const yielded = profiles.yield("expo", activityId);
    expect(yielded.ok).toBe(true);
    const activeBinding = yielded.binding!;

    const wired = wireAgentUC1({
      ingress,
      egress,
      speechProfiles: profiles,
      memory,
      conversationLog,
    });
    wired.start?.();
    route?.({
      kind: "chat",
      requestId: "q1",
      sessionId: "expo",
      messages: [{ role: "user", content: "Naia가 무엇인가요?" }],
      activityResume: {
        activityId: activeBinding.activityId,
        profileGeneration: activeBinding.profileGeneration,
        yieldGeneration: activeBinding.yieldGeneration,
        resumeToken: activeBinding.resumeToken,
      },
    });
    await wired.drain?.();

    expect(memory.recall).not.toHaveBeenCalled();
    expect(memory.save).not.toHaveBeenCalled();
    expect(conversationLog.append).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      { kind: "text", text: "KB에 근거한 답변입니다." },
      { kind: "usage", inputTokens: 0, outputTokens: 0, cost: 0, model: "exhibition-kb" },
      { kind: "finish" },
    ]);
  });
});
