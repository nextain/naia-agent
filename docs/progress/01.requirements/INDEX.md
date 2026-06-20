# 01. 요구사항 Registry (REQ) — V모델 01

<!--
스키마: 이 한 파일 registry. 상태 = Draft→Approved→In-progress→Done.
추적: 모든 REQ는 ≥1 UC(02)로 닫히거나, NFR이면 ≥1 TEST-S(03)로 직결한다 (orphan 0).
컬럼 = | ID | 영역 | 요구사항 | 상태 | UC | SPEC | TEST |
scripts/check-traceability.mjs 가 파싱. 상세 = docs/requirements.md, 99.dev-comm/.
-->

> **이식 backfill (2026-06-15)**: new-naia-agent(허브 런타임 — provider·도구·skills) 작업을 V모델로 회귀 정리.
> 상태 = 실제 이식+리뷰+테스트 현황. ⚠️ **UC-memory(FR-MEM-1~10)=off-scope**(다른 세션 소유, canon out_of_scope) — 아래 별도 노트, 추적 체인 제외.

## 기능 요구사항 (REQ)

| ID | 영역 | 요구사항 | 상태 | UC | SPEC | TEST |
|---|---|---|---|---|---|---|
| REQ-001 | 대화 파이프라인 | 채팅 턴 = **provider 호출 → wire 스트림**(에이전트 수평 파이프라인) | Done | UC-001 | SPEC-001 | TEST-S-001 |
| REQ-002 | 도구루프 | **toolUse → 실행 → 결과 스레딩 → 최종 응답**(도구 실행 루프) | Done | UC-005 | SPEC-002 | TEST-S-005 |
| REQ-003 | provider 출처 | **provider 라우팅 출처**(naia-settings/wire/키체인 기준 provider·키 결정) | Done | UC-003 | SPEC-003 | TEST-S-003 |
| REQ-004 | 진단 | **gRPC Diagnostics RPC**(rich health: provider/연결/상태) | Done | UC-011 | SPEC-004 | TEST-S-004 |
| REQ-005 | 스킬-도구 | agent-local **skills**(time·weather·memo·github·obsidian·mcp) — injected 외부dep | Done | UC-005 | SPEC-002 | TEST-S-005 |
| REQ-006 | 스킬-브라우저 | **browser 조작 skill**(cmd 화이트리스트 + injected CLI) — external runtime defer | Done | UC-006 | SPEC-005 | TEST-S-006 |
| REQ-007 | 스킬-BGM | **youtube BGM skill**(search/play/volume) — external runtime defer | Done | UC-008 | SPEC-006 | TEST-S-008 |
| REQ-008 | 스킬-cron/notify | **예약작업/알림 skill**(schedule·list·cancel / slack·discord·google_chat) — external defer | Done | UC-005 | SPEC-002 | TEST-S-007 |
| REQ-009 | 대화 토큰예산 가드 | **턴 조립 토큰예산 가드(드롭형)** — ConversationPort 가 systemPrompt 보존 + 최근 메시지 우선으로 토큰예산 내 조립, 오래된 메시지 **드롭**(요약 아님; 고아 tool 가드·tool 라운드 원자·최신 보존). ⚠️정보보존형 compaction(요약)=naia-memory.compact(), agent 위임 미배선(→ agent#3) | Done | UC-012 | SPEC-007 | TEST-S-012 |

## 비기능 요구사항 (NFR → REQ)

| ID | 영역 | 요구사항 | 상태 | UC | SPEC | TEST |
|---|---|---|---|---|---|---|
| REQ-101 | NFR-기반 | substrate-agnostic 포트(core 도메인은 transport 무지) + 헥사고날 직교 | In-progress | — | — | TEST-S-101 |
| REQ-102 | NFR-보안 | 키체인 자격증명(secret 평문 미보존) + provider 전환 시 stale 키 clear | Done | — | — | TEST-S-003 |

## off-scope 노트 (추적 체인 제외)
- **UC-memory (FR-MEM-1~10)**: 턴 recall 주입/save(naia-memory 연동). ⚠️정정(2026-06-21, 교차검증): `feat/memory-wiring` 브랜치는 **존재하지 않음** — 코드+테스트가 **main에 배선·기본 활성**이다(진입점 `scripts/builds/agent-stdio-entry.mjs` 기본 주입, `memory-orthogonality.contract` 6/6 · `uc1-memory-stdio` 29/31 pass). 즉 **기능은 main DONE**(agent#4 closed). 본 노트의 "off-scope"는 *V모델 추적*에서만 제외라는 의미(루크 우선순위 ⑧). V모델 정식 backfill(REQ/UC/SPEC/TEST 편입) 여부는 미결. 상세 = `99.dev-comm/UC-memory-recall-save-contract-2026-06-12.md`.
