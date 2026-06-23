# 03. 시나리오 테스트 Registry (TEST-S) — V모델 03

<!--
스키마: 이 한 파일 registry. UC(02)·NFR(01)을 검증하는 시스템/인수/통합 테스트.
추적: 모든 UC는 ≥1 TEST-S로 닫힌다. TEST-S는 ≥1 UC 또는 NFR-REQ를 가리킨다(orphan 0).
컬럼 = | ID | 검증대상(UC/REQ) | 시나리오 요약 | 형태 | test_ref | 상태 |
-->

> **이식 backfill (2026-06-15)**: agent 통합/계약 테스트(`src/test/*`)를 시나리오 단위로 정리. (계약/유닛 상세 = 05 TEST-F)

## 시나리오 테스트

| ID | 검증대상(UC/REQ) | 시나리오 요약 | 형태 | test_ref | 상태 |
|---|---|---|---|---|---|
| TEST-S-001 | UC-001 | 채팅 턴 provider 호출→wire 스트림(ollama/openai-compat) end-to-end | 통합 | `src/test/uc1-agent.contract.test.ts`, `uc1-ollama-provider.contract.test.ts`, `uc1-openai-compat.contract.test.ts` | Pass |
| TEST-S-005 | UC-005 | 도구루프 stdio 통합(toolUse→실행→결과→최종) + skills | 통합 | `src/test/uc5-tool-loop-stdio.integration.test.ts`, `uc5-tool-loop.contract.test.ts`, `uc5-skills.contract.test.ts` | Pass |
| TEST-S-003 | UC-003, REQ-102 | provider 출처 라우팅 + 키체인 자격증명 + naia-settings store | 통합 | `src/test/uc-provider-provenance.contract.test.ts`, `uc-keychain-credentials.contract.test.ts`, `uc-naia-settings-store.contract.test.ts` | Pass |
| TEST-S-004 | UC-011 | Diagnostics RPC rich-health provider | 계약 | `src/test/diagnostics-provider.contract.test.ts` | Pass |
| TEST-S-006 | UC-006 | browser skill(cmd 화이트리스트·injected CLI) | 계약 | `src/test/uc6-browser-skill.contract.test.ts` | Pass |
| TEST-S-007 | UC-005 | cron/notify skill(schedule/list/cancel · webhook) | 계약 | `src/test/cron-skill.contract.test.ts`, `notify-skill.contract.test.ts` | Pass |
| TEST-S-008 | UC-008 | youtube BGM skill(search/play/volume) | 계약 | `src/test/uc8-bgm-skill.contract.test.ts` | Pass |
| TEST-S-012 | UC-012 | 토큰예산 대화 조립(예산내 유지/초과 절단/최신·systemPrompt 보존/고아 tool 가드/**원자 tool 라운드·toolCalls payload 예산**) 7케이스 | 계약 | `src/test/budgeted-conversation.contract.test.ts` | Pass |
| TEST-S-013 | UC-013 | compaction host-loop(예산초과→compact+recap systemPrompt 주입+tail만/**tail user경계 정렬**/attachHandoff 영속/임계이하 무압축/droppedCount0 원본/compact throw 드롭폴백/미주입 무회귀) 7케이스 | 계약 | `src/test/uc-compaction.contract.test.ts` | Pass |
| TEST-S-014 | UC-014 | 단독 CLI 오케스트레이션 — supervisor(이벤트 merge·terminal 1회·never-throws·session_end시 verify) + sub-agent 어댑터(pi/opencode/shell NDJSON→event·SIGTERM→SIGKILL·honest-unsupported) + roster(AC6) + 정직보고(verifier never-throws AC2·git classify) + composition wireSupervisor 조립 + 공유 머신(session_end 1회·64MiB/late 가드) | 계약/통합 | `src/test/uc-cli-supervisor.contract.test.ts`, `uc-cli-subagent-pi.contract.test.ts`, `uc-cli-subagent-opencode.contract.test.ts`, `uc-cli-subagent-roster.contract.test.ts`, `uc-cli-subagent-shell.contract.test.ts`, `subprocess-session.contract.test.ts`, `uc-cli-verifier.contract.test.ts`, `uc-cli-workspace.contract.test.ts`, `uc-cli-composition.contract.test.ts`, `uc-cli-supervisor-real-verifier.integration.test.ts` | Pass |
| TEST-S-101 | REQ-101 | 헥사고날 직교 — 도메인/ports/app 이 transport/adapter/메커니즘(child_process·git·net) 미import(레이어 방향 + 메커니즘 누수 0) | 계약 | `src/test/import-boundary.contract.test.ts` | Pass |

## 비고
- Pass = `npx vitest run` 기준(2026-06-23 agent 583 pass / 5 skip 확인). external(UC-006 CDP/UC-008 youtube) 실 서비스 runtime = 루크머신(계약·skill 로직만 자율 검증).
- off-scope UC-memory 테스트(`uc1-memory-stdio.integration.test.ts` 등)는 본 추적 제외(01 노트).
