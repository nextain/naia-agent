// chat-repeat regression (0.2.4 mission 2026-10-27) — 도구 반복 턴의 되풀이 방지.
// 가짜 모델 순서: 글 A → 도구 호출 → 결과 → 글 B(이모지 종결 완성 문장).
// - 셸로 나가는 text 조각을 이어 붙이면 A+B 가 한 번씩만 나와야 한다(몰래 3번째 호출 C 금지).
// - 두 번째 모델 호출 입력에 A(assistant 글+toolCalls)와 도구 결과가 들어 있어야 한다.
import { describe, it, expect } from "vitest";
import { isLikelyIncompleteDeepSeekFinal, ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { AgentEmit, ChatMessage, ChatRequest, ProviderChunk } from "../main/domain/chat.js";
import type { CredentialPort } from "../main/ports/uc1.js";

/** composition root 없이 — 외부 의존 없이 돌도록 최소 인메모리 credential store. */
function makeInMemoryCredentials(): CredentialPort {
  const store = new Map<string, { apiKey?: string; naiaKey?: string }>();
  return {
    update: (provider, secret) => { store.set(provider, secret); },
    get: (provider) => store.get(provider),
  };
}
import type { ProviderPort } from "../main/ports/uc1.js";

const TEXT_A = "아침 시간이네요, 마스터~ ☀️\n\n🎵 Summer Morning Jazz — 지금 재생 중이에요! ☀️";
const TEXT_B = "원하시면 볼륨 조절이나 다른 장르로 바꿔드릴 수도 있어요. 지금은 Summer Morning Jazz가 흐르고 있어요 ☀️☕";
const TEXT_C = "CONTINUATION-MARKER 이어서: 첫 곡은 Summer Morning Jazz로 따뜻하게 시작하고 있어요.";

/** 호출별 입력 메시지를 기록하는 각본형 가짜 provider. 3번째 호출이 오면 C를 내보낸다(오면 안 됨). */
function makeScriptedRepeatProvider(seen: ChatMessage[][]): ProviderPort {
  return {
    async *chat(_config: unknown, messages: readonly ChatMessage[], opts: { signal?: AbortSignal }): AsyncIterable<ProviderChunk> {
      seen.push([...messages]);
      if (opts.signal?.aborted) return;
      const round = seen.length;
      if (round === 1) {
        yield { kind: "text", text: TEXT_A };
        yield { kind: "toolUse", id: "call-1", name: "music_tool", args: { query: "morning jazz" } };
        yield { kind: "usage", inputTokens: 10, outputTokens: 5 };
        yield { kind: "finish" };
      } else if (round === 2) {
        yield { kind: "text", text: TEXT_B };
        yield { kind: "usage", inputTokens: 20, outputTokens: 8 };
        yield { kind: "finish" };
      } else {
        yield { kind: "text", text: TEXT_C };
        yield { kind: "usage", inputTokens: 30, outputTokens: 8 };
        yield { kind: "finish" };
      }
    },
  };
}

function capture(seen: ChatMessage[][]) {
  const emits: { requestId: string; e: AgentEmit }[] = [];
  const deps: HandlerDeps = {
    provider: makeScriptedRepeatProvider(seen),
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    toolExecutor: {
      specs: () => [{ name: "music_tool", description: "test music tool", parameters: { type: "object", properties: {} } }],
      execute: async () => ({ output: "재생: Summer Morning Jazz (vid123)" }),
    },
    egress: { emit: (requestId, e) => emits.push({ requestId, e }) },
    diag: { log: () => {} },
  };
  return { deps, emits };
}

const req = (): ChatRequest => ({
  kind: "chat",
  requestId: "repeat-r1",
  provider: { provider: "nextain", model: "deepseek-v4-flash" },
  messages: [{ role: "user", content: "아침 음악 틀어줘" }],
});

describe("chat-repeat: 도구 반복 턴 되풀이 방지", () => {
  it("완성된 이모지 종결 최종답에 몰래 3번째 호출을 하지 않는다 (셸 텍스트 = A+B 1회씩)", async () => {
    const seen: ChatMessage[][] = [];
    const { deps, emits } = capture(seen);
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(seen.length).toBe(2);
    const shellText = emits.filter((r) => r.e.kind === "text").map((r) => (r.e as { text: string }).text).join("");
    expect(shellText).toBe(TEXT_A + TEXT_B);
  });

  it("두 번째 모델 호출 입력에 첫 글 A(assistant+toolCalls)와 도구 결과가 들어 있다", async () => {
    const seen: ChatMessage[][] = [];
    const { deps } = capture(seen);
    await new ChatTurnHandler(deps).onChatRequest(req());
    const second = seen[1] ?? [];
    const assistant = second.find((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0);
    expect(assistant?.content).toBe(TEXT_A);
    expect(assistant?.toolCalls?.[0]?.name).toBe("music_tool");
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("재생: Summer Morning Jazz");
  });
});

describe("isLikelyIncompleteDeepSeekFinal: 이모지·장식 종결 완성문", () => {
  it.each([
    "첫 곡은 Summer Morning Jazz로 따뜻하게 시작하고 있어요 ☀️☕",
    "알파가 배경음악을 책임질게요. ｡•ᴗ•｡☕",
    "지금 재생 중이에요! ✨",
    "느긋하게 즐겨주세요 📻",
    "Done! 🎉",
    "확인했어요~",
  ])("완성으로 본다: %j", (text) => {
    expect(isLikelyIncompleteDeepSeekFinal(text)).toBe(false);
  });

  it.each([
    "노래는건",
    "지금 틀어드릴 곡은건",
  ])("잘림으로 본다: %j", (text) => {
    expect(isLikelyIncompleteDeepSeekFinal(text)).toBe(true);
  });
});
