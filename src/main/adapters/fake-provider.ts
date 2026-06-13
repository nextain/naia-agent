// adapters/fake-provider — 헤드리스 trace/테스트용 ProviderPort (LLM 불요).
// 카논 응답(text + finish) 스트림. 실 provider(ollama/openai/vllm)는 이식 소스 providers/ 에서 후속.
import type { ProviderPort, ProviderChatOpts } from "../ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../domain/chat.js";

export function makeFakeProvider(reply = "(fake) 안녕하세요, 나이아입니다."): ProviderPort {
  return {
    async *chat(_config: ProviderConfig, _messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      if (opts.signal?.aborted) return; // 시작 전 취소
      yield { kind: "text", text: reply };
      yield { kind: "usage", inputTokens: 5, outputTokens: 7 };
      yield { kind: "finish" };
    },
  };
}

/**
 * 헤드리스 e2e 용 — **systemPrompt 를 그대로 응답으로 echo**. recall→inject 가 실제로 systemPrompt 에
 * 회상을 넣었는지 wire text 로 관통 검증(실 진입점). LLM 불요.
 */
export function makeSystemEchoProvider(): ProviderPort {
  return {
    async *chat(_config: ProviderConfig, _messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      if (opts.signal?.aborted) return;
      yield { kind: "text", text: `SYSTEM_ECHO:${opts.systemPrompt ?? ""}` };
      yield { kind: "usage", inputTokens: 4, outputTokens: 4 };
      yield { kind: "finish" };
    },
  };
}

/**
 * UC5 헤드리스 도구 루프용 fake provider. 라운드 판별 = messages 에 tool 결과 메시지 유무.
 *  - 1라운드(도구결과 없음): toolUse(echo) + finish → agent 가 실행→threadToolRound.
 *  - 2라운드(도구결과 있음): 최종 text + finish.
 */
export function makeFakeToolProvider(opts?: { toolName?: string; toolArgs?: unknown; reply?: string }): ProviderPort {
  const toolName = opts?.toolName ?? "echo";
  const toolArgs = opts?.toolArgs ?? { text: "hello-from-tool" };
  const reply = opts?.reply ?? "(fake) 도구 결과를 반영한 최종 응답";
  return {
    async *chat(_config: ProviderConfig, messages: readonly ChatMessage[], options: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      if (options.signal?.aborted) return;
      const hasToolResult = messages.some((m) => m.role === "tool");
      if (!hasToolResult) {
        yield { kind: "toolUse", id: "call-1", name: toolName, args: toolArgs };
        yield { kind: "usage", inputTokens: 5, outputTokens: 3 };
        yield { kind: "finish" };
      } else {
        yield { kind: "text", text: reply };
        yield { kind: "usage", inputTokens: 8, outputTokens: 6 };
        yield { kind: "finish" };
      }
    },
  };
}
