// ports/sub-llm — sub-LLM first-class 표면(Phase 3.2). main ProviderPort 와 직교하는
// 경량·배치용 서브 LLM. 소비처: 기억 사실추출·compaction(naia-memory 내부) + (전방) naia-adk 배치(Phase 5).
// config(memoryLlmProvider)로 구성 → buildSubLlmProvider 가 인스턴스화. 미구성(provider="none") = undefined(호출처 폴백).
// domain 만 의존(포트 원칙). I/O 0.
import type { ChatMessage } from "../domain/chat.js";

/** sub-LLM 배치 호출(비스트리밍). 경량 작업·adk-batch 용. main chat 스트림(ProviderPort)과 역할 분리. */
export interface SubLlmPort {
	/** 단일 prompt(또는 messages) → 완성 문자열. abort 수용. reject 전파(호출처가 폴백 결정). */
	complete(
		prompt: string,
		opts?: { readonly systemPrompt?: string; readonly signal?: AbortSignal },
	): Promise<string>;
	/** messages 시퀀스 → 완성 문자열(멀티턴 배치). */
	completeMessages(
		messages: readonly ChatMessage[],
		opts?: { readonly signal?: AbortSignal },
	): Promise<string>;
	/** 구성 진단(테스트·로그용). */
	readonly provider: string;
	readonly model?: string;
}
