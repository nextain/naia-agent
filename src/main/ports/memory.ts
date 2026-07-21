// ports — MemoryPort (UC-memory 계약 FR-MEM-1·2). 턴 전 recall / 턴 후 save.
// 포트는 *데이터*만: recall 은 비신뢰 회상 원문(RecalledMemory)을 반환하고, 프롬프트 프레이밍·예산
// 절단은 domain formatRecalledMemory 가 강제한다(헥사고날: adapter 는 프롬프트 표현/신뢰 정책을 소유하지
// 않음). domain/app 은 이 인터페이스에만 의존, 구현(@nextain/naia-memory)은 adapters 에.
import type { RecalledMemory } from "../domain/memory.js";

/**
 * MemoryPort — 턴 전 recall / 턴 후 save.
 * **동시성 계약(호출 안전 + 최종 수렴)**: 핸들러는 여러 requestId 의 턴을 동시 처리하므로 한 인스턴스에
 * recall/save 가 병렬 호출될 수 있다. 구현체는 **호출 안전**해야 한다(동시 호출에 저장 유실·버퍼/상태
 * 손상·크래시 없음).
 * - **read-your-writes(필수)**: `save()` 가 resolve 된 *뒤* 같은 인스턴스에 시작하는 recall 은 그 save 를
 *   본다(UC-MEM-1 의 직전 턴 freshness 근거). LocalAdapter 는 encode 가 in-memory 상태를 동기 갱신해 만족.
 * - **부분 가시성(허용)**: save 는 user/assistant 2-encode 라 *진행 중*(아직 resolve 전) 상태를 동시 recall
 *   이 중간(예: user 만)으로 볼 수 있다(턴 단위 원자성 미보장). resolve 후엔 read-your-writes 로 수렴.
 * 더 강한 원자성/직렬화가 필요하면 app/adapter 경계에 큐를 둬야 한다.
 */
export interface MemoryPort {
  /** 턴 전: query(이 턴의 새 user 입력)로 장기기억을 회상해 비신뢰 **bounded excerpt**(facts/episodes)을
   *  반환. 거대 항목은 상한 절단되며 그 경우 절단 표식(…[절단됨])을 보존한다 — 소비자가 불완전 발췌를
   *  원문으로 오인하지 않게(무표식 절단은 후반 조건/부정을 소리없이 잘라 의미 반전 위험). 회상 결과가
   *  없으면 빈 facts/episodes — 호출부(domain formatter)가 빈 블록("")으로 처리. 빈/공백 query 는 빈 결과. */
  recall(query: string): Promise<RecalledMemory>;

  /** 턴 후: 그 턴의 user 발화 + assistant 응답을 장기기억에 저장. */
  save(
    userText: string,
    assistantText: string,
    opts?: { idempotencyKey?: string; durable?: boolean },
  ): Promise<void>;
}

/** lifecycle 을 가진 MemoryPort — 진입점이 종료 시 flush 를 위해 close() 를 호출한다(FR-MEM-6). 핸들러는
 *  MemoryPort 만 의존(close 안 씀); 소유·종료 책임은 composition/진입점에 있다. factory 는 이걸 반환. */
export interface ManagedMemoryPort extends MemoryPort {
  close(): Promise<void>;
}
