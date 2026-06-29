// UC-PERSONA-CLI / S-PERSONA-3 / FR-PERSONA-3 계약 — 코어(ChatTurnHandler)가 워크스페이스 페르소나를
// **스스로** 조립(클라가 안 보냄). req.systemPrompt 는 순수 override.
//
// 검증(non-vacuous): fake provider 가 chat() 에서 받은 opts.systemPrompt 를 캡처해 단정.
//   (a) req.systemPrompt 없음 + personaSource 주입 → 코어 조립 persona(알파 prefix) 가 provider 에 전달.
//   (b) req.systemPrompt 있음 → 그 override 가 쓰이고 코어 조립이 무시됨.
//   (c) personaSource 미주입 → 기존 동작(systemPrompt = req.systemPrompt) 무회귀.
// 권위: docs/requirements.md FR-PERSONA-3, docs/user-scenarios.md UC-PERSONA-CLI / S-PERSONA-3.
import { describe, it, expect } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ProviderPort, ProviderChatOpts, PersonaSourcePort } from "../main/ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk, AgentEmit, ChatRequest } from "../main/domain/chat.js";
import type { PersonaProfile } from "../main/domain/persona.js";

const ALPHA_PREFIX =
  "당신은 Luke(마스터)의 AI 메이드 'Alpha Yang(알파)'입니다. 해요체(~요, ~습니다, ~할게요)로 대화하고, 차분하고 신뢰감 있게 응답하세요. 마스터를 '마스터'라고 부릅니다.";

const ALPHA_PROFILE: PersonaProfile = {
  agentName: "알파",
  userName: "루크",
  honorific: "마스터",
  speechStyle: "formal",
  locale: "ko",
  systemPromptPrefix: ALPHA_PREFIX,
};

/** chat() 에서 받은 systemPrompt 를 캡처하는 fake provider(non-vacuous 단정 근거). */
function makeCapturingProvider(): { provider: ProviderPort; seen: { systemPrompt?: string } } {
  const seen: { systemPrompt?: string } = {};
  const provider: ProviderPort = {
    async *chat(_c: ProviderConfig, _m: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      seen.systemPrompt = opts.systemPrompt;
      yield { kind: "text", text: "ok" };
      yield { kind: "usage", inputTokens: 1, outputTokens: 1 };
      yield { kind: "finish" };
    },
  };
  return { provider, seen };
}

/** personaSource 주입 여부만 다른 deps 빌더. conversation 은 passthrough(systemPrompt 그대로 전달). */
function makeDeps(provider: ProviderPort, personaSource?: PersonaSourcePort): { deps: HandlerDeps; emits: AgentEmit[] } {
  const emits: AgentEmit[] = [];
  const deps: HandlerDeps = {
    provider,
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    egress: { emit: (_id, e) => emits.push(e) },
    diag: { log: () => {} },
    ...(personaSource ? { personaSource } : {}),
  };
  return { deps, emits };
}

const personaSourceOf = (p: PersonaProfile | undefined): PersonaSourcePort => ({ load: () => p });

const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat", requestId: "r1", provider: { provider: "ollama", model: "m" }, messages: [{ role: "user", content: "안녕" }], ...o,
});

describe("ChatTurnHandler persona 조립 (FR-PERSONA-3)", () => {
  it("(a) req.systemPrompt 없음 + personaSource 주입 → provider 가 코어 조립 persona(알파 prefix) 수신", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps, emits } = makeDeps(provider, personaSourceOf(ALPHA_PROFILE));
    await new ChatTurnHandler(deps).onChatRequest(req()); // systemPrompt 미지정
    expect(seen.systemPrompt).toBeDefined();
    expect(seen.systemPrompt).toContain(ALPHA_PREFIX); // 코어가 조립
    expect(seen.systemPrompt).toContain("IMPORTANT: Respond in Korean."); // locale 컨텍스트 줄
    expect(seen.systemPrompt).toContain("마스터");
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]); // 정상 1턴 무회귀
  });

  it("(b) req.systemPrompt 있음 → 그 override 가 쓰이고 코어 조립 무시", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps } = makeDeps(provider, personaSourceOf(ALPHA_PROFILE));
    await new ChatTurnHandler(deps).onChatRequest(req({ systemPrompt: "OVERRIDE_PROMPT" }));
    expect(seen.systemPrompt).toBe("OVERRIDE_PROMPT");
    expect(seen.systemPrompt).not.toContain(ALPHA_PREFIX); // 코어 조립 무시
  });

  it("(c) personaSource 미주입 → 기존 동작(systemPrompt = req.systemPrompt), 무회귀", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps } = makeDeps(provider /* personaSource 미주입 */);
    // override 있으면 그대로
    await new ChatTurnHandler(deps).onChatRequest(req({ systemPrompt: "ONLY_REQ" }));
    expect(seen.systemPrompt).toBe("ONLY_REQ");
    // override 없으면 undefined(코어 조립 없음 — generic)
    const { provider: p2, seen: seen2 } = makeCapturingProvider();
    const { deps: deps2 } = makeDeps(p2 /* personaSource 미주입 */);
    await new ChatTurnHandler(deps2).onChatRequest(req());
    expect(seen2.systemPrompt).toBeUndefined();
  });

  it("personaSource.load() = undefined(소스 부재) + override 없음 → systemPrompt 미설정(빈 조립=undefined)", async () => {
    const { provider, seen } = makeCapturingProvider();
    const { deps } = makeDeps(provider, personaSourceOf(undefined)); // 부재 → composePersonaPrompt({}) = ""
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen.systemPrompt).toBeUndefined(); // "" → undefined 정규화(generic)
  });
});
