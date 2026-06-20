// ports — CompactionPort (UC-compaction / FR-COMPACT). 예산 압박 시 대화 head 를 *정보보존형*으로
// 압축한다: naia-memory.compact() 가 head 를 recap(요약)으로 만들고, recap+anchors 를 장기기억에
// 영속(attachHandoff)한다. budgeted-conversation(드롭형)은 *최종 하드 가드/폴백* — 이 포트는 그보다
// 먼저 동작하는 요약형 압축이다. 구현 = adapters/naia-memory.ts(같은 MemorySystem 위임). 미주입 = 압축
// 없음(무회귀: budgeted-conversation 드롭만).
import type { ChatMessage } from "../domain/chat.js";

/** 압축 요청 — 최근 keepTail 개는 원문 유지, 그 앞(head)을 targetTokens 예산의 recap 으로 요약. */
export interface CompactionRequest {
  readonly messages: readonly ChatMessage[];
  readonly keepTail: number;
  readonly targetTokens: number;
}

/** 압축 결과 — recap(head 요약 텍스트, systemPrompt 에 주입) + droppedCount(요약에 흡수된 메시지 수).
 *  droppedCount 0 = 압축 미수행(호출측은 원본 유지). */
export interface CompactionResult {
  readonly recap: string;
  readonly droppedCount: number;
}

/** 장기기억 영속 blob — recap + anchors(식별자: 주문번호·파일경로·URL 등). cross-session 연속성용. */
export interface HandoffBlob {
  readonly sessionId: string;
  readonly recap: string;
  readonly anchors: readonly string[];
  readonly trigger: string;   // 예: "budget"
  readonly turnCount: number;
  readonly totalTokens: number;
}

export interface CompactionPort {
  /** 예산 내로 head 를 요약 — recap + droppedCount 반환. naia-memory.compact() 위임. */
  compact(req: CompactionRequest): Promise<CompactionResult>;
  /** recap + anchors 를 장기기억에 영속(cross-session). naia-memory.attachHandoff() 위임. 호출측은
   *  no-throw(fire-and-forget) 로 다루지만, 구현도 내부 실패를 격리하는 게 바람직. */
  attachHandoff(blob: HandoffBlob): Promise<void>;
}
