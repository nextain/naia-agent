// ports/sub-llm — sub-LLM first-class 표면(Phase 3.2). main ProviderPort 와 직교하는
// 경량·배치용 서브 LLM. 소비처: 기억 사실추출·compaction(naia-memory 내부) + (전방) naia-adk 배치(Phase 5).
// 독립 sub 역할 config로 구성 → buildSubLlmProvider 가 인스턴스화. memory 역할 설정과 공유하지 않는다.
// domain 만 의존(포트 원칙). I/O 0.
import type { ChatMessage } from "../domain/chat.js";

export interface SubLlmCallOptions {
	readonly signal?: AbortSignal;
	/**
	 * 호출 컨텍스트가 신뢰된 분류와 사용자 공개 고지를 완료한 뒤 true를 반환한다.
	 * 프로세스 전역 권한으로 재사용하지 않고 실제 외부 전송마다 전달한다.
	 */
	readonly authorizeAndDisclose?: (input: {
		readonly workload: "sub_llm";
		readonly provider: string;
		readonly model: string;
		readonly endpoint: string;
	}) => Promise<boolean>;
}

/** sub-LLM 배치 호출(비스트리밍). 경량 작업·adk-batch 용. main chat 스트림(ProviderPort)과 역할 분리. */
export interface SubLlmPort {
	/** 단일 prompt(또는 messages) → 완성 문자열. abort 수용. reject 전파(호출처가 폴백 결정). */
	complete(
		prompt: string,
		opts?: SubLlmCallOptions & { readonly systemPrompt?: string },
	): Promise<string>;
	/** messages 시퀀스 → 완성 문자열(멀티턴 배치). */
	completeMessages(
		messages: readonly ChatMessage[],
		opts?: SubLlmCallOptions,
	): Promise<string>;
	/** 구성 진단(테스트·로그용). */
	readonly provider: string;
	readonly model?: string;
}
