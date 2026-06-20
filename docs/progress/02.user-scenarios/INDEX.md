# 02. 사용자 시나리오 Registry (UC) — V모델 02

<!--
스키마: 이 한 파일 registry. 추적: 모든 UC는 ≥1 REQ(01)에서 유도, ≥1 TEST-S(03)로 닫힌다 (orphan 0).
컬럼 = | ID | 영역 | 누가 → 무엇을 → 왜 | 유도 REQ | 상태 | TEST-S |
상세 = docs/user-scenarios.md. UC-### = 신 ID, 괄호 = 구 UC.
-->

> **이식 backfill (2026-06-15)**: agent 의 UC(UC1/UC5/provider-provenance + skill UC6/8/diagnostics)를 V모델로 정리.
> agent = os→agent gRPC 경계의 *에이전트 측* 책임(provider 호출·도구루프·skills). os 측 UC = `new-naia-os/docs/progress/02`.

## 사용자 시나리오

| ID | 영역 | 누가 → 무엇을 → 왜 | 유도 REQ | 상태 | TEST-S |
|---|---|---|---|---|---|
| UC-001 | 채팅 파이프라인 | 에이전트가 채팅 턴을 provider 호출 → wire 스트림으로 응답 (구 UC1) | REQ-001 | Done | TEST-S-001 |
| UC-005 | 도구루프/스킬 | 에이전트가 도구(toolUse)를 실행하고 결과를 스레딩해 최종 응답 (구 UC5; skills·cron·notify 포함) | REQ-002, REQ-005, REQ-008 | Done | TEST-S-005 |
| UC-003 | provider 출처 | 에이전트가 naia-settings/wire/키체인 기준으로 provider·키를 결정·추적 (구 UC-provider-provenance) | REQ-003 | Done | TEST-S-003 |
| UC-011 | 진단 | 에이전트가 자기 상태(rich health)를 gRPC Diagnostics 로 보고 | REQ-004 | Done | TEST-S-004 |
| UC-006 | 브라우저 | 에이전트가 브라우저를 조작(navigate/click/fill) (구 UC6) | REQ-006 | Done | TEST-S-006 |
| UC-008 | 유투브/BGM | 에이전트가 youtube BGM 을 검색/재생/볼륨 제어 (구 UC8) | REQ-007 | Done | TEST-S-008 |
| UC-012 | 대화 토큰예산 가드 | 사용자가 긴 대화를 이어가도 에이전트가 토큰예산으로 오래된 메시지를 **드롭**해 컨텍스트 초과 없이 응답 (요약형 compaction 아님 — 그건 UC-013) | REQ-009 | Done | TEST-S-012 |
| UC-013 | 대화 압축(요약) | 사용자가 긴 대화를 이어가도 에이전트가 오래된 맥락을 **버리지 않고 요약(recap)**해 유지하며 응답(naia-memory 위임, 정보보존). 요약은 장기기억에 영속돼 다음 세션에도 이어짐 | REQ-010 | Done | TEST-S-013 |

> **상태 의미**: agent 측 Done = 이식+2-AI(또는 self)리뷰+계약테스트 완료. UC-006/008 = agent-local skill 완료, 실 외부서비스(CDP/youtube) runtime = 루크머신. off-scope(UC-memory) = 01 노트.
