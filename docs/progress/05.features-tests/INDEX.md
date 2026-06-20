# 05. 기능 테스트 Registry (TEST-F) — V모델 05

<!--
스키마: 이 한 파일 registry. SPEC(04)→통합/계약/유닛 테스트. 추적: SPEC→≥1 TEST-F, TEST-F→≥1 SPEC(orphan 0).
컬럼 = | ID | 검증 SPEC | 테스트 요약 | test_ref | 상태 |
코드 = src/test(vitest). 유닛테스트 @spec SPEC-### 태그 결속.
-->

> **이식 backfill (2026-06-15)**: agent `src/test/*.{contract,integration}.test.ts` 를 SPEC 별로 정리. (`npx vitest run` 269 cases pass, 2026-06-15)

## 기능 테스트

| ID | 검증 SPEC | 테스트 요약 | test_ref | 상태 |
|---|---|---|---|---|
| TEST-F-001 | SPEC-001 | UC1 agent 파이프라인 + provider(ollama/openai-compat) + gRPC codec 필드 보존 | `src/test/uc1-agent.contract.test.ts`, `uc1-ollama-provider.contract.test.ts`, `uc1-openai-compat.contract.test.ts`, `grpc-codec-uc1-fields.contract.test.ts` | Pass |
| TEST-F-002 | SPEC-002 | UC5 도구루프(contract+stdio integration) + skills(github/obsidian/memo/openmeteo/mcp/composite/approval) + cron/notify | `src/test/uc5-tool-loop.contract.test.ts`, `uc5-tool-loop-stdio.integration.test.ts`, `uc5-skills.contract.test.ts`, `uc5-github.contract.test.ts`, `uc5-obsidian.contract.test.ts`, `uc5-file-memo.contract.test.ts`, `uc5-openmeteo.contract.test.ts`, `uc5-mcp.contract.test.ts`, `uc5-mcp-transport.contract.test.ts`, `uc5-composite.contract.test.ts`, `uc5-approval.contract.test.ts`, `cron-skill.contract.test.ts`, `notify-skill.contract.test.ts` | Pass |
| TEST-F-003 | SPEC-003 | provider provenance + 키체인 자격증명 + naia-settings store 계약 | `src/test/uc-provider-provenance.contract.test.ts`, `uc-keychain-credentials.contract.test.ts`, `uc-naia-settings-store.contract.test.ts` | Pass |
| TEST-F-004 | SPEC-004 | Diagnostics RPC provider(rich health) 계약 | `src/test/diagnostics-provider.contract.test.ts` | Pass |
| TEST-F-005 | SPEC-005 | browser skill(cmd 화이트리스트·injected CLI) 계약 | `src/test/uc6-browser-skill.contract.test.ts` | Pass |
| TEST-F-006 | SPEC-006 | bgm skill(search/play/volume) 계약 | `src/test/uc8-bgm-skill.contract.test.ts` | Pass |
| TEST-F-007 | SPEC-007 | budgeted conversation(예산내 유지/초과 절단/최신·systemPrompt 보존/선두 고아 tool 가드) 계약 5케이스 | `src/test/budgeted-conversation.contract.test.ts` | Pass |

## 비고
- off-scope UC-memory 테스트(`uc1-memory-stdio.integration.test.ts`, `uc1-memory-process.integration.test.ts`)는 본 추적 제외(01 노트). agent 전체 vitest 에는 포함(269 cases).
- 유닛테스트 깊이: 마크다운은 TEST-F(통합/계약)까지. `@spec SPEC-###` 태그 backfill = 후속.
