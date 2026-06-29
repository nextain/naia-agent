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
| UC-PERSONA-CLI | 코어가 워크스페이스 설정의 페르소나(Alpha)를 system prompt 로 합성 → CLI 가 `--system` 없이도 알파로 응답 | `docs/requirements.md` FR-PERSONA-1~3 (집약) |

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

**S1(대화) 세부 — 본 phase 이식 대상** (컷오버가 S2 supervisor만 이식, S1 멀티턴 대화 + login 누락; 갭 감사 `docs/progress/99.dev-comm/` + 루트 `.agents/progress/naia-agent-cli-repl-login-port-2026-06-26.md`):
- **S-CLI-CHAT (멀티턴 REPL)**: `naia-agent chat` → 터미널 readline 루프. 매 입력이 누적 history(이전 user/assistant 턴)와 함께 `ChatRequest` 로 들어가 **맥락 유지 멀티턴**. provider·도구·기억·대화조립 = naia-os gRPC 경로와 **동일 `wireAgentUC1` 코어**(transport만 stdio). emit(text)→stdout 스트리밍, finish→assistant 턴 history append+재프롬프트, Ctrl+C=현재 턴 취소.
- **S-CLI-LOGIN (키 로그인)**: `naia-agent login --provider <p> --key <k>`(또는 stdin 프롬프트) → 자격증명 저장(홈 `.naia-agent/.env` 0600) → 이후 키 인자 없이 `chat` 가능. resolver/credentials 포트가 저장 키를 읽어 provider 연결.
- 직교(병렬 금지): CLI 는 gRPC host(`agent-stdio-entry`)와 **같은 deps 빌더(`compose-agent-deps`) + 같은 `wireAgentUC1`** 를 호출, ingress/egress 만 stdio/readline 어댑터. 별도 대화 엔진/도구루프/creds 경로 신설 금지.

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

## UC-PERSONA-CLI (워크스페이스 페르소나 기본 주입)

사용자가 `naia-agent-chat` 를 실행하면, `--system` 플래그가 없어도 **워크스페이스 설정
(`<adkPath>/naia-settings/config.json`)의 페르소나(Alpha)** 로 응답한다 — 한국어, 해요체/존댓말,
사용자를 "마스터"로 부름. naia-os 든 단독 CLI 든 **같은 알파**(동일 SoT = 같은 config.json 을
naia-os 가 읽고 쓰므로 ghost-edit split 없음).

근본: 오늘 CLI 는 `--system` 이 있어야만 systemPrompt 를 세팅(없으면 generic chatbot). 코어가
config.json 의 `persona`(JSON 문자열, `systemPromptPrefix` 포함) + `agentName`/`userName`/`speechStyle`/
`honorific`/`NAIA_LOCALE` 를 합성해 기본 페르소나 system prompt 를 만든다.

- **S-PERSONA-1 (순수 합성)**: `composePersonaPrompt(profile)` (domain, 순수·무 I/O) 가 base(=`systemPromptPrefix`)
  + 컨텍스트 줄(userName·honorific·locale·speechStyle) 을 naia-os `buildSystemPrompt` **순서대로** 조립.
  단, 아바타/환경 전용 **emotion-tag 블록은 제외**(CLI 는 아바타 없음). profile 이 사실상 빈 값이면 "" 반환
  (호출자가 "페르소나 기본 없음"으로 취급).
- **S-PERSONA-2 (SoT 읽기)**: `PersonaSourcePort.load()` 가 `<adkPath>/naia-settings/config.json` +
  내장 `persona` JSON 문자열을 파싱해 `PersonaProfile` 로 매핑(`NAIA_LOCALE`→`locale`). 파일 부재/손상/
  필드 누락 = no-throw(undefined 필드로 degrade). 별도 페르소나 소스 신설 금지(config.json = 유일 SoT).
- **S-PERSONA-3 (CLI 기본 주입)**: `bin/naia-agent-chat.mjs` 가 `compose-agent-deps` 가 만든
  `personaSystemPrompt` 를 기본값으로 사용 — `args.systemPrompt ?? deps.personaSystemPrompt`(`--system`
  이 있으면 그대로 override). stderr 상태줄에 persona label 표기.

직교: 합성은 domain(순수), config 읽기는 adapter(`fs` 주입), 기본 주입은 host(bin). naia-os 의
`persona.ts` 는 **참조만**(import 금지) — CLI 측 재구현. emotion-tag 블록은 naia-os 전용으로 유지.

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
| UC-CLI / S-CLI-CHAT·S-CLI-LOGIN (S1 대화·로그인) / FR-CLI-7·8 | `src/test/cli-chat.contract.test.ts`(멀티턴 history 누적·emit→stdout·finish 재프롬프트·error 격리·login 파싱→.env 기록) + bin 실행 검증(fake provider 2턴 맥락 유지) |
| UC-PANEL / S-PANEL-1·2·3 / FR-PANEL-1~5 | `src/test/uc-panel-skill.contract.test.ts` (등록→노출·tool call→panel_tool_call emit·result→주입·timeout/취소·동시성·builtin 무회귀) [예정] |
| UC-PERSONA-CLI / S-PERSONA-1·2·3 / FR-PERSONA-1·2·3 | `src/test/uc-persona-compose.contract.test.ts` — describe "composePersonaPrompt" (full Alpha profile→prefix·존댓말·루크·마스터·Korean 포함, emotion-tag 제외 단언) + describe "Golden case D (CLI/no avatar)" (빈 profile→"", prefix-only→base only) + describe "PersonaSourcePort (fake fs)" (실 config.json shape→매핑 PersonaProfile, 파일부재→undefined) |

> UC1/UC5/provider-provenance 의 상세 시나리오·수용기준은 각 계약서 + `docs/acceptance-criteria.md` 참조.
