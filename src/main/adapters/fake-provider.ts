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
