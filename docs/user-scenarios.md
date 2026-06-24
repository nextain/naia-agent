# User Scenarios (P01) + Test Coverage Map

정본 사용자 시나리오 인덱스. 각 UC 의 권위 계약서는 `docs/progress/99.dev-comm/UC*-contract*.md` 이며,
이 문서는 그 UC 목록과 테스트 커버리지 맵을 집약한다(SDLC P01 산출물).

## UC 인덱스

| UC | 시나리오 | 권위 계약서 |
|----|----------|-------------|
| UC1 | 에이전트 수평 파이프라인(채팅 턴 = provider 호출 → wire 스트림) | `docs/progress/99.dev-comm/UC1-agent-horizontal-contract-2026-06-10.md` |
| UC5 | 도구 실행 루프(toolUse → 실행 → 결과 스레딩 → 최종 응답) | `docs/progress/99.dev-comm/UC5-agent-tool-loop-contract-2026-06-10.md` |
| UC-provider-provenance | provider 라우팅 출처(naia-settings/wire/키체인) | `docs/progress/99.dev-comm/UC-provider-provenance-contract-2026-06-12.md` |
| UC-memory | 대화 턴 recall 주입 / save(naia-memory 연동) | `docs/progress/99.dev-comm/UC-memory-recall-save-contract-2026-06-12.md` |
| UC-PROV | provider/model 라이브 교체 — 재기동 없이 다음 턴 반영 | (계약 요약 = `docs/requirements.md` FR-PROV-1~5; 상세 진행기록은 메인테이너 워크스페이스) |
| UC-CLI | naia-agent 단독 CLI 오케스트레이션(direct tool-loop + sub-agent supervisor + interrupt + 정직보고) — naia-os 없이 단독 실행 | `docs/progress/99.dev-comm/UC-cli-orchestration-contract-2026-06-22.md` |
| UC-PANEL | 환경 panel skill(BGM·브라우저·workspace) 대화 도구 — agent 노출+위임, 셸 실행(E1) | `.agents/progress/panel-skill-grpc-port-2026-06-24.md` (설계) |

## UC-MEM-1 (장기기억 회상)

사용자가 한 턴에서 사실을 말하면(예: "내 비밀 코드명은 X야"), 다음 턴에서 그 사실을 물었을 때
("내 코드명이 뭐였지?") 에이전트가 **장기기억에서 회상**해 답한다. 회상된 사실은 모델 사전지식이
아니라 **이전 턴에 저장된 기억**에서 온다. 비활성(memory 미주입) 시 회상되지 않는다(인과 분리).

## UC-PROV-1 (provider/model 라이브 교체)

사용자가 naia-os 설정에서 텍스트 모델/프로바이더를 바꾸면, agent 재기동 없이 **다음 대화
턴부터** 해당 provider 로 응답한다(OS 가 naia-settings 갱신 후 `ReloadSettings`/`SetWorkspace`
재호출 → 활성 `defaultConfig` swap). 모든 naia-os 프로바이더(nextain/gemini/openai/xai/zai/
ollama/vllm)가 연결된다. anthropic/claude-code-cli 도 연결됨(FR-PROV-4/5 — claude-code 는 Claude Agent SDK 구독 인증, apiKey 불요. requirements.md 참조).

## UC-CLI (naia-agent 단독 CLI 오케스트레이션)

사용자(luke)가 **naia-os 없이** 터미널에서 `naia-agent`를 단독 실행해 실제 작업을 시킨다. naia-agent는
(S1) in-process tool-loop로 직접 작업하거나, (S2) 외부 코딩 에이전트(pi/opencode/claude-code/codex/
gemini)를 **sub-agent로 spawn**해 이벤트 스트림 통합 + workspace 변경 감시 + 검증(test/lint/build) +
**정직한 숫자 리포트**를 낸다. (S3) "stop"/Ctrl+C로 실시간 중단(SIGTERM→유예→SIGKILL, terminal 1회).

근본 원인: 이 단독 CLI 역량은 구 모노레포에서 **UC 없이**(vision/architecture 문서 + 단독 CLI로) 구현돼,
UC-주도 clean-rebuild 스코프에서 빠졌다(`backup/main-2026-06-22` 보존). 본 UC가 신 arch로 정식 편입한다.
직교: domain/app은 "세션 이벤트·변경 요약·검증 리포트·취소 요청"만 보고, subprocess/git/SIGTERM 등
메커니즘은 adapter 안에만 둔다(`SubAgentPort`/`WorkspacePort`/`VerifierPort` — 권위 계약서 참조).
naia-os gRPC 배선은 후속 phase(naia-os 워크스페이스 작업 후).

## UC-PANEL (환경 panel skill — BGM·브라우저·workspace 대화 도구)

사용자가 채팅으로 "음악 틀어줘"·"이 페이지 열어줘" 등 **환경 도구**(BGM·브라우저·workspace)를 시킨다.
이 도구들은 셸(naia-os)이 소유·실행하는 **환경**(brain-body-environment §3·§4, E1)이고, agent(뇌)는 실행하지
않는다 — agent 는 셸이 등록한 panel skill 을 LLM 에 **노출**하고, LLM tool call 시 **intent(panel_tool_call)만
emit**, 실행은 셸. 셸 결과(panel_tool_result)를 받아 tool_result 로 LLM 에 주입.

근본 원인: panel skill 은 옛 stdio protocol·gRPC proto 어디에도 정의 없는 **new-core 미이식 신규 기능**.
현재 agent_dispatcher(naia-os)가 panel 메시지를 `_=>{}` drop → BGM·브라우저 대화 불가. 본 UC가 신 arch로 편입.

- **S-PANEL-1 등록**: 셸이 panel 활성화 시 도구 spec(name/description/parameters/tier)을 `RegisterPanelSkills` 로 등록 → agent 가 동적 toolExecutor(builtin 과 composite)로 LLM 에 노출. 비활성화=`ClearPanelSkills`.
- **S-PANEL-2 위임**: LLM 이 panel tool call → agent 가 실행 대신 `panel_tool_call`(AgentEvent) emit → 셸 실행 → `PanelToolResult` 로 결과 반환 → agent 가 tool_result 주입 후 라운드 계속.
- **S-PANEL-3 목록**: `ListSkills`(voice 세션이 현재 도구 목록 질의 — 옛 fetchAgentSkills).
- 직교: domain/app 은 "도구 spec·tool call·결과"만, transport(gRPC)·셸 실행은 adapter/셸. tier 승인 게이트 그대로.

수용기준: panel tool 원격 실행이 chat 루프에서 **비동기 대기**(timeout·취소·다중 동시 매칭) 안전. builtin tool(즉시 실행) 무회귀.

## Test Coverage Map

| 요구 | 테스트 |
|------|--------|
| UC1 | `src/test/uc1-agent.contract.test.ts`, `uc1-*-provider.contract.test.ts` |
| UC5 | `src/test/uc5-*.contract.test.ts`, `uc5-tool-loop-stdio.integration.test.ts` |
| UC-provider-provenance | `src/test/uc-provider-provenance.contract.test.ts`, `uc-keychain-credentials.contract.test.ts` |
| UC-MEM-1 / FR-MEM-1·2·4 | `src/test/uc1-memory-stdio.integration.test.ts` (실 stdio 2턴 recall→inject→provider) |
| FR-MEM-5 격리 / FR-MEM-6 영속·드레인 / FR-MEM-7 bounded / FR-MEM-8 프레이밍 | `uc1-memory-stdio.integration.test.ts`(scope·persist·drain·concurrent·bounded·framing·neutralize) |
| FR-MEM-3 fault-injection(불변식) | `uc1-memory-stdio.integration.test.ts`(recall/save throw·hang → finish 1회·error 없음·usage 1회) |
| 실 프로세스 lifecycle | `src/test/uc1-memory-process.integration.test.ts`(EOF→drain→close→flush, save 영속) |
| UC-PROV-1 / FR-PROV-1·2·3 | `src/test/all-providers-wiring.contract.test.ts`, `uc1-reload-default-config.contract.test.ts`, `uc-naia-settings-store.contract.test.ts` |
| FR-PROV-5 (claude-code SDK 분리) | `src/test/all-providers-wiring.contract.test.ts`(claude-code 케이스 = Agent SDK 라우팅·apiKey 미주입) |
| FR-MODEL-1 (모델 카탈로그 정합) | `src/test/uc-provider-provenance.contract.test.ts`(cost↔registry 정합·구독 $0), naia-os `src/lib/llm/__tests__/registry.test.ts`(카탈로그 정합·최신화) |
| UC-CLI / AC3·AC5 (2a 골격) | `src/test/uc-cli-supervisor.contract.test.ts`, `uc-cli-composition.contract.test.ts` (fake 포트 stream-merge·terminal 1회·직교·동시성 — Pass) |
| UC-CLI / AC1·AC6 (2b 실 어댑터) | `src/test/uc-cli-subagent-{pi,opencode,roster,shell}.contract.test.ts`, `subprocess-session.contract.test.ts` (NDJSON→event·SIGTERM→SIGKILL·honest-unsupported — Pass) |
| UC-CLI / AC2·AC4 (2c 정직보고) | `src/test/uc-cli-verifier.contract.test.ts`, `uc-cli-workspace.contract.test.ts`, `uc-cli-supervisor-real-verifier.integration.test.ts` (never-throws·git classify·실 verify — Pass) |
| V모델: UC-CLI = UC-014 (REQ-011·012 → SPEC-009·010 → TEST-F-009·010), TEST-S-014 | `docs/progress/{01..05}/INDEX.md` (orphan 0) |
| UC-PANEL / S-PANEL-1·2·3 / FR-PANEL-1~5 | `src/test/uc-panel-skill.contract.test.ts` (등록→노출·tool call→panel_tool_call emit·result→주입·timeout/취소·동시성·builtin 무회귀) [예정] |

> UC1/UC5/provider-provenance 의 상세 시나리오·수용기준은 각 계약서 + `docs/acceptance-criteria.md` 참조.
