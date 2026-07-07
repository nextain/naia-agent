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
| UC-WORKSPACE-CTX | 코어가 워크스페이스 컨텍스트(cwd + 프로젝트 이름 목록)를 system prompt 에 경량 포함 → 에이전트가 자기 워크스페이스를 인식 | `docs/requirements.md` FR-WORKSPACE-1~4 (집약) |
| UC-FS-TOOLS | 에이전트가 **직접 도구**로 워크스페이스 내 파일을 나열/읽기(기본), opt-in 으로 쓰기/셸 실행 — allow-root sandbox + 민감경로 denylist + realpath 재검증(TOCTOU) + tier 승인 | `docs/requirements.md` FR-FS-1~8 / NFR-SEC (집약) |
| UC-KNOWLEDGE | 코어가 컴파일된 워크스페이스 지식(KB)을 **풀 도구**(`skill_knowledge_search`/`ask`)로 노출 → 에이전트가 근거 있는 답변·근거 없으면 기권. + **컴파일 트리거**(`CompileKnowledge` RPC, K1b — 소스 폴더→kb.json). memory(푸시)와 분리된 풀(tool) | `docs/requirements.md` FR-KB-1~5 (집약) |
| UC-HLMEM | 인간유사 기억 **측정**(memory-as-user-model) — 장기기억이 사용자의 held-out 선택을 예측하나(F1 취향), 본인 기억이 예측하고 타인 기억은 오도하나(F2 자아특이성), 감정 salience 가중(F3, P6). vs 완벽회상 아님. 벤치(benchmark/src) 측정, 실행경로 아님 | `docs/progress/99.dev-comm/UC-HLMEM-humanlike-memory-measurement-contract-2026-07-07.md` + `docs/requirements.md` FR-HLMEM-1~7 |

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

## Test Coverage Map

| 요구 | 테스트 |
|------|--------|
| UC-HLMEM / S-HLMEM-F1·F2 / FR-HLMEM-1~6 (결정론 코어·지표) | `benchmark/src/humanlike/*.test.ts`(fixture-replay: 파싱·trace 분류·predictionAccuracy·selfSpecificity·위치편향 중화) [P3] |
| UC-HLMEM / FR-HLMEM-7 (라이브 e2e, opt-in) | `benchmark/src/humanlike/live-sut` 실 MemoryPort+ProviderPort 1회 e2e(matched>blind) [P5, NAIA_PROD_KEY 게이트] |
| UC1 | `src/test/uc1-agent.contract.test.ts`, `uc1-*-provider.contract.test.ts` |
| UC5 | `src/test/uc5-*.contract.test.ts`, `uc5-tool-loop-stdio.integration.test.ts` |
| UC-provider-provenance | `src/test/uc-provider-provenance.contract.test.ts`, `uc-keychain-credentials.contract.test.ts` |
| UC-MEM-1 / FR-MEM-1·2·4 | `src/test/uc1-memory-stdio.integration.test.ts` (실 stdio 2턴 recall→inject→provider) |
| FR-MEM-5 격리 / FR-MEM-6 영속·드레인 / FR-MEM-7 bounded / FR-MEM-8 프레이밍 | `uc1-memory-stdio.integration.test.ts`(scope·persist·drain·concurrent·bounded·framing·neutralize) |
| FR-MEM-3 fault-injection(불변식) | `uc1-memory-stdio.integration.test.ts`(recall/save throw·hang → finish 1회·error 없음·usage 1회) |
| 실 프로세스 lifecycle | `src/test/uc1-memory-process.integration.test.ts`(EOF→drain→close→flush, save 영속) |
| FR-MEM-12 / S-MEM-SUBLLM (naia sub-LLM 폴백 + graceful degrade, S5) | `src/test/uc-naia-settings-store.contract.test.ts` — describe "naia sub-LLM model 폴백 + graceful degrade (S5/G5)" (naia+모델부재+키존재→기본모델 완전구성·명시모델 우선·키 부재→provider=none 강등(메모리 유지)·vllm baseUrl 누락→none 강등) + `sub-llm-provider.contract.test.ts`(미구성=undefined) |
| UC-PROV-1 / FR-PROV-1·2·3 | `src/test/all-providers-wiring.contract.test.ts`, `uc1-reload-default-config.contract.test.ts`, `uc-naia-settings-store.contract.test.ts` |
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
