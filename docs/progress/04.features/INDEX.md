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
| SPEC-007 | UC-012 | **budgeted conversation assembly (드롭형 토큰예산 가드)** — ConversationPort 실구현(char≈token 휴리스틱 예산, systemPrompt 보존, 오래된 메시지 **드롭**, **tool 라운드 원자 블록**=assistant+tool 동시 보존, **toolCalls payload 예산 계산**, 선두 고아 tool 가드, 최신 블록 보존). `adapters/budgeted-conversation.ts` — passthrough 스텁 교체. ⚠️요약 아닌 드롭형 가드 — 정보보존형은 SPEC-008 | agent | Done | TEST-F-007 |
| SPEC-008 | UC-013 | **compaction host-loop (정보보존형)** — `ports/compaction.ts`(CompactionPort) + `adapters/naia-memory`(compact/attachHandoff 위임, ManagedMemoryPort&CompactionPort) + `app/chat-turn-handler.maybeCompact`(assemble 전 예산 초과 시 `memory.compact()` head 요약→systemPrompt 주입, 메시지 tail, `attachHandoff` 영속). provider-safe(recap=systemPrompt + **tail user경계 정렬**, leading assistant/tool 400 회피)·no-throw·deadline·무회귀. 진입점 `compaction: memory` 주입. 적대 크로스리뷰 통과(돌연변이 5·엣지 12 probe·갭1 수정) | agent | Done | TEST-F-008 |
| SPEC-009 | UC-014 | **오케스트레이션 코어** — `domain/orchestration.ts`(semantic 타입) + `ports/orchestration.ts`(SubAgentPort·WorkspacePort·VerifierPort·SupervisorEgressPort, 메커니즘 0) + `app/supervisor.ts`(Supervisor: spawn→이벤트 forward·mergeStreams→session_end시 verify→정직보고 1회; 불변식 I1 terminal·AC2 never-throws·AC4 항상 verify) + `composition/wireSupervisor`(조립). 적대 게이트(내부+codex) 통과 — merge-loop reject 흡수·abort 리스너 청결 수정 | agent | Done | TEST-F-009 |
| SPEC-010 | UC-014 | **오케스트레이션 어댑터(메커니즘)** — `subprocess-session.ts`(공유 머신: stdout 줄→이벤트·session_end 1회·SIGTERM→500ms→SIGKILL·64MiB/late/lineToEvent-throw 가드) + `subagent-{pi,opencode-cli,shell,roster}.ts`(NDJSON→event·bin resolve·honest-unsupported AC6) + `verifier-commands.ts`(never-throws AC2 러너) + `workspace-git.ts`(git porcelain 폴링·classify·C-quoting 디코드). 적대 게이트 통과 — 파서throw·64MiB좀비·cancel비멱등·한글경로 수정. child_process adapters 격리 | agent | Done | TEST-F-010 |
| SPEC-011 | UC-014 | **UC-CLI host 진입점(S2 supervisor mode CLI)** — `bin/naia-agent-run.mjs`(host 셸: process I/O·SIGINT→AbortController cancel·platform shell 매핑 `/bin/sh -c`·`cmd /c`·egress→stdout/stderr) + `app/cli-supervise.ts`(순수: argv 파싱·이벤트/정직리포트 렌더·exit code 0/2/3 S4, Node 무의존) + package.json `bin`. ③ '🔌 배선대기'의 host측 완성 — naia-os 없이 단독 실행 가능. e2e 검증(shell 성공=0·실패=3·미지원 정직=3·검증실패=2·usage=64). | agent | Done | TEST-F-011 |

## 비고
- SPEC-002 = 도구루프 + 9개 agent-local skill 묶음(개별 skill = TEST-F-002 의 test_ref 군). external(브라우저 CDP·youtube)만 루크머신 runtime.
- off-scope: UC-memory 어댑터(`@nextain/naia-memory` 연동, ports/memory) = 본 추적 제외(다른 세션, 01 노트).
