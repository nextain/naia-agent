# User Scenarios (P01) + Test Coverage Map

## UC-JEONJU-COURSE — Discord에서 안전하게 첫 정적 페이지를 완성한다

### Provider-neutral proposal/apply boundary

For the direct course repository route, the selected coding brain is a read-only proposal producer. It may be Codex, a model authenticated through the user's Naia account, or a later compatible provider. It returns one exact versioned JSON object containing complete replacement contents for a nonempty subset of `index.html` and `hero.svg`. Naia alone validates that proposal, applies it to the leased clean Git root, and verifies the file, Git-history, and remote boundaries. Invalid, absent, or failed proposals never become a completed course result; the student repository is preserved for review.

이 시나리오의 정본은 `data-private/naia-discord-codex-workshop-jeonju/00-workshop-map.md`부터
`08-revise-and-redeploy.md`, `appendix-c-instructor-runbook.md`까지다. 이 수업은 Naia
확장 개발이나 일반적인 자율 코딩을 가르치지 않는다. 학생이 고른 **깨끗한 GitHub
수업 저장소**에서 `index.html`과 `hero.svg`만 만들고, 학생이 직접 두 번 commit/push하는
경로만 제품 완료 범위다.

### UC-JEONJU-01 — 수업 시작 전 준비 확인

1. 학생은 Shell에서 Codex 로그인 상태와 선택한 수업 저장소를 확인한다.
2. 시스템은 로그인 식별자·인증 파일·긴 로컬 경로를 화면이나 대화에 노출하지 않고,
   `ready | not-installed | login-required | error`의 안전한 상태만 보인다.
3. 학생은 읽기 전용 요청으로 저장소 이름과 파일 수를 확인한다. 이 요청은 파일을
   변경하지 않아야 한다.

### UC-JEONJU-02 — 개인 Discord 경계와 `get_time` 증적

1. 학생은 OS 보안 입력을 통해 개인 bot token을 저장하고, 자신의 guild/channel/user와
   mention/reply-only 정책을 선택한다.
2. 허용된 Discord 메시지 `@Naia ... get_time ... Asia/Seoul`만 agent ingress로 들어간다.
3. Discord 답변은 모델 문장과 분리된 구조화 실행 기록으로 `get_time`, 성공 여부,
   Asia/Seoul 시각을 남긴다. 단순한 모델 자기보고는 성공이 아니다.
4. 비허용 guild/channel/user의 메시지와 일반 대화는 0회 처리한다.

### UC-JEONJU-03 — 첫 제작 요청과 학생 저장소 결과

1. 수업 시작 전에 Shell host가 선택한 학생 Git 저장소와 고정 파일 경계(`index.html`, `hero.svg`)를 versioned course target으로 설정한다. 허용된 학생은 Discord에서 명시적 `/course <교재의 첫 제작 요청>`을 보낸다. 일반 대화, 모델 출력, Discord 본문에 든 경로/파일명은 이 target을 바꾸지 못한다.
2. Naia는 **접수됨 → 작업 중 → 완료/실패**를 같은 Discord 흐름에 보이고, Codex에는
   학생이 선택한 수업 저장소만 쓰기 권한으로 넘긴다.
   Naia ADK 경로는 설정·기술·작업 상태를 위한 제어 루트이며, 실행 대상은 별도로
   선택한 Git 루트다. 기본 대상은 `naia-adk/projects/<project>`이고 ADK 루트 자체는
   명시적인 ADK 유지보수 요청에서만 선택한다. 수업 대상은 제어 루트 자체 또는 그
   하위 경로여야 하며, Codex는 그 대상에서만 실행한다.
3. Codex가 끝난 뒤 Naia는 학생 저장소에서 변경을 검사한다. 첫 요청의 성공은
   `index.html`, `hero.svg` 두 파일만 새로 만들고, `index.html`이 `./hero.svg`를 참조하며,
   외부 라이브러리/빌드 도구/commit/push/Pages 변경이 없을 때만 선언할 수 있다.
4. 학생은 Shell의 로컬 미리보기에서 제목·SVG·앵커 버튼·모바일 폭을 확인한 뒤,
   직접 `git add`, `commit`, `push`한다. Naia/Codex는 이 외부 변경을 실행하지 않는다.

### UC-JEONJU-04 — 두 번째 Discord 수정과 재확인

1. 같은 허용 Discord 흐름에서 학생은 제목을 `전주에서 만든 나의 AI 페이지`로,
   SVG 주색을 `#7C3AED`로 바꾸라고 요청한다.
2. Naia는 같은 학생 저장소에서만 수정하고, 새 파일·commit·push 없이 변경 파일과
   검사 결과를 보고한다.
3. 학생은 `git diff`를 확인한 뒤 두 번째 commit/push를 직접 수행하고 같은 GitHub Pages
   주소에서 바뀐 제목과 색을 확인한다.

### UC-JEONJU-05 — 실패와 중단을 정직하게 남긴다

- Codex 미설치/로그인 필요, Discord 보안 입력 취소, binding 불일치, dirty 저장소,
  허용 루트 이탈, 시간초과·학생 취소는 작업 성공으로 바뀌지 않는다.
- 실패/중단 보고는 비밀·prompt·Codex 원문 출력 없이 어느 단계에서 멈췄는지만 보인다.
- Discord가 막히면 로컬 Naia 대화로 수업을 이어갈 수 있으나, Discord 경로와 실제
  `get_time` 실행 기록은 **미검증**으로 남긴다.

### Test Coverage Map — UC-JEONJU-COURSE (P02)

| Test ID | 검증 | 증적 |
|---|---|---|
| TEST-JEONJU-01 | selected-workspace 요청은 명시 모드일 때만 허용하며, Git root·clean 상태·선택 경로 일치가 아니면 Codex를 시작하지 않는다. | `src/test/jeonju-course-selected-workspace.contract.test.ts` |
| TEST-JEONJU-02 | 실행 전후 변경은 `index.html`, `hero.svg`만 허용하고 HEAD/remote는 바뀌지 않는다. 위반·취소·시간초과는 성공으로 보고하지 않는다. | `src/test/jeonju-course-selected-workspace.contract.test.ts` |
| TEST-JEONJU-03 | Discord 허용 ingress에서 `get_time`의 실행 중/성공 기록과 최종 답변이 같은 reply 흐름에 직렬화된다. 이어지는 명시적 `/course`는 host가 고정한 target으로만 작업을 시작하고, 비밀·경로 없는 `received → running → completed/failed` 상태를 같은 Discord reply 흐름으로 보낸다. | `src/test/jeonju-discord-vertical.integration.test.ts` |
| TEST-JEONJU-04 | Shell은 학생이 선택한 저장소를 명시적으로 전달하고, 실제 Tauri Playwright에서 첫 요청→작업 중→두 파일 검사→두 번째 수정까지 보인다. | Shell `packages/shell/e2e/jeonju-course-workflow.spec.ts` |
| TEST-JEONJU-05 | 선택한 수업 저장소가 Naia ADK 제어 루트 또는 그 하위 Git 루트일 때만 직접 실행을 허용하고, 형제·외부 경로는 Codex 시작 전에 거부한다. | `src/test/selected-workspace-coding.contract.test.ts` + Shell native guidance E2E |

## UC-CODING-JOB — independent Codex coding workers

A desktop can start more than one coding task without treating a chat turn as
the worker lifetime. Each task receives a durable job id, a generated branch,
an isolated worktree, and an exclusive lease before Codex can write.

| Verification ID | Scenario |
|---|---|
| T-CW-01 | Start persists `queued`, allocates an isolated worktree/branch/lease, then enters `running`. |
| T-CW-02 | Concurrent jobs for one source workspace have different worktrees, branches, leases, runner handles and cancellation scope. |
| T-CW-03 | Get/List read durable state after service reconstruction, independent of a chat request id. |
| T-CW-04 | Cancel is targeted and idempotent; only the selected job reaches one `cancelled` terminal state. |
| T-CW-05 | Resume without a durable runner checkpoint fails precondition rather than claiming a false continuation. |
| T-CW-06 | Terminal states are immutable and invalid transitions are rejected. |
| T-CW-07 | Caller paths are canonicalized under the configured root; caller-controlled branch/worktree paths and lease collisions are rejected. |
| T-CW-08 | A Codex JSONL `turn.completed` closes a proposal job even when the CLI process remains alive; the adapter terminates that child and emits exactly one terminal result. |
| T-CW-09 | An agent message without `turn.completed` cannot be treated as a successful protocol completion; `turn.failed` remains a failed terminal result. |

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
| UC-WORKSPACE-CTX | 코어가 워크스페이스 컨텍스트(cwd + 프로젝트 이름 목록)를 system prompt 에 경량 포함 → 에이전트가 자기 워크스페이스를 인식 | `docs/requirements.md` FR-WORKSPACE-1~4 (집약) |
| UC-FS-TOOLS | 에이전트가 **직접 도구**로 워크스페이스 내 파일을 나열/읽기(기본), opt-in 으로 쓰기/셸 실행 — allow-root sandbox + 민감경로 denylist + realpath 재검증(TOCTOU) + tier 승인 | `docs/requirements.md` FR-FS-1~8 / NFR-SEC (집약) |
| UC-KNOWLEDGE | 코어가 컴파일된 워크스페이스 지식(KB)을 **풀 도구**(`skill_knowledge_search`/`ask`)로 노출 → 에이전트가 근거 있는 답변·근거 없으면 기권. + **컴파일 트리거**(`CompileKnowledge` RPC, K1b — 소스 폴더→kb.json). memory(푸시)와 분리된 풀(tool) | `docs/requirements.md` FR-KB-1~5 (집약) |
| UC-HLMEM | 인간유사 기억 **측정**(memory-as-user-model) — 장기기억이 사용자의 held-out 선택을 예측하나(F1 취향), 본인 기억이 예측하고 타인 기억은 오도하나(F2 자아특이성), 감정 salience 가중(F3, P6). vs 완벽회상 아님. 벤치(benchmark/src) 측정, 실행경로 아님 | `docs/progress/99.dev-comm/UC-HLMEM-humanlike-memory-measurement-contract-2026-07-07.md` + `docs/requirements.md` FR-HLMEM-1~7 |
| UC-THINKING | 추론(thinking) 모델의 **생각 출력 제어** — 로컬 추론 모델이 생각에 토큰을 다 써 최종 답변을 못 내는 것을 막는다. `enableThinking=false` 를 OpenAI-compat wire 에도 반영(`reasoning_effort:"none"`), **로컬 엔진에만** 적용(원격 클라우드는 400) | `docs/requirements.md` FR-THINK-1~4 (집약) |
| UC-CONTINUE-SPEAKING | 사용자 요청 또는 내부 활동 트리거로 시작한 에이전트가 라디오처럼 여러 번 이어 말하고, 사용자의 끼어들기에는 즉시 멈춘다 | `docs/progress/99.dev-comm/UC-CONTINUE-SPEAKING-contract-2026-07-16.md` |

## UC-MEM-1 (장기기억 회상)

사용자가 한 턴에서 사실을 말하면(예: "내 비밀 코드명은 X야"), 다음 턴에서 그 사실을 물었을 때
("내 코드명이 뭐였지?") 에이전트가 **장기기억에서 회상**해 답한다. 회상된 사실은 모델 사전지식이
아니라 **이전 턴에 저장된 기억**에서 온다. 비활성(memory 미주입) 시 회상되지 않는다(인과 분리).

### S-MEM-SUBLLM (memory sub-LLM 구성 + offline graceful degrade — S5/G5)

사용자가 naia-os 설정에서 메모리 sub-LLM 을 **naia 계정(게이트웨이)** 으로 고르면, CLI/gRPC 양쪽에서
memory 초기화가 **정상 동작**한다(사실추출/요약이 게이트웨이 경량 모델로 활성). naia-os 가 naia 선택 시
모델 문자열을 수집하지 않아도(SettingsTab 의 model 입력란이 naia 에는 미렌더) 코어가 **기본 게이트웨이
경량 모델**로 채워 init 이 깨지지 않는다. 만약 sub-LLM 을 깨끗이 구성할 수 없으면(게이트웨이 키 부재 등)
memory 가 **전체 OFF 되지 않고** sub-LLM 만 생략한 채 동작한다 — embedding(offline)·키워드 회상·저장은
유지되고 LLM 기반 사실추출/요약만 비활성(graceful degrade). memory 격리 키는 워크스페이스 UUID 라
페르소나 userName(S1b)을 옮겨도 기억 정체성이 갈라지지 않는다.

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

근본: 오늘 CLI 는 `--system` 이 있어야만 systemPrompt 를 세팅(없으면 generic chatbot). **코어
(`ChatTurnHandler`)가** `config.json` 의 `persona`(JSON 문자열, `systemPromptPrefix` 포함) +
`agentName`/`userName`/`speechStyle`/`honorific`/`NAIA_LOCALE` 를 **스스로 합성**해 기본 페르소나
system prompt 를 만든다. host(CLI·gRPC) 는 `PersonaSourcePort` 만 주입하고, 페르소나를 **클라이언트가
보내지 않는다**(설계 원칙: 코어가 system prompt 를 소유). `req.systemPrompt` 는 **순수 override**
(`--system` 플래그 + naia-os 과도기 경로)로만 남는다.

- **S-PERSONA-1 (순수 합성)**: `composePersonaPrompt(profile)` (domain, 순수·무 I/O) 가 base(=`systemPromptPrefix`)
  + 컨텍스트 줄(userName·honorific·locale·speechStyle) 을 naia-os `buildSystemPrompt` **순서대로** 조립.
  단, 아바타/환경 전용 **emotion-tag 블록은 제외**(CLI 는 아바타 없음). profile 이 사실상 빈 값이면 "" 반환
  (코어가 "페르소나 기본 없음"으로 취급 → systemPrompt 미설정).
- **S-PERSONA-2 (SoT 읽기)**: `PersonaSourcePort.load()` 가 `<adkPath>/naia-settings/config.json` +
  내장 `persona` JSON 문자열을 파싱해 `PersonaProfile` 로 매핑(`NAIA_LOCALE`→`locale`). 파일 부재/손상/
  필드 누락 = no-throw(undefined 필드로 degrade). 별도 페르소나 소스 신설 금지(config.json = 유일 SoT).
- **S-PERSONA-3 (코어 조립 + override 계약)**: `ChatTurnHandler.onChatRequest` 가 **코어 안에서**
  `composePersonaPrompt(personaSource.load() ?? {})` 로 페르소나를 조립한다. 조립값과 `req.systemPrompt`
  의 합성 규칙 = **`req.systemPrompt`(override) 우선, 없으면 코어 조립값**. `personaSource` 미주입 시
  기존 동작(`req.systemPrompt` 만, 무회귀). config.json 은 매 턴 1회 읽기(작은 파일) → 라이브 편집 즉시 반영.
  CLI host(`bin/naia-agent-chat.mjs`)·gRPC host(`agent-stdio-entry.mjs`) 둘 다 `compose-agent-deps` 가
  만든 `personaSource` 를 `wireAgentUC1` 에 주입(병렬 경로 없음, NFR-CLI-shared). stderr 상태줄에 persona label 표기.

직교: 합성은 domain(순수), config 읽기는 adapter(`fs` 주입), **조립은 코어(app/ChatTurnHandler)** —
host 는 `PersonaSourcePort` 주입만. naia-os 의 `persona.ts` 는 **참조만**(import 금지) — CLI 측 재구현.
emotion-tag 블록은 naia-os 전용으로 유지.

## UC-WORKSPACE-CTX (워크스페이스 컨텍스트 경량 인식)

사용자가 `naia-agent-chat`(또는 naia-os gRPC)로 대화하면, 에이전트가 **자기 워크스페이스를 인식**한다 —
현재 작업 디렉터리(cwd)와 워크스페이스(`<adkPath>/projects/`)의 **프로젝트 이름 목록**을 system prompt 에
경량으로 인지한다. 그래서 "지금 어느 프로젝트가 있어?" 같은 질문에 워크스페이스 실태를 근거로 답할 수 있다.

근본: 오늘 코어는 자기 워크스페이스(cwd·프로젝트 구성)를 모른 채 generic 하게 답한다. **코어
(`ChatTurnHandler`)가** 페르소나 조립 **바로 뒤에** 워크스페이스 컨텍스트를 스스로 합성해 append 한다.

★ 설계 제약(GLM 독립리뷰 — snapshot 전량덤프 금지, retrieval 지향):
- **경량 shallow 리스팅만** — 프로젝트 **이름(디렉터리명, 1-depth)** + cwd 뿐. **파일 내용 덤프·깊은 디렉터리
  walk 금지**. 파일 *내용* retrieval(상세)은 `read_file` 도구(S3) 몫이고, S2 컨텍스트엔 "상세는 파일 읽기
  도구로"만 안내한다.
- **토큰 bounded** — 프로젝트 목록은 cap(`PROJECT_RENDER_CAP`=40)까지만 표기하고 초과분은 `+N more` 총계로만
  보인다(렌더 결과 수백 토큰 상한).
- 프로젝트 이름은 **데이터로 렌더**(프롬프트 지시문처럼 해석되지 않게 단순 목록 — 디렉터리명이라 위험 낮으나 plain).
- per-turn shallow readdir(1-depth) 허용(작은 비용 — 새 프로젝트 즉시 반영, 깊은 스캔/캐시 불요).

- **S-WORKSPACE-1 (순수 합성)**: `composeWorkspaceContext(snapshot)`(domain, 순수·무 I/O) 가 cwd 줄 + "Projects
  (<total>): a, b, c[, +N more]" 줄 + "상세는 read_file 도구로" 안내를 합성한다. 입력이 사실상 비면(cwd·projects
  둘 다 없음) "" 반환(append 할 것 없음 = 무영향). cwd 만 있으면 cwd 줄만.
- **S-WORKSPACE-2 (경량 스냅샷)**: `WorkspaceContextPort.snapshot()` 가 `<adkPath>/projects/` 의 top-level
  **디렉터리명**(파일/dotfile 제외, 정렬)만 수집(1-depth shallow readdir)하고 cwd 를 더해 `WorkspaceSnapshot`
  (`cwd`·`projects`[cap 적용]·`projectTotal`[전체 수])을 낸다. `projects/` 부재/읽기실패 = no-throw degrade
  (projects=[], projectTotal=0; cwd 는 여전히 보고). **파일 내용은 읽지 않는다**(덤프 방지).
- **S-WORKSPACE-3 (코어 조립 + persona 뒤 append)**: `ChatTurnHandler.onChatRequest` 가 **코어 안에서** persona
  조립 직후 `composeWorkspaceContext(workspaceContext.snapshot() ?? 빈입력)` 을 합성해 `[corePersona, coreWs]`
  를 `\n\n` 으로 join 한다. `req.systemPrompt`(override) 가 있으면 persona·workspace 둘 다 무시. `workspaceContext`
  미주입 = 기존 동작(persona 만, 무회귀). 두 host(`bin/naia-agent-chat.mjs`·`agent-stdio-entry.mjs`)는
  `compose-agent-deps` 가 만든 `workspaceContextSource` 를 `wireAgentUC1` 에 주입(병렬 경로 없음, NFR-CLI-shared).

직교: 합성은 domain(순수), projects/ 읽기는 adapter(`fs` 주입), **조립은 코어(app/ChatTurnHandler)** —
host 는 `WorkspaceContextPort` 주입만.

## UC-FS-TOOLS (에이전트 직접 파일/셸 도구 + 보안 sandbox)

사용자가 에이전트에게 "이 워크스페이스의 파일을 봐줘"·"X 파일 내용을 읽어줘" 같은 요청을 하면, 에이전트가
**직접 도구**(`list_dir`·`read_file`)로 워크스페이스(allow-root=`<adkPath>`) 안의 파일을 나열/읽는다. opt-in
(`NAIA_SHELL_TOOL=1`) 시 `write_file`·`shell_exec` 도 쓸 수 있다. **이 워크스페이스엔 실제 키/시크릿이
있으므로 보안이 최우선** — 모든 경로는 allow-root 안으로 resolve 돼야 하고, 민감경로(`.keys`·`.env`·`.dpapi`·
SSH 키·`data-private` 등)는 allow-root 안이라도 거부한다.

근본: S2 워크스페이스 컨텍스트(프로젝트 이름 + cwd)는 "무엇이 있는지"만 인지시키고, **상세(파일 내용)
retrieval 은 본 UC(read_file)의 몫**이다(GLM: snapshot 덤프 방지). S3 는 그 상세 도구를 보안계약과 함께 1일차에 얹는다.

- **S-FS-1 (sandbox containment)**: 모든 fs/shell 경로는 domain `validatePath` 가 검증 — `..` 상위탈출,
  Windows 드라이브 절대(`C:\`·`D:/`)·UNC, env 확장(`%X%`·`$X`·`${X}`), 널바이트 → 전부 거부. 정규화 **후**
  allow-root 컨테인먼트(prefix, 세그먼트 경계) 재검증. 빈 allow-root = 전부 거부(deny-all).
- **S-FS-2 (denylist)**: allow-root 안이라도 민감경로는 거부 — `.keys`/`.ssh`/`.git`/`data-private`/`data-business`
  세그먼트, `.env`/`.env.*`/`id_rsa`/`id_ed25519` 파일, `.dpapi`/`.pem`/`.key`/`.pfx`/`.age` 접미사, 브라우저
  프로필/토큰 저장소 substring. (`.keys` 는 read 한 번으로도 치명 → read 도 거부.) 대소문자/구분자 정규화 후 매칭.
- **S-FS-3 (realpath/TOCTOU)**: 문자열 검증만으로는 부족 — 실행 시점에 **`realpathSync` 로 실제 경로를
  resolve 후 `validatePath` 재검증**(승인↔실행 사이 symlink/junction swap 방지, GLM f). 이 워크스페이스가
  junction(`alpha-adk/naia-memory→projects/naia-memory`)을 쓰므로 realpath 후 재검증이 필수다. realpath I/O 는
  주입 fs(어댑터)로 — domain 은 순수 유지.
- **S-FS-4 (argv shell)**: `shell_exec` 는 **argv 스펙**(`command: string[]`) — 셸 문자열 보간/파이프/리다이렉트
  없음(injection 차단). 주입 exec 가 `subprocess-session` 의 injection-safe spawn 헬퍼로 shell 없이 실행. cwd 도
  allow-root 검증.
- **S-FS-5 (tier 승인)**: `read_file`/`list_dir`=`fs-read`, `write_file`=`fs-write`, `shell_exec`=`shell`(상위).
  ToolSpec.tier 설정 시 `chat-turn-handler` 의 기존 ApprovalPort 게이트(tierOf→prepareDecision→approvalRequest)가
  **자동 발화**(새 승인 메커니즘 신설 없음).
- **S-FS-6 (opt-in)**: `read_file`/`list_dir` 기본 등록, `write_file`/`shell_exec` 는 `NAIA_SHELL_TOOL=1` 일 때만
  등록(specs 노출). (GLM: env-var 게이트는 자식 상속으로 약함 → 핵심 보안은 sandbox/denylist/argv; per-request
  capability 강화는 미래 — NFR-SEC 노트.)
- **S-FS-7 (no-throw)**: 도구 execute 는 실패/거부/sandbox 위반 시 `{output, isError:true}` 반환(throw 금지 —
  루프 안정, ToolExecutorPort 계약). abort 시에만 reject.

직교: 정책은 domain(순수, `validatePath`/`isSensitivePath`), realpath/exec(child_process) 등 메커니즘은
adapter 가 주입 실행기로 소유, tier 승인은 코어의 기존 ApprovalPort. host(`compose-agent-deps`)는 실행기
(node:fs/child_process)+allowRoots(=adkPath) 만 주입 — 코어 무변경(tier 만 설정하면 게이트 발화).

## UC-KNOWLEDGE (워크스페이스 지식 풀 도구 — read-only search/ask)

사용자가 워크스페이스의 (컴파일된) 지식에 대해 물으면("전입신고 필요서류가 뭐야?"), 에이전트가 **직접 도구**
(`skill_knowledge_search`·`skill_knowledge_ask`)로 워크스페이스 지식베이스(KB)를 검색·질의해 **근거(출처) 있는
답변**을 한다. 근거가 없으면 **지어내지 않고 기권**한다(안전). 이 지식 경로는 장기기억(memory, 푸시)과 **분리된
풀(pull/tool)** — 에이전트가 필요하다고 판단할 때 호출하며, 매 턴 자동 주입되지 않는다(memory=WHO/푸시,
knowledge=WHAT/풀, 안 섞음).

근본: KB 컴파일·서빙은 외부 엔진(naia-kb-compiler)이 담당하고, 코어는 그 KnowledgeService(검색/질의응답)를
**ToolExecutorPort 도구로 노출**만 한다(naia-os 패널이 결과를 렌더·근거 칩). 통합 설계 SoT = 루트
`.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md` (K1a).

- **S-KB-1 (read-only 도구 노출)**: `makeKnowledgeSkillsExecutor` 가 `skill_knowledge_search`({query,k?})·
  `skill_knowledge_ask`({query}) 2종을 ToolExecutorPort 로 노출. **tier 없음**(읽기 전용 → 승인 불요; 쓰기/컴파일은
  K1b 에서 tier+승인). compile/재인덱싱 등 쓰기는 본 도구에 없다.
- **S-KB-2 (backend 주입·비종속)**: 어댑터는 `KnowledgeBackend`(search/ask) **주입**받음 — naia-kb-compiler
  `openWorkspaceKnowledge(dir)` 결과를 매핑(D03 교체 가능). backend 미주입/미가용 = 정직 unavailable(throw 아님).
  코어는 특정 엔진을 import 하지 않는다(비종속).
- **S-KB-3 (JSON 출력·출처 보존)**: execute output = JSON(`JSON.stringify`) — `ask`={abstained,answer,sources}·
  `search`={hits}. sources/hits 의 **sourceUris 보존**(naia-os 가 파싱해 근거→원문 칩 렌더; 구조화 citation
  cardId/snippet 확장은 후속 K5).
- **S-KB-4 (no-throw·기권)**: 도구 execute 는 실패/미가용/잘못된 인자 시 `{output, isError:true}`(throw 금지 —
  루프 안정, ToolExecutorPort 계약). abort 시에만 reject(2가드: 진입/await 후). 근거 없으면 backend abstained=true(지어내지 않음).
- **S-KB-5 (컴파일 트리거 — K1b)**: gRPC `CompileKnowledge(adkPath)` RPC 가 셸 소유 `naia-settings/knowledge.json`
  (scope·sources)을 **읽어**(에이전트는 config 쓰기 없음 — naia-os FR-KB-OS.9 대칭) 등록 폴더(.md/.txt) → kb-compiler
  `compile()`(오프라인 결정론) → `knowledge/<scope>/kb.json` 영속. 통계({ok,scope,*Count,error?}) 반환·no-throw.
  셸 "지금 컴파일" 버튼이 호출. backend 주입(D03 비종속). 읽기(S-KB-1)와 직교.

직교: KB 컴파일/서빙 지능은 외부 엔진(어댑터가 backend 로 주입), 코어는 도구 노출 + 컴파일 트리거. `compose-agent-deps` 가
실 backend(`openWorkspaceKnowledge`)를 주입(K1a-2), entry 가 컴파일 backend(`makeKbCompilerBackend`)를 주입(K1b). memory(push) 경로와 저장소·주입 모두 분리.

## UC-HLMEM (인간유사 기억 측정 — memory-as-user-model)

권위 계약서: `docs/progress/99.dev-comm/UC-HLMEM-humanlike-memory-measurement-contract-2026-07-07.md`.
측정 하네스(benchmark/src)이지 런타임 실행경로 아님. 정본 seam 준수(자동 recall·formatRecalledMemory·
ProviderPort). 옛 `<recall>` 마커·"부적절=실패" 도덕채점 폐기(SoT [[project_naia_behavior_emergent_not_filtered]]).

- **S-HLMEM-F1 (취향 예측)**: 사용자의 과거 취향 발화를 seed(MemoryPort.save)로 저장 → 어휘가 겹치지
  않는 held-out 상황의 A/B 선택을 예측. matched(기억 주입) vs blind(기억 없음). 기대: 취향이 평균과
  갈릴 때 matched 가 blind 를 능가(일반화, 암기 아님).
- **S-HLMEM-F2 (자아특이성)**: 반대 취향 사용자 2인 seed → 각 사용자 선택을 본인 기억(matched)·
  타인 기억(mismatched)·무기억(blind)으로 예측. 자아특이성=acc(matched)−acc(mismatched); mismatched<blind
  = 타인 기억이 적극 오도. 옵션 순서 무작위(위치편향 제어).
- **S-HLMEM-F3 (감정 연상, P6)**: 감정 반응(valence)으로 salience 가중된 회상이 예측에 미치는 영향.
  MemoryPort/RecalledMemory salience widen(P6) + naia-memory arousal-flashbulb 필요.
- **결정론/CI**: 라이브 관측을 fixture 로 녹화 → CI 는 파싱·채점 재생(모델·키 無). 라이브=opt-in
  (`NAIA_PROD_KEY`). exec-error(빈 completion)=infra 실패로 분리(예측실패 아님).

## UC-THINKING (추론 모델의 생각 출력 제어)

사용자가 **로컬 추론(thinking) 모델**(Qwen3.5 / DNA3.0 등)로 대화할 때, 모델이 생각(`reasoning`)
블록에 출력 토큰을 다 써버리고 **최종 답변을 한 글자도 못 내는** 일이 없어야 한다. naia-os 설정의
"생각 표시" 토글(`enableThinking`)이 **OpenAI-compat wire 에도 반영**되어야 한다.

**근거(실측, 2026-07-14 — RTX 3080 Ti 16GB, ollama 0.32.0, Qwen3.5-9B 계열, 도구 9개):**

| 구성 | 빈 답변 | 틀린 답변 |
|---|---|---|
| thinking **on**, 컨텍스트 4k | 2/6 | 0/6 |
| thinking **on**, 컨텍스트 16k | 1/6 | 1/6 (지식과 다른 시각을 지어냄) |
| **thinking off**, 컨텍스트 16k | **0/6** | **0/6** |

- 빈 답변의 `finish_reason` 은 `length`(잘림)가 **아니라 `stop`** 이었다 — 모델이 생각을 마친 뒤
  본문을 시작하지 않고 종료한다. 즉 **컨텍스트를 키워도 낫지 않는다**(16k 에서도 재현).
- 프롬프트로 억제(페르소나에 "생각 과정을 출력하지 마세요")는 **듣지 않았다**.
- ollama `/v1` 에서 실제로 듣는 스위치는 **`reasoning_effort:"none"` 하나뿐**이었다
  (`think:false`·`chat_template_kwargs.enable_thinking:false`·`/no_think` 전부 무시.
  `/no_think` 는 오히려 마크다운 표를 유발 — 음성 합성 경로에 치명적).
- 부수 효과: 완성 토큰 115 → 17~34, 응답 2.2s → **0.75s**.

- **S-THINK-1 (도메인 의도 → wire 반영)**: `ProviderConfig.enableThinking === false` 면 OpenAI-compat
  어댑터가 요청 body 에 `reasoning_effort: "none"` 을 싣는다. `enableThinking` 이 `true`/미지정이면
  **아무 것도 싣지 않는다**(기존 동작 무회귀 — 추론 모델의 기본은 생각 켬).
- **S-THINK-2 (로컬 엔진 게이트 — 회귀 방지)**: 이 파라미터는 **로컬 엔진**(baseUrl 이 loopback/사설망)
  에만 붙인다. ⚠️ naia-os 셸은 `enableThinking:false` 를 **기본값으로 항상 전송**하므로, 게이트가 없으면
  OpenAI(gpt-4o)·Gemini·GLM 같은 **비추론 원격 모델에 `reasoning_effort` 가 실려 400** 이 난다.
  로컬 엔진(ollama·vLLM)은 미지원 파라미터를 조용히 무시한다(실측).
- **S-THINK-3 (기존 provider 무영향)**: anthropic·claude-code·ollama(native) 어댑터는 이미 각자
  `enableThinking` 을 소비한다(`anthropic-provider.ts:80`, `ollama-provider.ts:42`). 본 UC 는
  **OpenAI-compat 어댑터의 누락만** 메운다 — 다른 어댑터·도메인 계약·gRPC proto 는 건드리지 않는다.

직교: 컨텍스트 예산(도구 스키마 미계상 / `finish` 에 잘림 사유 부재 / 잘림을 성공으로 오인)은 **별개 결함**
(#80) 으로 분리 — 본 UC 는 "생각이 답변 예산을 잠식하는" 축만 닫는다.

## UC-CONTINUE-SPEAKING (자유 발화와 연속 발화 — "라디오 모드")

> **2026-07-18 v3.1.** 정본 계약 =
> `docs/progress/99.dev-comm/UC-CONTINUE-SPEAKING-contract-2026-07-16.md`.
> 같은 날 목표 재정렬로 아래 두 MVP 시나리오가 기존 범용 hardening 시나리오보다 우선한다.

### MVP-1 개인 라디오 DJ

Luke가 Naia를 켜 두면 Naia는 입력만 기다리지 않는다. 설정된 idle 뒤 현재 시간, 선택적으로 주입된
날씨, 현재 BGM 상태와 프로세스 안의 명시적 선호를 바탕으로 먼저 음악을 제안한다. 실제
`skill_youtube_bgm` 재생 성공 뒤 짧은 선곡 이유를 말하고, 음악을 방해하지 않는 간격으로 서로 다른 DJ
멘트를 이어간다. 긴 유튜브 믹스의 세부 현재 곡은 chapter/tracklist 근거가 없으면 추측하지 않는다.

Luke가 “음악만”, “말 줄여”, “다른 분위기”, “다음 곡”, “그만”이라고 하면 즉시 양보한다. “내가 멈추라고
할 때까지”는 내부 안전 lease를 갱신해 사용자 관점에서 계속한다. 현재 production 경로는 기분·활동 수집,
사용자용 날씨 설정, 명시적 좋아요·싫어요의 Naia Memory 영속 handoff를 아직 제공하지 않는다. 활동
발화나 재생 시간으로 취향을 몰래 추론하지 않는다.

### MVP-2 회사 전시 행사 소개

회사 전시에서 Naia는 관람객 입력을 기다리지 않고 설정된 idle 뒤 먼저 짧게 인사하고 회사·제품·전시의
관심 지점을 소개한다. 소개는 지정 KB 근거만 사용하며 서로 다른 항목 3개를 중복 없이 진행한다. 질문이
들어오면 현재 소개와 TTS를 즉시 중단하고 답한 뒤, quiet/stop이 아니라면 아직 소개하지 않은 다음 항목으로
복귀한다. 방문객 개인정보는 기본 장기 저장하지 않는다.

Naia는 “라디오처럼 계속 이야기해 줘. 난 씻고 올게”라는 요청 뒤 짧은 발화를 이어 말한다. 또한 idle
detector나 cron 같은 외부 정책이 자유 발화를 시작하면 사용자 입력 없이 먼저 말을 건다. 두 경로는 턴
지역 변수가 아닌 하나의 명시적 활동(activity) 수명과 기존 끼어들기 경로를 공유한다.

- **S-CONT-1 (구조 검사가 있는 하이브리드 활성화)**: 지속 요청과 별도의 수동 청취 원문 근거가 모두
  충실하면 즉시 시작한다. 지속 요청만 있으면 같은 세션의 다음 한 턴에서 확인한다. 부재 신호만 있거나
  두 근거가 같은 구절이면 즉시 시작하지 않는다. 앱은 원문 충실도와 두 근거의 분리만 검사하고 언어별
  키워드로 의미를 재판정하지 않는다. `잠들 때까지 얘기해줘`는 지속 기간이 수동 청취 신호이므로 즉시 시작한다.
- **S-CONT-2 (결정론적 확인)**: pending은 sessionId에 결속되어 2분 동안 다음 사용자 턴 하나에서만
  원자적으로 소비된다. 확인 턴에는 enum과 원문 근거를 가진 확인용 내부 도구만 보이며, 도구 미호출·구조
  실패·오류·취소·만료는 pending을 삭제한다. 동의 의미는 provider가 도구 선택으로 판정하고, 앱은 의미를
  키워드로 재판정한다고 과장하지 않는다. 빈 sessionId는 교차 턴 상태를 만들지 않는다. 확인 질문 기록과
  즉시 겹친 다음 확인 턴의 기록 순서는 session append queue가 보장한다.
- **S-CONT-3 (자유 발화 1급)**: app 계층의 `startSelfInitiatedSpeech`가 사용자 메시지 없이 같은 활동
  런타임을 시작한다. 셸은 session-bound activity stream을 미리 구독해 requestId와 발화를 받고 기존
  cancel 또는 session stop으로 끼어든다. stop/cancel 뒤 장기 stream은 다음 활동이 재사용하고 stale cancel은
  requestId+activityId 세대 토큰으로 새 활동과 격리한다. reason/topic은 각각 Unicode code point 500에서
  잘라 내부 기준점에만 사용한다. 두 MVP profile의 센서 없는 idle timer는 app이 소유하고 subscriber와
  필수 capability 준비 뒤 arm하며 사용자 입력마다 reset한다. presence/camera와 범용 cron 정책만 범위 밖이다.
- **S-CONT-4 (같은 흐름·유한 도구)**: 후속 발화는 원래 맥락과 직전 완결 발화 하나만 이어받는다.
  제어와 외부 도구가 같은 round에 오면 기존 외부 도구를 완주하고 첫 no-tool 텍스트에서만 활동을 시작한다.
  그 뒤 임의 제어·외부 도구를 노출하지 않는다. 단, `personal_radio_dj`는 검증된
  `skill_youtube_bgm` action만, `exhibition_intro`는 profile-owned read-only KB port만 사용한다.
  앱은 숨은 진행 입력을 wire·대화록·장기기억에 직접 직렬화하지 않으며, 모델이 생성한 임의 재진술
  차단은 별도 출력 안전 범위다.
- **S-CONT-5 (끼어들기·유한 경계)**: ordinary/requested chat은 Chat마다 새 requestGeneration을 받고,
  ordinary는 requestId+requestGeneration, activity는 stream이 준 activityId까지 함께 돌려주는 cancel이 provider 호출과 발화 사이 대기를
  함께 중지한다. 기본 10분/최대 30분, 기본 간격 3초(0~30초), 최대 60개 발화 중 먼저 닿는 경계에서 끝난다.
  self-init은 session activity stream의 모든 event에서, requested는 기존 Chat stream의 admission 뒤 첫
  완결 text부터 terminal까지 activityId를 받는다. admission 전 Chat은 requestId-only cancel로 중지한다.
  admission 경쟁에서 늦은 ID 없는 cancel은 현재 activityId가 든 `ACTIVITY_ID_REQUIRED`를 받아 한 번
  재시도하고, self-init은 첫 event 관측 전에도 session Stop으로 중지한다.
  terminal 뒤 requestId 재사용에도 이전 generation cancel은 무해하다. control이 섞인 round는 32개 tool
  call, 모든 provider round는 4,096 chunk·외부 payload UTF-8 256KiB, control-enabled 첫 provider 호출 직전부터 admission까지 120초 공동 상한이다. ordinary streaming은 한계 전 prefix를 유지하고 활동 미완 발화는 전부 버린다. 취소 뒤
  provider iterator나 진행 중 checkpoint 정리가 멈춰도 독립 5초 상한 안에 terminal·활동 상태·registry를 닫는다.
- **S-CONT-6 (증분 보존·기억 분리)**: 각 완결 발화를 `(sessionId, activityId, sequence)` 멱등 키로
  `conversationLog`에 즉시 체크포인트한다. 취소·오류에도 완료분은 남고 미완분만 버린다. 활동 발화에는
  `memory.save`를 호출하지 않으며 장기기억 통합은 꿈 경로가 맡는다. timeout된 비동기 write는 session
  writer를 격리해 뒤늦은 파일 순서 역전을 막는다.
- **S-CONT-7 (wire·회귀)**: 모든 provider usage를 합산해 마지막 한 번만 방출하고 terminal도 한 번만
  방출한다. 제어 도구 미호출 일반 채팅과 기존 외부 도구 턴의 correlation·저장 계약은 바뀌지 않는다.

범위 밖은 앱 재시작 후 자동 재개, 여러 프로세스/기기 사이 활동 이전, 별도 라디오 설정 UI다. 자유 발화
전달을 위한 session activity stream과 stop RPC는 범위에 포함한다.

## UC-CODEX-DELEGATION — Codex로 답하고 별도 터미널 Codex에 위임한다

- 사용자는 Shell에서 Codex를 main provider로 선택하고 로컬 로그인으로 답을 받는다.
- Codex가 시간 같은 자동승인 로컬 도구를 선택하면 app-server가 같은 turn 안에서 실행 결과를 받아 답을 이어간다.
- 신뢰된 Discord 채널에서 코딩 작업을 요청하면 main provider는 workspace 안에서만 별도 Codex 세션에 위임한다.
- 사용자는 같은 Discord reply에서 도구 시작·성공·실패를 보며, 내부 인자·출력·call id나 mention 문자열은 노출되지 않는다.
- 승인 필요 도구와 외부 처리 도구는 이 즉시 실행 경로에서 제외된다.

| 검증 ID | 시나리오 |
|---------|----------|
| T-CODEX-01 | current app-server `dynamicTools`와 `item/tool/call` 요청/응답 형상을 고정한다. |
| T-CODEX-02 | handled tool 이벤트를 한 번만 실행하고 같은 id의 toolUse/toolResult를 방출한다. |
| T-CODEX-03 | 승인·외부처리·내부 연속발화 제어 도구를 native 광고에서 제외한다. |
| T-CODEX-04 | desktop entry가 Codex-only delegate를 구성하고 realpath workspace 탈출을 거부한다. |
| T-CODEX-05 | Discord 진행 메시지가 직렬·bounded·비밀 없음이며 final reply/dedupe를 깨지 않는다. |

## Test Coverage Map

| 요구 | 테스트 |
|------|--------|
| UC-HLMEM / S-HLMEM-F1·F2 / FR-HLMEM-1~6 (결정론 코어·지표) | `benchmark/src/humanlike/*.test.ts`(fixture-replay: 파싱·trace 분류·predictionAccuracy·selfSpecificity·위치편향 중화) [P3] |
| UC-HLMEM / FR-HLMEM-7 (라이브 e2e, opt-in) | `benchmark/src/humanlike/live-sut` 실 MemoryPort+ProviderPort 1회 e2e(matched>blind) [P5, NAIA_PROD_KEY 게이트] |
| UC1 | `src/test/uc1-agent.contract.test.ts`, `uc1-*-provider.contract.test.ts` |
| UC5 | `src/test/uc5-*.contract.test.ts`, `uc5-tool-loop-stdio.integration.test.ts` |
| UC5 §H / FR-PROV-6 (ollama native tools) | `src/test/uc1-ollama-provider.contract.test.ts` — describe "UC5 §H tools" (tools body 매핑·tool-bearing 메시지 형상·tool_calls→toolUse·id 합성/중복 throw·args 검증·원자성·abort commit-point·degrade 재시도·text-only 회귀 없음) |
| UC-provider-provenance | `src/test/uc-provider-provenance.contract.test.ts`, `uc-keychain-credentials.contract.test.ts` |
| UC-MEM-1 / FR-MEM-1·2·4 | `src/test/uc1-memory-stdio.integration.test.ts` (실 stdio 2턴 recall→inject→provider) |
| FR-MEM-5 격리 / FR-MEM-6 영속·드레인 / FR-MEM-7 bounded / FR-MEM-8 프레이밍 | `uc1-memory-stdio.integration.test.ts`(scope·persist·drain·concurrent·bounded·framing·neutralize) |
| FR-MEM-3 fault-injection(불변식) | `uc1-memory-stdio.integration.test.ts`(recall/save throw·hang → finish 1회·error 없음·usage 1회) |
| 실 프로세스 lifecycle | `src/test/uc1-memory-process.integration.test.ts`(EOF→drain→close→flush, save 영속) |
| FR-MEM-12 / S-MEM-SUBLLM (naia sub-LLM 폴백 + graceful degrade, S5) | `src/test/uc-naia-settings-store.contract.test.ts` — describe "naia sub-LLM model 폴백 + graceful degrade (S5/G5)" (naia+모델부재+키존재→기본모델 완전구성·명시모델 우선·키 부재→provider=none 강등(메모리 유지)·vllm baseUrl 누락→none 강등) + `sub-llm-provider.contract.test.ts`(미구성=undefined) |
| UC-PROV-1 / FR-PROV-1·2·3 | `src/test/all-providers-wiring.contract.test.ts`, `uc1-reload-default-config.contract.test.ts`, `uc-naia-settings-store.contract.test.ts` |
| UC-THINKING / S-THINK-1·2·3 / FR-THINK-1~4 | `src/test/uc-thinking.contract.test.ts` (요청 body 검증: enableThinking=false+로컬 → `reasoning_effort:"none"` / true·미지정 → 미전송 / **원격 baseUrl → 미전송**(400 회귀 방지) / `isLocalEngineBaseUrl` 순수 판별) |
| FR-CONT-MVP-1~4 / 개인 라디오 DJ | 계약/통합: `src/test/personal-radio-dj.contract.test.ts` (`DJ-01~07`), `src/test/personal-radio-dj-grpc.integration.test.ts` (`DJ-GRPC-01`). 실제 Tauri: shell `71-proactive-speech-profiles.spec.ts`의 profile 저장·복원, 실제 YouTube BGM, 첫 결과 text, stop만. |
| FR-CONT-MVP-1·2·5~8 / 회사 전시 소개 | 계약/통합: `src/test/exhibition-intro.contract.test.ts` (`EX-01~06`)가 소개3·질문 yield/resume·stale 폐기를 검증. 실제 Tauri: shell `71-proactive-speech-profiles.spec.ts`의 무입력 greeting과 stop만. audible TTS·실제 질문 barge-in은 미검증. |
| UC-CONTINUE-SPEAKING / S-CONT-1~7 / FR-CONT-1~8 | 권위 계약 §10 AC1~18 matrix. `src/test/uc-continue-speaking.contract.test.ts`; `src/test/uc-continue-speaking-grpc.integration.test.ts` (`speech activity subscription lifecycle`, `stop response mapping`, `composition activity drain`); `src/test/conversation-log.{contract,integration}.test.ts`; `src/test/compose-agent-deps.integration.test.ts`; shell `packages/shell/src-tauri/src/agent_grpc.rs` `speech_activity_*` + `packages/shell/e2e-tauri/continuous-speech.spec.ts`; Ollama contract; 모델 패널 JSON |
| FR-PROV-5 (claude-code SDK 분리) | `src/test/all-providers-wiring.contract.test.ts`(claude-code 케이스 = Agent SDK 라우팅·apiKey 미주입) |
| FR-MODEL-1 (모델 카탈로그 정합) | `src/test/uc-provider-provenance.contract.test.ts`(cost↔registry 정합·구독 $0), naia-os `src/lib/llm/__tests__/registry.test.ts`(카탈로그 정합·최신화) |
| UC-CLI / AC3·AC5 (2a 골격) | `src/test/uc-cli-supervisor.contract.test.ts`, `uc-cli-composition.contract.test.ts` (fake 포트 stream-merge·terminal 1회·직교·동시성 — Pass) |
| UC-CLI / AC1·AC6 (2b 실 어댑터) | `src/test/uc-cli-subagent-{pi,opencode,roster,shell}.contract.test.ts`, `subprocess-session.contract.test.ts` (NDJSON→event·SIGTERM→SIGKILL·honest-unsupported — Pass) |
| UC-CLI / AC2·AC4 (2c 정직보고) | `src/test/uc-cli-verifier.contract.test.ts`, `uc-cli-workspace.contract.test.ts`, `uc-cli-supervisor-real-verifier.integration.test.ts` (never-throws·git classify·실 verify — Pass) |
| V모델: UC-CLI = UC-014 (REQ-011·012 → SPEC-009·010 → TEST-F-009·010), TEST-S-014 | `docs/progress/{01..05}/INDEX.md` (orphan 0) |
| UC-CLI / S-CLI-CHAT·S-CLI-LOGIN (S1 대화·로그인) / FR-CLI-7·8 | `src/test/cli-chat.contract.test.ts`(멀티턴 history 누적·emit→stdout·finish 재프롬프트·error 격리·login 파싱→.env 기록) + bin 실행 검증(fake provider 2턴 맥락 유지) |
| UC-PANEL / S-PANEL-1·2·3 / FR-PANEL-1~5 | `src/test/uc-panel-skill.contract.test.ts` (등록→노출·tool call→panel_tool_call emit·result→주입·timeout/취소·동시성·builtin 무회귀) [예정] |
| UC-PERSONA-CLI / S-PERSONA-1·2 / FR-PERSONA-1·2 | `src/test/uc-persona-compose.contract.test.ts` — describe "composePersonaPrompt" (full Alpha profile→prefix·존댓말·루크·마스터·Korean 포함, emotion-tag 제외 단언) + describe "Golden case D (CLI/no avatar)" (빈 profile→"", prefix-only→base only) + describe "PersonaSourcePort (fake fs)" (실 config.json shape→매핑 PersonaProfile, 파일부재→undefined) |
| UC-PERSONA-CLI / S-PERSONA-3 / FR-PERSONA-3 (코어 조립 + override) | `src/test/uc-persona-handler.contract.test.ts` — fake provider 가 받은 systemPrompt 를 캡처: (a) `req.systemPrompt` 없음 + personaSource 주입 → provider 가 코어 조립 persona(알파 prefix) 수신, (b) `req.systemPrompt` 있음 → 그 override 가 쓰이고 코어 조립 무시, (c) personaSource 미주입 → `req.systemPrompt` 만(무회귀) |
| UC-WORKSPACE-CTX / S-WORKSPACE-1·2 / FR-WORKSPACE-1·2 | `src/test/uc-workspace-context.contract.test.ts` — describe "composeWorkspaceContext" (cwd+projects 렌더·cap "+N more" 토큰 bounded·빈 입력→""·cwd-only·파일내용 미포함 단언) + describe "WorkspaceContextPort via fake fs" (fake readdir → 디렉터리명만 수집·dotfile/파일 제외·정렬·projects/ 부재 no-throw degrade·파일 내용 안 읽음) |
| UC-WORKSPACE-CTX / S-WORKSPACE-3 / FR-WORKSPACE-3 (코어 조립 + persona 뒤 append) | `src/test/uc-workspace-context.contract.test.ts` — describe "ChatTurnHandler workspace 조립" — capturing provider 로 systemPrompt 캡처: persona+workspace 둘 다 포함(append 순서), `req.systemPrompt` override 시 둘 다 무시, workspaceContext 미주입 시 persona 만(무회귀) |
| UC-FS-TOOLS / S-FS-1·2·3 / FR-FS-2·3·4 + NFR-SEC (sandbox 단위) | `src/test/uc-fs-tools.contract.test.ts` — describe "validatePath (domain)" — `..`/드라이브절대/UNC/env확장/널바이트 거부, allow-root 밖 거부·안 허용, denylist(.keys/.env/.dpapi/data-private/ssh) 거부, 빈 allowRoots deny-all + describe "realpath/TOCTOU" — fake realpath 가 allow-root 밖 가리키면 거부(symlink/junction 탈출 시뮬) |
| UC-FS-TOOLS / S-FS-5·6·7 / FR-FS-1·5·6·7·8 (도구 계약) | `src/test/uc-fs-tools.contract.test.ts` — describe "makeFsTools" — read_file/list_dir(허용 성공·거부 isError·throw 안 함), write_file(enableWrite=false→spec 없음·동작 거부, true→동작·승인 tier), 민감경로 실증(`<adk>/naia-settings/.keys/x.dpapi`·`<adk>/data-private/...` read→isError) + describe "makeShellTool" — argv 정상·셸문자열(string) 거부·cwd 탈출 거부·tier shell·no-throw |
| UC-KNOWLEDGE / S-KB-1~4 / FR-KB-1~4 | `src/test/uc-knowledge.contract.test.ts` — describe "makeKnowledgeSkillsExecutor" (specs 2종·tier 없음 / search JSON hits+sourceUris / k 반영 / ask JSON answer+sources / 근거없음 기권 abstained / backend 미주입 unavailable / 빈·비문자 query·잘못 args isError no-throw / unknown tool / abort reject). fake backend 결정론 |
| UC-KNOWLEDGE / S-KB-5 / FR-KB-5 (컴파일 K1b) | `src/test/uc-knowledge-compile.contract.test.ts` — makeCompileKnowledge(소스→backend·통계 / 소스0·빈adkPath·backend throw·readConfig throw = ok:false no-throw) + readWorkspaceKnowledgeConfig(부재·유효·깨짐). `src/test/uc-knowledge-compile.integration.test.ts` — 실 kb-compiler: 폴더(.md)→compile→knowledge/<scope>/kb.json 영속+sourceUris 보존(cross-repo) |

> UC1/UC5/provider-provenance 의 상세 시나리오·수용기준은 각 계약서 + `docs/acceptance-criteria.md` 참조.

## UC-SECURITY-WIRE-V2 — 처리 위치가 공개되고 동의가 재사용되지 않는다

- 사용자는 로컬·관리형·외부 클라우드 중 실제 처리 위치와 workload를 처리 전에 확인한다.
- Discord 요청은 저장된 채널 binding과 processing profile이 일치할 때만 수락된다.
- processing 요청에 비밀키를 직접 넣거나, caller가 `actualDestination`을 주장해도 신뢰 정보로 전달되지 않는다.
- 외부 처리 동의는 한 번만 원자적으로 소비되고 profile·destination·workload·session·만료시간이 모두 일치해야 한다.
- 이 안전 경계는 특정 AI 모델이나 클라우드 공급자에 의존하지 않는다.

| 검증 ID | 시나리오 |
|---------|----------|
| T-SEC-WIRE-01 | 기존 text 요청은 하위호환으로 통과한다. |
| T-SEC-WIRE-02 | stdio/gRPC decode가 caller의 `actualDestination`을 폐기한다. |
| T-SEC-WIRE-03 | Discord의 profile 누락·신뢰 binding 누락·범위 불일치를 거부한다. |
| T-SEC-WIRE-04 | inline secret과 잘못된 공개 이벤트를 값 반사 없이 거부한다. |
| T-SEC-WIRE-05 | 공개 이벤트가 downstream 또는 error보다 항상 먼저 계획된다. |
| T-SEC-WIRE-06 | consent ID 재사용, 만료 경계, destination/session/profile/workload 불일치를 거부한다. |
| T-SEC-WIRE-07 | proto 필드 번호·enum·오류 코드와 양쪽 codec이 고정 계약을 지킨다. |

## UC-DISCORD-RUNTIME — 개인 Discord 서버에서 Naia에게 질문한다

- 사용자는 개인 Discord bot을 지정한 guild/channel에 연결하고, 허용된 사용자가
  bot mention 또는 bot 응답에 대한 reply로 질문하게 한다.
- 수신 이벤트는 Discord Gateway가 인증한 식별자로만 판정한다. message 본문이나
  모델 출력은 guild/channel/user binding과 처리 profile을 바꿀 수 없다.
- 허용된 질문은 기존 `ChatTurnHandler`에 전달되며, 같은 Discord 메시지에 답한다.
  guild/channel마다 대화 기록과 session id가 분리된다.
- 재연결로 같은 binding/message id가 다시 전달되면 durable reply state가 provider
  재실행을 막고, crash 시에는 저장된 outbox의 아직 보내지 않은 chunk부터 재개한다.
- 종료 시 Gateway와 진행 중 turn을 취소하고, token·메시지 원문·응답 원문은 기본
  진단 로그에 남기지 않는다.

| 검증 ID | 시나리오 |
|---------|----------|
| T-DISCORD-RT-01 | 정확한 binding의 mention/reply만 ingress하고 DM·bot·self·비허용·일반 대화는 0회 처리한다. |
| T-DISCORD-RT-02 | 인증 이벤트를 `ChatRequest.channel/processing/sessionId`로 변환하고 같은 message에 안전한 reply를 보낸다. |
| T-DISCORD-RT-03 | 두 binding/guild/channel/user의 bounded history가 섞이지 않는다. |
| T-DISCORD-RT-04 | reconnect/crash replay와 같은 id의 다른 binding을 durable outbox 상태로 구분하고 completed/partial을 정직하게 보존한다. |
| T-DISCORD-RT-05 | Gateway RESUME/backoff, 4013/4014 terminal, stop 중 연결·turn·429 retry 취소, 비밀 없는 generation status를 결정론적으로 검증한다. |
| T-DISCORD-RT-06 | 2,000자 분할·총 응답 상한·rate limit·권한/intent 오류가 bounded하고 원문·token을 로그에 남기지 않는다. |
| T-DISCORD-RT-07 | 실제 Discord token을 쓰는 test guild smoke는 별도 opt-in live 검증으로만 수행한다. |
| T-DISCORD-RT-08 | 친구 code와 처리 consent가 exact scope+expiry+one-time atomic claim을 지키고 평문 code를 저장하지 않는다. |
