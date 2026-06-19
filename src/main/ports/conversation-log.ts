// ports — ConversationLogPort (FR-CONV.1/5). turn 종료 시 verbatim 대화록을 세션 transcript 에 append.
// 전두엽(agent)이 자기 출력을 기록(brain-body-environment: 대화 = 뇌의 활동 → 뇌가 기록). 읽기는 shell(Rust IPC)·
// naia-memory 가 파일을 직접(직교, agent 독립 E1) — 이 포트는 *쓰기* 단일 writer 만 책임진다.
// 계약: append 는 **no-throw 격리** — 실패해도 turn/finish/메모리를 깨지 않는다(naia-memory.save 형제). transcript 누락 < 대화 중단.

/** 한 대화 turn(이 턴의 user 발화 + assistant 응답). 음향/시각 modality 필드는 Phase2(음성·노래) 예약(FR-CONV.5). */
export interface ConversationTurnRecord {
  readonly sessionId: string;
  readonly userText: string;
  readonly assistantText: string;
}

export interface ConversationLogPort {
  /** turn 후: 이 턴을 세션 transcript(`{conversations}/{sessionId}.jsonl`, 1줄=1메시지)에 append.
   *  **no-throw 격리**(실패 = 조용히 누락, turn/finish/memory 무영향 — FR-CONV.1). */
  append(turn: ConversationTurnRecord): Promise<void>;
}
