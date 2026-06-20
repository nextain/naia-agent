# 04. 기능 설계 Registry (SPEC) — V모델 04

<!--
스키마: 이 한 파일 registry. UC(02)→구현 기능(SPEC). 추적: SPEC→≥1 UC(역추적), ≥1 TEST-F(05)로 닫힘(orphan 0).
컬럼 = | ID | 유도 UC | 기능 요약 | area | 상태 | TEST-F |
마크다운은 SPEC 까지 — 아래 unit/함수 = 코드(src/main), 유닛테스트 = src/test(@spec 태그).
-->

> **이식 backfill (2026-06-15)**: agent 헥사고날 기능(provider 파이프라인·도구루프·skills·provenance·diagnostics)을 SPEC 으로 정리.

## 기능 설계

| ID | 유도 UC | 기능 요약 | area | 상태 | TEST-F |
|---|---|---|---|---|---|
| SPEC-001 | UC-001 | **UC1 수평 파이프라인** — provider 호출 → wire 스트림 + gRPC codec(uc1 필드 보존). ports/uc1·app·adapters | agent | Done | TEST-F-001 |
| SPEC-002 | UC-005 | **UC5 도구 실행 루프** — toolUse→실행→결과 스레딩→최종 + agent-local skills(ToolExecutor, injected dep: github/obsidian/memo/openmeteo/mcp/composite/approval/cron/notify) | agent | Done | TEST-F-002 |
| SPEC-003 | UC-003 | **provider provenance** — naia-settings/wire/키체인 라우팅 + 자격증명(키체인, stale clear) | agent | Done | TEST-F-003 |
| SPEC-004 | UC-011 | **Diagnostics RPC provider** — rich health(provider/연결/상태) gRPC | agent | Done | TEST-F-004 |
| SPEC-005 | UC-006 | **browser agent-local skill** — cmd 화이트리스트 + injected CLI(external CDP defer) | agent | Done | TEST-F-005 |
| SPEC-006 | UC-008 | **bgm agent-local skill** — youtube search/play/volume(external player defer) | agent | Done | TEST-F-006 |
| SPEC-007 | UC-012 | **budgeted conversation assembly** — ConversationPort 실구현(char≈token 휴리스틱 예산, systemPrompt 보존, 오래된 메시지 절단, 선두 고아 tool 결과 가드, 최신 1건 보존). `adapters/budgeted-conversation.ts` — passthrough 스텁 교체 | agent | Done | TEST-F-007 |

## 비고
- SPEC-002 = 도구루프 + 9개 agent-local skill 묶음(개별 skill = TEST-F-002 의 test_ref 군). external(브라우저 CDP·youtube)만 루크머신 runtime.
- off-scope: UC-memory 어댑터(`@nextain/naia-memory` 연동, ports/memory) = 본 추적 제외(다른 세션, 01 노트).
