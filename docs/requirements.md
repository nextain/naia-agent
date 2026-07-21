# Requirements (P03) — FR / NFR

정본 요구사항 인덱스. UC 별 FR/NFR 의 권위 계약서는 `docs/progress/99.dev-comm/UC*-contract*.md` 이며, 이 문서는
집약 인덱스다(SDLC P03 산출물). UC1/UC5/provider-provenance FR 은 각 계약서 참조.

## UC-memory FR/NFR (FR-MEM-1 ~ 8)

권위 계약서: `docs/progress/99.dev-comm/UC-memory-recall-save-contract-2026-06-12.md`.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-MEM-1 | 턴 전 recall — *이 턴의 새 user 입력*(마지막 메시지가 user 일 때)로 `recall(query)→RecalledMemory`, domain formatter 로 블록화해 systemPrompt 주입. abort+deadline(5s) race. | Done |
| FR-MEM-1a | 빈/공백 query = backend 호출 없이 빈 회상(무관 민감정보 주입 방지). | Done |
| FR-MEM-2 | 턴 후 save — provider 최종 응답=커밋 지점에서 user+assistant(턴 전체 텍스트) 저장. save→finish 순서. deadline(5s) bound. 취소 의미="저장된 턴=finish 된 턴". | Done |
| FR-MEM-3 | 옵셔널·비파괴 — memory 미주입=무회귀. recall/save throw·hang·로거 throw 해도 턴 유지(terminal 1회·usage 1회 불변식 보존). | Done |
| FR-MEM-4 | 실 import — 어댑터가 `@nextain/naia-memory` MemorySystem(LocalAdapter) 실제 사용. | Done |
| FR-MEM-5 | project 격리 — scopeMode "strict" 기본(soft 누설 차단). | Done |
| FR-MEM-6 | 종료 드레인·영속 — EOF 시 drain→close(flush)→stdout flush→exit. 30s 종료 grace 안전망. | Done |
| FR-MEM-7 | bounded 주입 — 항목/블록 하드 캡, 프레이밍 floor 보존(body 만 절단). | Done |
| FR-MEM-8 | 비신뢰 회상 — 신뢰 경계 표시 + 직접 경계-위조 방지(완화책; 모델 순응 차단은 *미보장*, 잔여 위험 명시). | Done |
| FR-MEM-9 | 단일-project-per-process + workspace identity = 영속 UUID(`<adkPath>/.naia/workspace-id`). 정본: override → UUID → 실패 시 memory 비활성(fail-closed). 이동 연속·경로 재사용 누설 차단·동시부팅 배타생성. makeNaiaMemory project 필수+비공백. | Done |
| FR-MEM-10 | 출처 보존 — recall 이 episode role(user/assistant) 보존, formatter 가 사용자 진술/assistant 생성물(미검증) 구분(자기증폭·확증루프 방지). | Done |
| FR-MEM-11 | adapter/embedding/LLM 선택 배선(issue #7) — os 메모리 UI 의 `memoryAdapter`(local/qdrant)·`memoryEmbeddingProvider`(none/offline/vllm/ollama/naia)·`memoryLlmProvider`(none/vllm/ollama/naia, factExtractor) 선택이 config.json→`loadMemoryConfig`→`makeNaiaMemory`(`buildEmbeddingProvider`/`buildMemoryFactExtractor`)로 런타임 반영. 이전엔 LocalAdapter+키워드-only+휴리스틱 하드코딩이라 UI 선택 무시(silent no-op)였음. 미설정=local+키워드-only+휴리스틱(무회귀). qdrant=embedding 필수, embedding/LLM=baseUrl·model 필수 fail-closed. 비밀(*ApiKey)은 셸 strip→**키체인 정식 기록**(#18: NAIA_MEMORY_*_API_KEY, naiaKey=NAIA_ANYLLM_API_KEY)+env override 폴백. 부팅 1회(라이브 변경=재시작 반영). compaction **summarizer 도 same small-LLM 으로 배선**(buildMemorySummarizer→naia-memory buildLLMSummarizer, 실패 시 결정론 recap 폴백=무손실). embedding offline=GPU/CPU/auto device. 실 backend I/O(원격/모델다운로드/라이브 qdrant/LLM 출력 품질)=naia-memory 책임+외부자원(헤르메틱 범위 밖). | Done |
| FR-MEM-12 | naia sub-LLM config 보강 + graceful degrade(S5/G5) — `memoryLlmProvider:"naia"` 일 때 `loadMemoryConfig` 가 sub-LLM 을 게이트웨이로 완전 구성: baseUrl=`naiaGatewayUrl`/`NAIA_ANYLLM_BASE_URL`(기본 api.nextain.io), key=naiaKey(키체인 NAIA_ANYLLM_API_KEY), model=`memoryLlmModel` **부재 시 기본 게이트웨이 경량 모델**(`gemini-3.1-flash-lite`, FR-SLOT.3 정합). 근본 원인: naia-os SettingsTab 이 provider="naia" 일 때 model 입력란을 렌더하지 않아(vllm/ollama 만) `memoryLlmModel` 누락 → 폴백 없으면 model 누락이 makeNaiaMemory 의 fail-closed throw 를 유발해 **메모리 전체 OFF**(G5: "memory=off"). **graceful degrade**: sub-LLM 을 깨끗이 구성 불가하면(baseUrl/model 누락, 또는 naia 인데 key 부재로 게이트웨이 호출 불가) `llm.provider` 를 `none` 으로 강등 → factExtractor/summarizer=undefined(휴리스틱·결정론 recap) → 메모리는 embedding/키워드 회상·저장으로 **계속 동작**(LLM 추출/요약만 생략). 즉 sub-LLM 부재가 memory 전체를 죽이지 않는다. | Done |

### NFR
- 헥사고날 경계: domain 순수(formatRecalledMemory)·app 포트만·adapter 데이터만(프롬프트 정책 비누출).
- 불변식: terminal 래치(finish XOR error 1회)·usage=terminal 직전 1회·registry finally 해제 — memory 경로 무영향.
- recall 정확성은 content+project 기반(session/encode 순서 무관) → 동시 턴 교차 안전.
- NFR-MEM-degrade(S5): sub-LLM(메모리 factExtractor/summarizer) 미구성/구성불가는 memory 전체를 비활성하지 않는다. `loadMemoryConfig` 가 구성불가 sub-LLM 을 `provider:"none"` 으로 강등(매핑 경계 graceful) → recall/save·embedding 은 보존, LLM 기반 추출/요약만 생략. memory identity 키 = **workspace-id(`resolveWorkspaceId`, 영속 UUID)** — persona userName(FR-PERSONA, S1b)과 직교(키 분리, identity split 없음).

## UC-KNOWLEDGE FR/NFR (FR-KB-1 ~ 6) — 워크스페이스 지식 풀 도구 + 컴파일 + 보안 가드

설계 SoT: 루트 `.agents/progress/naia-kb-compiler-agent-os-integration-2026-06-29.md` (K1a·K1b). memory(푸시)와 분리된 풀(tool). KB 컴파일/서빙=외부 엔진(naia-kb-compiler), 코어는 도구 노출 + 컴파일 트리거.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-KB-1 | 코어가 컴파일된 워크스페이스 KB 를 **풀 도구**로 노출 — `skill_knowledge_search`({query,k?})·`skill_knowledge_ask`({query}) ToolExecutorPort. **읽기 전용**(tier 없음, 승인 불요). 쓰기/컴파일/재인덱싱은 본 도구에 없음(K1b). | Done |
| FR-KB-2 | backend 주입(DI)·비종속 — 어댑터는 `KnowledgeBackend`(search/ask) 주입. naia-kb-compiler `openWorkspaceKnowledge` 결과 매핑(D03 교체가능). 미주입/미가용 = 정직 unavailable(throw 아님). 코어가 특정 엔진을 import 하지 않음(비종속). | Done |
| FR-KB-3 | 결과 직렬화·출처 보존 — execute output=JSON. `ask`={abstained,answer,sources[{title,sourceUris}]}·`search`={hits[{title,snippet,score,sourceUris}]}. **sourceUris 보존**(근거→원문 키, naia-os 칩 렌더). 구조화 citation(cardId/snippet) 확장은 후속(K5). | Done |
| FR-KB-4 | no-throw·기권 — 실패/미가용/잘못된 인자 → `{output,isError:true}`(throw 금지, 루프 안정). abort 만 reject(2가드: 진입/await 후). 근거 없으면 backend 가 abstained=true(지어내지 않음, 안전). | Done |
| FR-KB-5 | **컴파일 트리거(K1b)** — gRPC `CompileKnowledge(adkPath)` RPC 가 셸 소유 `naia-settings/knowledge.json`(scope·sources)을 **읽어**(에이전트는 config 쓰기 없음 — naia-os FR-KB-OS.9 대칭) 등록 폴더(.md/.txt) → kb-compiler `compile()`(오프라인 결정론) → `knowledge/<scope>/kb.json` 영속. 통계({ok,scope,source/card/entity/relationCount,error?}) 반환. no-throw(미주입/실패=ok:false+error). backend 주입(DI·D03 비종속). | Done |
| FR-KB-6 | **보안 가드(K-SEC)** — R2 적대리뷰의 "구호" 4종을 강제 코드로 전환: ①**설정 쓰기-펜스**(`isSettingsWriteFenced`, fs-sandbox): 에이전트 `write_file` 가 `naia-settings/` 쓰기 거부(읽기는 허용 — provider/지식 config) = FR-KB-OS.9 "AI 가 설정 못 건드림" 강제(realpath 해소 후 판정, symlink 우회 차단). ②**compile scope 경로탈출 방지**(`isValidKnowledgeScope`): 구분자/`..`/드라이브 scope 거부 → `knowledge/<scope>` outDir 워크스페이스 밖 탈출 차단. ③**extract 인젝션 안전**: 컴파일 추출=오프라인 결정론(Markdown, LLM 미사용)이라 자료 심긴 프롬프트 미해석=인젝션 surface 0(LLM 추출 전환 시 비신뢰 격리 필요 — 코드 명시). ④**memory↔knowledge 분리**: 컴파일은 `knowledge/<scope>/` 만 영속, naia-memory store 미접촉(누수 0). | Done |

### NFR
- 헥사고날: adapter(backend 주입)·코어 비종속. 읽기 전용(쓰기/컴파일 분리=K1b).
- memory(push)↔knowledge(pull) 분리 — 매 턴 자동주입 아님(에이전트 판단 호출), 저장소·주입 경로 분리. 조직지식↔개인기억 비혼합.
- 실 backend(KB 컴파일/검색 품질·`openWorkspaceKnowledge` in-process 배선)=naia-kb-compiler + compose(K1a-2) 책임(본 어댑터 계약 범위 밖, fake 로 계약 검증).

## UC-PROV FR/NFR (FR-PROV-1 ~ 6, FR-MODEL-1)

권위 계약·검증: 아래 FR-PROV-1~6·FR-MODEL-1 표 + Test Coverage Map 의 계약 테스트
(`src/test/all-providers-wiring.contract.test.ts` 등). 상세 진행기록은 메인테이너 워크스페이스 보관(repo 외부).

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-PROV-1 | config-first precedence — naia-settings `loadMain` 이 `config.json`(naia-os 셸 정본)을 `llm.json`(구 CLI)보다 먼저 읽는다. desktop SoT 원칙; stale `llm.json` 이 UI 선택(config.json)을 그림자 처리(shadow)해 openai-compat 크래시를 유발하면 안 됨. | Done |
| FR-PROV-2 | 라이브 설정 reload (R1-2) — 사용자가 naia-os 에서 provider/model 교체 → OS 가 naia-settings 갱신 후 `ReloadSettings`/`SetWorkspace` 재호출 → agent 가 활성 `defaultConfig` 를 재기동 없이 swap. startup-only 금지(R1-2). | Done |
| FR-PROV-3 | native host-override gating — `naiaGatewayUrl`/`NAIA_ANYLLM_BASE_URL` 는 nextain(lab-proxy) 전용. native provider 는 고정 공개 endpoint(또는 `vllmHost`/`ollamaHost`/`llm.json` baseUrl). config 에 남은 stale `naiaGatewayUrl` 이 native provider 를 오라우팅하지 않도록 게이트. | Done |
| FR-PROV-4 | anthropic·claude-code-cli 연결 — Anthropic Messages API(`/v1/messages`, `x-api-key`, `anthropic-version`) 전용 어댑터(raw fetch, SSE). claude-code = SDK/API 패러다임(CLI 바이너리 아님). text/tool_use(`input_json_delta`)/usage/thinking 매핑 + tool_result 병합 + prompt caching(`cache_control` on system). 키=`ANTHROPIC_API_KEY`(credentials 포트). 비용 레지스트리에 모델 등재(claude-sonnet-4-6 등). naia-os 전 9 provider 연결 완성. | Done |
| FR-PROV-5 | claude-code-cli = Claude Agent SDK 분리(2026-06-18) — `claude-code-cli` 는 anthropic(Messages API 직접키)에서 격리된 `claude-code` 라우트로, `@anthropic-ai/claude-agent-sdk` `query()`(로컬 Claude Code 구독 인증)를 사용. **apiKey 불요**(keychain `ANTHROPIC_API_KEY` 매핑 제거 → null), naia-settings `claude-code` 분기는 secret/baseUrl 미주입(구독을 직접키로 오인 금지). 비용 = $0(`SUBSCRIPTION_PROVIDERS` + chat-turn-handler `costProvider` 분기 — 동일 model ID 의 anthropic 직접키와 구별). | Done |
| FR-PROV-6 | ollama native tool_calls (UC5 §H, 2026-07-15) — `makeOllamaProvider` 가 `opts.tools` 를 native `/api/chat` 로 전송하고 `message.tool_calls`(완성체, arguments=object)를 toolUse chunk 로 파싱, tool-bearing 메시지(assistant.toolCalls·tool role+`tool_name` 복원) 매핑. tools 미지원 모델(400 "does not support tools")은 **tools 제거 1회 재시도**(graceful degrade — 순수 챗 유지). 배경: 시연 프로파일 provider=ollama 전환 시 어댑터가 tools 무시 → 스킬 전멸(회귀). 실측: ollama 0.32.0 + DNA 3.0 9B 왕복 확인. 권위 계약 = `docs/progress/99.dev-comm/UC5-agent-tool-loop-contract-2026-06-10.md` §H. 적대리뷰 = `.agents/reviews/r-fr-prov-6-ollama-tools-2026-07-15.json` (PASS). | Done |
| FR-MODEL-1 | 모델 카탈로그 최신화 + registry↔cost 정합(2026-06-18) — registry(naia-os shell)의 native(per-token) provider 모델 ID 전부가 agent `cost.ts` MODEL_PRICING 에 등재되어야 한다(과금 0 회귀 금지; zai/glm 통째 누락이 회귀였음). 모델 ID 는 공식 문서로 확정(환각 금지), default 는 검증된 최신 ID 만 승격. 계약: `uc-provider-provenance` cost↔registry 정합 describe + naia-os `registry.test.ts` 카탈로그 정합. | Done |

### NFR
- 직교(orthogonality): transport=gRPC adapter only(domain unaware). provider-wiring 경로가 도메인 계층을 인지하지 않음 — 어댑터/설정 경계만 통과.

## UC-CLI FR/NFR (FR-CLI-1 ~ 6) — 단독 CLI 오케스트레이션

권위 계약서: `docs/progress/99.dev-comm/UC-cli-orchestration-contract-2026-06-22.md`.
컷오버 누락 역량(구 `backup/main-2026-06-22` 보존)의 신 헥사고날 arch 편입. 단계 2a→2c, naia-os 배선=후속.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-CLI-1 | **SubAgentPort (semantic)** — `spawn(taskSpec)` → sub-agent 세션 이벤트 스트림(planning/tool_use/text/session_end), `cancel(reason)`. domain/app 은 PID/SIGTERM/stdout/exit code 등 메커니즘을 모른다(adapter 캡슐화). | Done |
| FR-CLI-2 | **SupervisorApp (app)** — sub-agent 이벤트 ⊕ workspace 변경 스트림 merge(인과/세션 순서 보존, terminal 드롭 0), `session_end` 시 verify(실패/중단 포함) → filesChanged/additions/deletions/verification 수치 **정직 리포트** emit. | Done |
| FR-CLI-3 | **Interrupt** — `cancel` → SIGTERM → 유예(500ms) → SIGKILL, terminal 이벤트/리포트 정확히 1회. 단독 CLI "stop"/Ctrl+C 경로(adapter 메커니즘). | Done |
| FR-CLI-4 | **roster 어댑터** — `adapter-pi`/`adapter-opencode-cli`(+레퍼런스 `adapter-shell`)가 SubAgentPort 구현. 선택 명시(pi/opencode/claude-code/codex/gemini), 미설치=정직 unsupported(throw 아님). | Done |
| FR-CLI-5 | **VerifierPort** — test/lint/build/typecheck/shell runner 병렬, **never-throws**(실패/타임아웃/도구부재/malformed→구조화 수치 실패 리포트). domain 은 runner 이름 모름. | Done |
| FR-CLI-6 | **WorkspacePort** — 파일 변경 요약 스트림(added/modified/deleted + 수치). domain 은 git diff 포맷 모름(adapter=chokidar+git). | Done |
| FR-CLI-7 | **CLI 대화 host (S1 멀티턴 REPL)** — `naia-agent chat` 가 stdio/readline **AgentIngressPort/AgentEgressPort** 어댑터를 gRPC 와 **동일 `wireAgentUC1`** 에 주입. 매 입력이 누적 history 와 함께 `ChatRequest` → 맥락 유지 멀티턴. emit(text)→stdout 스트리밍, finish→assistant 턴 history append+재프롬프트, error→격리(턴만 실패·루프 생존), Ctrl+C=현재 턴 cancel. | Done |
| FR-CLI-8 | **CLI 로그인 (S1 자격증명)** — `naia-agent login --provider <p> [--key <k>\|stdin]` → 자격증명 영속(홈 `.naia-agent/.env` 0600, 옛 CLI 호환·크로스플랫폼; Linux 추가 secret-tool). chat host 기동 시 로드 → resolver/credentials 포트가 읽어 provider 연결(키 인자 없이 대화). | Done |

### NFR
- **직교**: domain/app 이 subprocess/git/transport 미import(`import-boundary.contract.test.ts` green). fake 포트로 supervisor 결정론 검증.
- **NFR-CLI-shared (단일 파이프라인 — 병렬 금지)**: CLI 대화 host 와 gRPC host(naia-os 경로)는 **동일 deps 빌더 `scripts/builds/compose-agent-deps.mjs` + 동일 `wireAgentUC1`** 공유 — provider resolver·credentials·naia-settings·toolExecutor·memory·conversationLog 가 literally 같은 어댑터. CLI 는 transport(stdio ingress/egress)만 다름. 별도 대화 엔진/도구루프/creds 경로 신설 금지(검증: 두 host 가 같은 `compose-agent-deps` 를 import).
- **결정론 계약**: stream-merge·interrupt·infra 처리를 fake 어댑터로 계약테스트(실 subprocess 무의존).
- **로깅**: src 표준 로깅(DiagnosticLog 포트)만, console.* 금지(F-LOG-3).
- **NFR-SEC-1 (로그 시크릿 마스킹)**: DiagnosticLog sink 가 write 직전 `adapters/redact.ts`(`redactSecrets`)로 알려진 키·토큰(sk-/AIza/ghp/xox/AKIA/gw/JWT + apiKey/password/token 키문맥)을 `[REDACTED]` 마스킹 — 평문 자격증명의 stderr 누출 방지(best-effort defense-in-depth, 1차 방어=로그금지 규율). 검증 `redact.contract.test.ts`(26 케이스, codex 적대 7R). 재감사 2026-06-23.

## UC-PANEL FR/NFR (FR-PANEL-1 ~ 5) — 환경 panel skill (BGM·브라우저·workspace)

| FR | 요구 | 상태 |
|----|------|------|
| FR-PANEL-1 | **PanelSkillPort 동적 등록** — 셸 `RegisterPanelSkills(panel_id, specs[])` → agent 동적 toolExecutor 합성(builtin 과 composite)해 LLM 노출. `ClearPanelSkills` 로 제거. spec=name/description/parameters_json/tier. | 예정 |
| FR-PANEL-2 | **원격 위임(intent emit)** — LLM 이 panel tool call → 실행 대신 `panel_tool_call`(AgentEvent) emit. agent 는 환경을 실행하지 않음(E1, brain-body-environment). | 예정 |
| FR-PANEL-3 | **결과 주입** — 셸 `PanelToolResult(request_id, tool_call_id, output, success)` → chat 루프가 pending(requestId+toolCallId) 매칭해 tool_result 주입 후 라운드 계속. | 예정 |
| FR-PANEL-4 | **비동기 안전** — 원격 실행 대기 중 timeout(기본값)·취소·agent-down·다중 동시 tool call 매칭(pending map 누수 0). terminal 1회·usage 1회 불변식 보존. | 예정 |
| FR-PANEL-5 | **무회귀** — panel skill 미등록 = 기존 builtin tool 즉시 실행 경로 무영향. tier 승인 게이트 그대로 적용. | 예정 |

### NFR
- **직교**: domain/app 은 panel tool 의 transport(gRPC)·셸 실행을 모름(`PanelSkillPort` 캡슐화, `import-boundary` green 유지).
- **NFR-efferent-async 정합**: 원격 panel 실행 = async + interruption + 결과 매칭. 동기 가정 하드코딩 금지.

## UC-PERSONA-CLI FR/NFR (FR-PERSONA-1 ~ 3) — 워크스페이스 페르소나 기본 주입

집약 인덱스(권위 = 본 표 + Test Coverage Map 의 `uc-persona-compose.contract.test.ts` +
`uc-persona-handler.contract.test.ts`). **코어(`ChatTurnHandler`)가** 워크스페이스 설정의 페르소나(Alpha)를
system prompt 로 **스스로 합성**해, 단독 CLI(`naia-agent-chat`)·gRPC(naia-os) 어디서든 `--system` 없이도
알파로 응답하게 한다. SoT = `<adkPath>/naia-settings/config.json`(naia-os 가 읽고 쓰는 동일 파일 →
ghost-edit split 없음). **조립 위치 = 코어**(host 아님): host 는 `PersonaSourcePort` 만 주입하고
페르소나를 클라이언트가 보내지 않는다. `req.systemPrompt` = **순수 override** 계약.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-PERSONA-1 | **순수 합성 계약(`composePersonaPrompt`)** — domain 순수 함수(무 I/O). base = `systemPromptPrefix`(있으면) ?? `personaText` ?? 기본. agentName 치환 후 컨텍스트 줄을 naia-os `buildSystemPrompt` **순서**(userName → honorific[formality locale 만: ko/ja/de/fr/es/hi/vi/ru/pt/id/ar] → locale "Respond in <Lang>" → speechStyle formal/casual 지시)대로 append. 아바타/환경 전용 **emotion-tag 블록 제외**(CLI 무 아바타). profile 이 사실상 빈 값이면 `""` 반환(= 페르소나 기본 없음). | Done |
| FR-PERSONA-2 | **SoT 읽기(`PersonaSourcePort`)** — `load()` 가 `<adkPath>/naia-settings/config.json` + 내장 `persona` JSON 문자열을 파싱해 `PersonaProfile`(agentName/userName/honorific/speechStyle/locale[=NAIA_LOCALE]/systemPromptPrefix/personaText)로 매핑. `fs` 주입(node:fs-like, 어댑터 DI 패턴). 파일 부재/JSON 손상/`persona` 파싱 실패/필드 누락 = **no-throw**(undefined 필드로 degrade, 파일 부재=undefined 반환). 별도 페르소나 소스 신설 금지(config.json 유일 SoT). | Done |
| FR-PERSONA-3 | **코어 조립 + override 계약(S1b)** — `ChatTurnHandler` 가 `HandlerDeps.personaSource?`(optional `PersonaSourcePort`)를 받아 **코어 안에서** `composePersonaPrompt(personaSource.load() ?? {})` 로 페르소나를 조립한다. assemble 에 넘기는 systemPrompt = **`req.systemPrompt`(override) 우선, 없으면 코어 조립값**(빈 문자열은 `undefined` 로 정규화). compaction recap·memory recall 은 이 base 위에 그대로 누적(무영향). `personaSource` 미주입 = 기존 동작(`req.systemPrompt` 만, 무회귀). host(`bin/naia-agent-chat.mjs`·`agent-stdio-entry.mjs`)는 `compose-agent-deps` 가 만든 `personaSource` 를 `wireAgentUC1({ personaSource })` 로 주입하고 **자체 조립·주입하지 않는다**(과도기 `personaSystemPrompt` host 합성 경로 제거). `compose-agent-deps` 는 로그용 `personaLabel`(personaSource.load() 1회 추출) 만 반환. config.json 은 per-turn 1회 읽기(라이브 편집 반영). | Done |

### NFR
- **NFR-PERSONA-pure**: `domain/persona.ts` 순수(fs/process/transport 미import) — `import-boundary.contract.test.ts` green 유지. config 읽기는 adapter(`fs` 주입), **조립은 코어(app/ChatTurnHandler 가 domain 순수 fn import)** — app←domain 허용 방향이라 경계 무위반.
- **NFR-PERSONA-deterministic**: 계약테스트는 fake fs/fake provider + 고정 profile 로 결정론. 합성 단언은 contains 기반(brittle full-string 금지).
- **NFR-PERSONA-no-import**: naia-os `persona.ts` 는 **참조만**(import 금지) — CLI 측 재구현. emotion-tag 블록은 naia-os 전용 유지(중복 아님 — 의도된 분기).
- **NFR-PERSONA-core-owned**: 페르소나 조립은 **코어 소유**(host 조립·`req.systemPrompt` 로 주입하는 과도기 경로 금지). 식별자 `personaSystemPrompt` 는 코드베이스에 잔존하지 않는다(grep 0).
- **NFR-PERSONA-locale-normalize**: locale 은 `composePersonaPrompt` 진입에서 **primary subtag 정규화 1회**(BCP-47 — `-`/`_` 분리 첫 토큰 소문자화: `"ko-KR"`/`"ko_KR"`/`"KO"` → `"ko"`). `localeToLanguage`/`FORMALITY_LOCALES` lookup 이 region/script subtag 로 silent 영어 폴백·formal 강제되던 결함을 닫는다(한국어/말투 보존). speechStyle 은 소문자화 후 `"casual"` 매칭만 신뢰 — 미지값(`"banmal"` 등)은 **formal 안전 기본**(존댓말; casual 오입력이 조용히 반대로 가지 않게).
- **NFR-PERSONA-trust-model** (systemPrompt override): `req.systemPrompt` 는 코어 조립(persona⊕workspace⊕environment)을 **무조건 덮는다**(C2). 이는 **신뢰 로컬 단일유저** 모델(C1)에서만 수용 — override 는 **신뢰 로컬 클라(`--system`/voice/discord) 전용**이며, naia-os **텍스트 채팅은 systemPrompt 미전송**(environmentSegments 만 → persona 보존, S4). 악성 클라면 `.keys` 를 직접 읽으므로 wire 게이팅은 무의미(GLM 위협모델 — 클라가 신뢰 경계 안). **원격/멀티테넌트 전개 시엔 override 게이팅이 필요**(미래 작업 — 현재는 미적용). 코드 마커: `adapters/protocol.ts`(systemPrompt decode 주석)·`app/chat-turn-handler.ts`(baseSystemPrompt 결정 주석).
- **NFR-ENV-injection-hardening** (C2 인젝션 차단): 클라 제공 환경 컨텍스트는 *데이터*이지 지시문이 아니다. (1) panel.type **라벨 새니타이즈**(`sanitizeLabel` — 개행/제어문자·`[`/`]` 제거 + 길이 cap `PANEL_TYPE_LABEL_CAP`=64) + panel.data 한줄 강제(제어문자 제거). (2) 워크스페이스 **프로젝트 이름 새니타이즈**(개행/제어문자 제거 + cap `PROJECT_NAME_CAP`=64; 콤마 보존). (3) **크기 cap**: 세그먼트 `MAX_SEGMENTS`=8·panel entry `MAX_PANEL_ENTRIES`=16·렌더 총길이 `MAX_RENDER_CHARS`=4000(초과 절단+마커). 정상 라벨/이름/데이터는 무손실(새니타이즈가 정상값을 망가뜨리지 않음). domain 순수(`environment-segments.ts`·`workspace-context.ts`).

## UC-WORKSPACE-CTX FR/NFR (FR-WORKSPACE-1 ~ 4) — 워크스페이스 컨텍스트 경량 인식

집약 인덱스(권위 = 본 표 + Test Coverage Map 의 `uc-workspace-context.contract.test.ts`). **코어
(`ChatTurnHandler`)가** 워크스페이스 컨텍스트(cwd + 프로젝트 이름 목록)를 **스스로 합성**해 페르소나 조립
**바로 뒤에 append** 한다 → 에이전트가 자기 워크스페이스를 인식. 조립 위치 = **코어**(host 아님): host 는
`WorkspaceContextPort` 만 주입한다. `req.systemPrompt`(override) 시 persona·workspace 둘 다 무시.

★ 설계 제약(GLM 독립리뷰 — snapshot 전량덤프 아닌 retrieval): **경량 shallow 리스팅만** — 프로젝트 이름
(디렉터리명 1-depth) + cwd 뿐. **파일 내용 덤프·깊은 walk 금지**(상세는 read_file 도구=S3). 토큰 bounded.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-WORKSPACE-1 | **순수 합성 계약(`composeWorkspaceContext`)** — domain 순수 함수(무 I/O). `WorkspaceSnapshot`(cwd·projects[cap 적용]·projectTotal) → `## Workspace` 블록: cwd 줄 + "Projects (<total>): a, b, c[, +N more]" 줄(이름은 **데이터**로 렌더 — 지시문 해석 방지) + "상세는 read_file 도구로(S3)" 안내. cwd·projects 둘 다 없으면 `""`(append 무영향). **토큰 bounded**: 프로젝트 목록은 `PROJECT_RENDER_CAP`(=40)까지만 표기, 초과분은 `+N more` 총계로만(렌더 수백 토큰 상한). 파일 내용/깊은 트리 미포함. | Done |
| FR-WORKSPACE-2 | **경량 스냅샷(`WorkspaceContextPort`)** — `snapshot()` 가 `<adkPath>/projects/` 의 top-level **디렉터리명**(파일/dotfile 제외, 정렬)만 1-depth **shallow readdir** 로 수집 + cwd → `WorkspaceSnapshot`. `projectTotal`=전체 수, `projects`=상위 cap. `projects/` 부재/읽기실패/adkPath 빈값 = **no-throw degrade**(projects=[]·projectTotal=0; adkPath 빈값=undefined). `fs` 주입(node:fs-like `WorkspaceFsRead`=existsSync+readdirSync, 어댑터 DI 패턴). **파일 *내용* 은 절대 읽지 않는다**(snapshot 덤프 방지 — 상세 retrieval 은 read_file UC=S3). | Done |
| FR-WORKSPACE-3 | **코어 조립 + persona 뒤 append(S2)** — `ChatTurnHandler` 가 `HandlerDeps.workspaceContext?`(optional)를 받아 **코어 안에서** persona 조립 직후 `composeWorkspaceContext(workspaceContext.snapshot() ?? {cwd:"",projects:[],projectTotal:0})` 를 합성하고 `[corePersona, coreWs].filter(Boolean).join("\n\n")` 로 합류한다. assemble base = `req.systemPrompt`(override) 우선, 없으면 코어 조립값(persona⊕workspace; 빈 문자열은 `undefined` 정규화). compaction recap·memory recall 은 이 base 위에 누적(무영향). `workspaceContext` 미주입 = 기존 동작(persona/`req.systemPrompt` 만, 무회귀). host(`bin/naia-agent-chat.mjs`·`agent-stdio-entry.mjs`)는 `compose-agent-deps` 가 만든 `workspaceContextSource` 를 `wireAgentUC1({ workspaceContext })` 로 주입하고 자체 조립하지 않는다. `compose-agent-deps` 는 로그용 `wsLabel`(snapshot() 1회 — cwd+프로젝트 수)만 반환. snapshot 은 per-turn 1회(shallow readdir — 라이브 반영). | Done |
| FR-WORKSPACE-4 | **상세는 도구로(범위 경계)** — S2 워크스페이스 컨텍스트는 프로젝트 **이름 + cwd** 까지만 인지시킨다. 파일 *내용*·디렉터리 트리 등 **상세 retrieval 은 `read_file` 도구(S3) 몫**이며, S2 렌더는 그 안내 문구만 포함한다(컨텍스트 폭주 방지, GLM 덤프 금지 정합). | Done |

### NFR
- **NFR-WORKSPACE-pure**: `domain/workspace-context.ts` 순수(fs/process/transport 미import) — `import-boundary.contract.test.ts` green 유지. projects/ 읽기는 adapter(`fs` 주입), **조립은 코어(app/ChatTurnHandler 가 domain 순수 fn import)** — app←domain 허용 방향이라 경계 무위반.
- **NFR-WORKSPACE-bounded**: 렌더 결과는 항상 토큰 bounded(프로젝트 cap=40 + "+N more" 총계). 프로젝트 수가 수백~수천이어도 system prompt 증가분이 상수 상한(수백 토큰)을 넘지 않는다. 깊은 walk·파일 내용 없음(상수 비용 readdir 1회).
- **NFR-WORKSPACE-deterministic**: 계약테스트는 fake fs/fake provider + 고정 스냅샷으로 결정론. 합성 단언은 contains 기반(brittle full-string 금지). 프로젝트 이름 정렬로 readdir 순서 무관.
- **NFR-WORKSPACE-core-owned**: 워크스페이스 컨텍스트 조립은 **코어 소유**(host 조립·`req.systemPrompt` 로 주입하는 경로 금지). host 는 포트 주입만.

## UC-FS-TOOLS FR/NFR (FR-FS-1 ~ 8 + NFR-SEC) — 에이전트 직접 파일/셸 도구 + 보안 sandbox

집약 인덱스(권위 = 본 표 + Test Coverage Map 의 `uc-fs-tools.contract.test.ts`). 코어가 **에이전트 직접
도구**(`list_dir`·`read_file`·`write_file`·`shell_exec`)를 `ToolExecutorPort` 로 제공하고, **보안계약(C3 +
GLM 독립리뷰)을 1일차부터 전부 적용**한다. 실행기(realpath/exec)만 클라(host)가 주입하고, 코어가 **도구
spec + sandbox 정책(allow-root) + tier(승인)** 를 소유한다.

★ 이 워크스페이스엔 **실제 키/시크릿**이 있다(`naia-settings/.keys/*.dpapi`·`data-private` 등) → 보안 최우선.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-FS-1 | **도구 spec(`ToolExecutorPort`)** — `list_dir`(디렉터리 항목 나열)·`read_file`(파일 내용)·`write_file`(opt-in)·`shell_exec`(opt-in). 각 spec 의 `parameters` 는 JSON schema. `read_file`/`list_dir` 기본 등록, `write_file`/`shell_exec` 는 `NAIA_SHELL_TOOL=1` 일 때만 specs 노출. | Done |
| FR-FS-2 | **allow-root sandbox(`validatePath`)** — 모든 fs/shell 경로는 allow-root(=`<adkPath>` 워크스페이스 하위)로 resolve 돼야 통과. 밖이면 거부. 정규화 **후** allow-root 컨테인먼트(prefix, 세그먼트 경계) 재검증. 빈 allow-root = deny-all. | Done |
| FR-FS-3 | **경로 탈출 차단(전부)** — `..` 상위탈출, Windows 드라이브 절대경로(드라이브문자+콜론)·UNC(이중 역슬래시), env 확장(퍼센트/달러 토큰), 널바이트 → 전부 거부. raw 단계(env/널바이트/UNC) + 정규화 단계(`..` 해소 시 루트 위로 가면 탈출) 양쪽에서. | Done |
| FR-FS-4 | **민감경로 denylist(allow-root 안이라도 거부)** — `.keys`·`.ssh`·`.git`·`data-private`·`data-business` 세그먼트, `.env`/`.env.*`/`id_rsa`/`id_ed25519` 등 키/자격증명 파일, `.dpapi`/`.pem`/`.key`/`.pfx`/`.age`/`.gpg` 접미사, 브라우저 프로필/토큰 저장소 substring. (`.keys` 유출은 `read_file` 만으로도 치명 — GLM → read 도 거부.) 대소문자/구분자 정규화 후 매칭(`isSensitivePath`). | Done |
| FR-FS-5 | **realpath/TOCTOU 재검증(`realpathSync`)** — 문자열 검증만으론 부족: 실행 시점에 **realpath 로 실제 경로 resolve 후 `validatePath` 재검증**(승인↔실행 사이 symlink/junction swap 방지, GLM f). 부재 파일(write)은 부모 디렉터리 realpath 재검증. **write 대상이 기존 symlink 면 거부**(`lstatSync` — link-follow 외부 덮어쓰기 차단). realpath 는 **주입 fs**(어댑터) — domain 순수 유지. 이 워크스페이스가 junction(naia-memory → projects/naia-memory)을 쓰므로 필수. ⚠️ **잔존 TOCTOU race**: 검증↔read/write 사이 경로 swap 여지(Node 고수준 path API 한계 — 검증·I/O 가 같은 fd 아님). 완전 방어는 OS-level(O_NOFOLLOW/dir-fd `openat`) 필요·Node 표준 미지원 → opt-in+승인+denylist 로 **완화**(NFR-SEC-toctou-residual). | Done |
| FR-FS-6 | **`shell_exec` = argv 스펙 + cwd realpath 재검증** — `command: string[]`(셸 문자열 보간/파이프/리다이렉트 0 = injection 차단). 주입 exec 가 `subprocess-session` 의 injection-safe spawn 헬퍼(`pickSpawnableBin`/`resolveSpawnableBin`/`resolveFallbackCommand`)로 **shell 없이** 실행(Windows .cmd/.bat shim → node+script/.exe). cwd 는 `validatePath` + **realpath 재검증**(지정·기본 cwd 모두 — cwd 의 symlink/junction 탈출 차단, 주입 `realpath`). ⚠️ **shell_exec 은 path-sandbox 가 아님**(NFR-SEC-shell-model 참조) — cwd 만 제한되고 명령 자체의 파일 접근은 제한 안 됨. | Done |
| FR-FS-7 | **tier 승인(기존 ApprovalPort 재사용)** — `read_file`/`list_dir`=`"fs-read"`(gated 감사), `write_file`=`"fs-write"`, `shell_exec`=`"shell"`(상위). `ToolSpec.tier` 설정 시 `chat-turn-handler` 의 기존 게이트(tierOf→prepareDecision→approvalRequest)가 **자동 발화** — 코어 무변경(새 승인 메커니즘 신설 금지). | Done |
| FR-FS-8 | **opt-in + no-throw** — `write_file`/`shell_exec` 는 `NAIA_SHELL_TOOL=1` opt-in(read/list 기본). 도구 execute 는 실패/거부/sandbox 위반 시 `{output, isError:true}`(throw 금지 — 루프 안정, ToolExecutorPort 계약). abort 시에만 reject. | Done |

### NFR
- **NFR-SEC-pure-domain**: `domain/fs-sandbox.ts` 순수(fs/process/transport/`node:path` 미import) — `import-boundary.contract.test.ts` green 유지. 경로 정규화/`..` 해소는 순수 문자열 로직(POSIX 슬래시 정규형). realpath I/O 는 어댑터(주입 fs)가 수행 후 도메인 fn 재호출.
- **NFR-SEC-no-secret-leak**: 민감경로(`.keys`/`.dpapi`/`.env`/SSH 키/`data-private`)는 allow-root 안이라도 read/list/write 전부 거부(denylist). 시크릿/키를 로그·테스트·코드에 하드코딩하지 않는다(F-SEC01 — 테스트는 **가짜 경로만**, 실 키 미접근). `security.test.mjs` green 유지(추적 경로 시크릿 패턴 0).
- **NFR-SEC-no-bypass**: **fs-tools(read/list/write)** 접근은 `validatePath` + realpath 재검증 통과 후에만(`resolveSafe` 단일 경로 — raw 경로 직접 사용 0). shell_exec 의 **cwd** 도 동일하게 `validatePath`+realpath 재검증(`resolveCwd`). 한 군데도 우회 경로 없음. (단 shell_exec 명령 자체는 path-sandbox 대상이 아님 → NFR-SEC-shell-model.)
- **NFR-SEC-deterministic**: 계약테스트는 fake fs(realpathSync/lstatSync 포함)/fake exec+fake realpath 로 결정론(실 파일시스템·실 프로세스 0). 단언은 가짜 경로/가짜 링크 시뮬.
- **NFR-SEC-shell-model (★ shell_exec 보안 모델 — 정직)**: `shell_exec` 은 argv 스펙으로 **셸 injection 은 차단**하지만 **path-sandbox 가 아니다**. argv 로 임의 바이너리(powershell/node/python 등)를 실행하므로 그 명령이 절대경로로 `.ssh`/`.env`/`data-private`/홈 등 **워크스페이스 밖·민감 파일에 접근할 수 있다**(cwd 와 무관). cwd 검증/realpath 재검증은 *작업 디렉터리* 만 제한한다. fs-tools(read/list/write)만 path-sandboxed(allow-root+denylist+realpath). **shell_exec 의 유일한 실효 통제 = opt-in(기본 off, `NAIA_SHELL_TOOL=1`) + tier 승인 게이트 + 신뢰 컨텍스트에서만 활성** 이며 path 격리가 아니다. (per-request capability 강화는 NFR-FS-future-capability — env-var 게이트는 자식 상속으로 약함.)
- **NFR-SEC-denylist-besteffort (정직)**: 이름기반 denylist(세그먼트/파일명/접미사/substring — `.keys`·`secret(s)`·`service-account.json`·`authorized_keys`·`known_hosts`·`-key.json` 등)는 **defense-in-depth(보장 아님)**. 실 secret 이 비표준 이름(예: `prod.txt` 안의 토큰)으로 저장되면 통과할 수 있다. 근본 방어 = **allow-root 최소화**(워크스페이스만) + opt-in + 승인. denylist 는 *알려진* 민감 패턴의 보강 차단일 뿐.
- **NFR-SEC-toctou-residual (정직)**: fs-tools 의 validatePath→realpath 재검증과 실제 read/write 사이, 그리고 write 의 부모 검증↔쓰기 사이에 **잔존 TOCTOU race** 가 있다(Node 고수준 path API 는 검증·I/O 가 같은 fd 아님). write 는 추가로 **대상 symlink 거부**(`lstatSync`)로 link-follow 덮어쓰기를 막지만 부모 swap race 는 완전히 닫지 못한다. **완전 방어는 OS-level(O_NOFOLLOW/dir-fd `openat`) 필요·Node 표준 미지원**(난도 높음) → opt-in(기본 off) + 승인 + denylist 로 **완화**. 코드 주석(fs-tools 헤더/`resolveSafe`)에도 정직 표기.
- **NFR-FS-future-capability**: opt-in 은 현재 env-var 게이트(`NAIA_SHELL_TOOL`) — GLM 지적대로 자식 프로세스 상속으로 약하다. 본 슬라이스의 **핵심 보안은 sandbox/denylist/argv** 이며, **per-request capability**(chat_request 별 capability 토큰으로 도구 활성 범위 제한)는 미래 강화 항목으로 명시한다(코드 주석에도 `@future` 표기).

## UC-THINKING FR/NFR (FR-THINK-1 ~ 4) — 추론(thinking) 모델의 생각 출력 제어

문제: 로컬 추론 모델이 생각(`reasoning`)에 출력 토큰을 다 쓰고 **본문을 한 글자도 못 내는** 일이 발생한다.
빈 응답의 `finish_reason` 은 `length`(잘림)가 아니라 **`stop`** — 컨텍스트를 키워도 낫지 않는다(16k 재현).
실측 근거·대안 검토(무엇이 듣고 무엇이 안 듣는지) = `docs/user-scenarios.md` UC-THINKING.

`enableThinking` 은 **이미 전 구간 배선돼 있다** — `ChatRequest`(`domain/chat.ts:61`) → gRPC/protocol →
`chat-turn-handler.ts:138` → `ProviderConfig.enableThinking`(`domain/chat.ts:10`), 그리고
**anthropic**(`anthropic-provider.ts:80`)·**ollama native**(`ollama-provider.ts:42`) 어댑터가 소비한다.
**OpenAI-compat 어댑터만 이를 무시**하고 있었다. 본 UC 는 그 누락을 메운다.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-THINK-1 | OpenAI-compat 어댑터는 `ProviderConfig.enableThinking === false` 일 때 요청 body 에 **`reasoning_effort: "none"`** 을 싣는다. `true`/미지정이면 **아무 것도 싣지 않는다**(추론 모델 기본=생각 켬, 무회귀). | Done |
| FR-THINK-2 | **로컬 엔진 게이트** — 위 파라미터는 `baseUrl` 이 **loopback/사설망**(로컬 ollama·vLLM)일 때만 붙인다. 판별은 순수 도메인 함수 `isLocalEngineBaseUrl(baseUrl)`(`domain/provider-route.ts`). ⚠️ 셸이 `enableThinking:false` 를 **기본값으로 항상 전송**하므로 게이트가 없으면 gpt-4o·Gemini·GLM 등 **비추론 원격 모델에서 400**. | Done |
| FR-THINK-3 | 게이트는 **어댑터 생성 시점 주입**(`makeOpenAICompatProvider({ supportsReasoningEffort })`) — provider-resolver 가 baseUrl 을 알고 있으므로 거기서 판별해 넘긴다. 어댑터가 URL 을 스스로 해석하지 않는다(헥사고날: 라우팅 판단=domain, 인스턴스화=adapter). lab-proxy(게이트웨이) 경로는 **false**. | Done |
| FR-THINK-4 | 무회귀 — 도메인 계약(`ProviderChunk`·`AgentEmit`)·gRPC proto·다른 4개 provider 어댑터를 **변경하지 않는다**. 기존 계약 테스트의 `toEqual` 단언(예: `all-providers-wiring.contract.test.ts:187`)이 그대로 통과해야 한다. | Done |

**검증(2026-07-15)**: `src/test/uc-thinking.contract.test.ts` **11/11 통과**. 전체 스위트 **945 통과·실패 0**
(회귀 0 — FR-THINK-4 충족). `tsc --noEmit` clean. `check-logging`·`ci-verify-sdlc`·`check-traceability`·
`check-terminology` 전부 통과. ⚠️ `check-file-anchors` 는 RED 4건이나 **모두 본 변경 이전부터 존재**
(HEAD stash 재검사로 확인 — `sub-llm-provider.ts`·`cli-chat.ts`·`sub-llm.ts`·`panel-tool-executor.ts`,
본 변경과 무관·별도 이슈).

### NFR
- **헥사고날**: `isLocalEngineBaseUrl` = 순수 함수(domain, I/O 0). 어댑터는 주입된 boolean 만 본다.
- **회귀 안전**: 추가는 요청 body 의 **선택적 필드 1개**뿐. 응답 파싱·스트림·도구 누산기 불변.
- **정직성**: 로컬 엔진이 미지원 파라미터를 무시한다는 것은 **실측**(ollama 0.32.0). 원격에 대해서는
  보내지 않음으로써 방어한다 — "무시할 것이다"라고 가정하지 않는다.
- **범위 밖(별개 결함 #80)**: 컨텍스트 예산이 도구 스키마를 미계상 / `ProviderChunk.finish` 에 잘림 사유 부재 /
  잘림·빈 응답을 성공으로 오인해 조용히 통과. 셋 다 실재하는 결함이나 **cross-repo wire 변경**(proto `FinishEvent`)
  을 수반하므로 본 UC 와 분리한다.

## UC-CONTINUE-SPEAKING FR/NFR (FR-CONT-1 ~ 8) — 자유 발화와 연속 발화

권위 계약서: `docs/progress/99.dev-comm/UC-CONTINUE-SPEAKING-contract-2026-07-16.md`.
2026-07-18 목표 재정렬에 따라 아래 MVP 요구가 기존 FR-CONT-1~8 hardening보다 우선한다.

| ID | MVP 요구사항 | 상태 |
|----|--------------|:----:|
| FR-CONT-MVP-1 | **두 profile만 지원** — `personal_radio_dj | exhibition_intro`. 범용 활동 profile은 후속이다. | Implemented |
| FR-CONT-MVP-2 | **무입력 선제 시작** — 주입 가능한 idle clock 뒤 app 계층이 먼저 attract 발화를 시작한다. shell 반복 루프는 만들지 않는다. | Implemented |
| FR-CONT-MVP-3 | **개인 라디오 DJ** — 시간·동의한 최신 날씨·같은 세션의 명시적 기분/활동·현재 BGM·workspace-local exact preference index의 명시적 선호를 조립해 추천하고, BGM 성공 뒤에만 재생을 확정해 말한다. Naia Memory는 durable provenance handoff 대상이며 활성 조회 정본이 아니다. 긴 믹스의 현재 곡은 chapter/tracklist 근거 없이는 추측하지 않는다. 제품 수용 추적은 PA-DJ-01~04다. | Done |
| FR-CONT-MVP-4 | **DJ 제어** — grounded DJ 멘트 8회·최근 6문장 반복 0, music-only/말 줄여/말 늘려/다른 분위기/다음 곡/stop, 8시간 bounded lease를 PA-DJ-03/05B/06으로 검증한다. | Done |
| FR-CONT-MVP-5 | **전시 소개** — KB에 근거한 회사·제품·전시 소개 3개를 연속 중복 없이 먼저 말하고, 근거 없이는 추측하지 않는다. | Implemented |
| FR-CONT-MVP-6 | **양보와 복귀** — 관람객/사용자 입력이 현재 발화와 TTS를 중단하고, 답변 뒤 아직 수행 중인 profile의 다음 미소개 항목으로 복귀한다. quiet/stop은 복귀하지 않는다. profile stream epoch로 이전 출력은 폐기하되 yield/resume의 같은 activity는 유지한다. | Done |
| FR-CONT-MVP-7 | **기억·개인정보** — 활동 발화·수동 청취·재생 시간으로 취향을 추론하지 않고, 전시 activity/Q&A는 memory recall/save와 영속 transcript를 기본 사용하지 않는다. 명시적 DJ 선호만 provenance와 durable/idempotent handoff하며 최신 dislike는 같은 subject의 like를 무효화한다(PA-DJ-01, PA-EX-02). | Done |
| FR-CONT-MVP-8 | **실제 증적** — 전체 계약/통합 테스트와 Playwright 7건이 TTS 두 경로·제어 6종·250ms interrupt·stale 폐기·전시 yield/resume를 검증하고, 실제 Tauri WebDriver가 file-backed 설정 저장·cache-clear 재수화·동의 철회를 검증한다. 물리 음질·현장 선호도는 자동 완료 판정 밖의 운영 관찰 항목이다. | Done |

현재 DJ 멘트는 근거 유무를 확인하는 8개 bounded variant를 순환하며 최근 6문장 반복을 피한다.
설정 UI는 profile/idle/interval/timezone/BGM/weather/좌표/knowledge scope를 파일에 저장하고 복원하며,
날씨 위치는 명시 동의가 있을 때만 저장·전달한다. 자유 생성형 라디오 진행이나 물리 음질·현장 선호도는
자동 완료 판정이 아니라 운영 관찰 범위다.

### 운영 안정화 요구사항

사용자 요청과 자유 발화 진입점이 같은 app 계층 활동 런타임을 사용한다. 셸의 기존 TTS를 재사용하고
ordinary chat cancel은 requestId+requestGeneration, requested activity cancel은 stream이 준 activityId까지
사용한다. self-init은
session activity stream, requested activity는 기존 Chat stream의 admission 뒤 첫 완결 text부터 두 ID를
전달한다. 자유 발화 전달·정지에 필요한 session activity stream/stop
RPC만 추가하며, 별도 셸 반복 상태 머신은 만들지 않는다.

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-CONT-1 | **구조 검사가 있는 하이브리드 활성화** — 지속 요청 원문과 별도의 수동 청취 원문이 비어 있지 않고 최신 원문의 서로 포함·겹치지 않는 별도 span이면 즉시 시작한다. 앱은 의미 키워드를 재판정하지 않는다. 지속 요청만/동일·포함·겹친 evidence는 확인으로, 부재 신호만 있으면 일반 종료한다. 빈 sessionId는 텍스트만 일반 응답하고 상태를 만들지 않는다. | Pending |
| FR-CONT-2 | **확인 대기** — pending은 sessionId에 결속해 2분 TTL로 관리하고 다음 턴이 원자 claim한다. supported 확인 tool 성공은 candidate만 만들고 provider-local result 뒤 첫 no-tool text에서 atomic admission한다. 그 사이 race에서 지면 일반 응답이다. 미호출·실패에도 복원하지 않는다. provider가 supported가 아니면 tool 없이 일반 응답·control_unavailable로 강등한다. pending LRU100을 지킨다. | Pending |
| FR-CONT-3 | **자유 발화 진입점·전달** — self-init은 provisional CAS→tryBind lease로 시작한다. requested activity cancel은 requestId+requestGeneration+activityId 세대 토큰이 모두 일치해야 해 stale/cross-kind/reused-requestId cancel을 격리하고, self-init cancel은 requestId+activityId를 쓴다. self-init subscription의 모든 event와 requested Chat의 admission 뒤 첫 완결 text부터 terminal에는 activityId를 싣는다. ID 없는 Cancel이 이미 admission된 activity를 만나면 현재 ID가 든 ACTIVITY_ID_REQUIRED를 반환하고 셸이 한 번 재시도하며, self-init ID 관측 전에는 session Stop을 쓴다. subscription은 100개 상한, duplicate ALREADY_EXISTS, 초과 RESOURCE_EXHAUSTED, disconnect 회수다. stop/cancel 뒤 장기 stream은 재사용한다. memory 계층은 호출하지 않고 transcript=off는 활동을 비활성화한다. | Pending |
| FR-CONT-4 | **같은 스트림·유한 맥락** — supported는 fallback 계약이 있는 adapter만 선언한다. continue control은 첫 provider round에만 제공하고 control-unselected 뒤 제거한다. unknown ordinary chat은 건드리지 않는다. mixed correlation 뒤 admission한다. 활동 후속은 기준점+직전 발화+숨은 지시, 도구 0이다. self-init reason/topic은 trim 후 각각 Unicode code point 500으로 자른다. 내부 객체를 외부에 직접 직렬화하지 않는다. | Pending |
| FR-CONT-5 | **끼어들기·유한 경계** — 하나의 AbortSignal이 provider와 대기를 중지한다. cancel/disconnect는 error(cancelled), Stop은 finish다. cleanup은 5초 상한이다. 기본 10분/최대30분, 간격0~30초, 발화/provider60회, provider round당 4,096 chunk·외부 payload UTF-8 262,144 byte다. requested deadline은 mixed-tool prelude가 끝난 첫 no-tool final text의 atomic admission 시각, self-init deadline은 admission 직후 첫 provider 호출 직전부터 계산한다. `continue_speaking` 또는 확인 제어 도구를 노출하는 첫 provider 호출 직전부터 admission까지 하나의 120초 wall-clock 예산을 적용해 최초 iterator 무응답도 포함하며, candidate 없는 첫 round 뒤 해제한다. 각 next/chunk에서 시계를 검사해 즉시 resolve 무한 stream도 끊고 active watchdog은 멈춘 provider도 deadline finish로 끝낸다. ordinary는 한계 전 streamed prefix를 유지하되 commit하지 않고, 활동 미완 발화는 wire/checkpoint 0이다. | Pending |
| FR-CONT-6 | **증분 대화 로그** — activityId는 handler 최근100과 충돌 검사한다. async queue entry는 enqueue부터 5초 deadline이며 시작 전 만료는 I/O 0이다. exact quarantine1024, 실제 I/O permit8(physical settle 반환), 대기128을 쓴다. 8 hang 포화는 storageOverloaded로 queue/새 저장을 fail-closed한다. ambiguous failure 재시도 금지, 일반 응답은 no-throw다. 성공 commit만 durable이다. | Pending |
| FR-CONT-7 | **장기기억 분리·비용 정합·무회귀** — 활동 발화는 `memory.save`에 쓰지 않는다. 모든 provider usage를 합산해 마지막에 한 번만 방출하고 terminal도 한 번만 방출한다. 일반 단일 응답과 기존 외부 도구 턴의 event correlation·memory/transcript save·terminal 계약을 유지하며 일반 transcript append reject/never-settle은 5초로 격리한다. | Pending |
| FR-CONT-8 | **활동 수명·관측성** — pending/active/terminal 상태와 닫힌 종료 원인을 app 활동 상태가 소유한다. 같은 세션 pending/active는 각각 최대 1개이고 composition-root atomic admission winner만 active가 된다. `speechActivityState(sessionId)`로 count·진행·최근 종료와 bounded `lastCheckpointStatus`/`checkpointFailureCount`를 관측한다. 최근 완료는 LRU 100개 상한이다. provider의 명시적 tool 미지원과 requested 경로의 checkpoint storage 부재도 닫힌 종료 원인으로 상태에 반영한다. | Pending |

### NFR
- **NFR-CONT-agent-owned**: 반복 제어는 app 계층 활동 런타임이 소유한다. 자유 발화 전달에 필요한
  session activity stream/stop만 proto·naia-shell에 추가하고, 반복 상태 기계는 셸에 복제하지 않는다.
- **NFR-CONT-cancellable**: 발화 사이 대기는 AbortSignal과 race하며 타이머/listener를 항상 정리한다.
- **NFR-CONT-bounded**: 시간·횟수·간격이 상수 상한으로 제한되어 무한 자율 실행과 무제한 큐 누적을 막는다.
- **NFR-CONT-deterministic**: 계약테스트는 fake provider, 0초 간격, 주입 가능한 단조 시계로 실제 10분을 기다리지 않고 결정론적으로 검증한다. 로컬 Ollama 검증은 별도 실연동 증거로 남긴다.

## 기타 UC FR

## UC-HLMEM FR/NFR (FR-HLMEM-1 ~ 7) — 인간유사 기억 측정(memory-as-user-model)

권위 계약서: `docs/progress/99.dev-comm/UC-HLMEM-humanlike-memory-measurement-contract-2026-07-07.md`.
측정 하네스(benchmark/src). 실행경로 아님. 정본 seam 계약 준수.

| ID | 요구 | 상태 |
|----|------|------|
| FR-HLMEM-1 | **자동 recall 기준 trace** — 측정은 정본 `MemoryPort.recall`(FR-MEM-1) **자동 회상** 결과로 정의. 모델발화 `<recall>` 마커·"no-recall-attempt/agent-decision" 버킷 없음(정본 대응개념 부재). trace={seedSaved,recallReturnedTarget,memoryInjected,predictionParsed,predictionCorrect,outcome}. | P3 core done / P5 live 대기 |
| FR-HLMEM-2 | **신뢰경계 재사용** — 회상→프롬프트 주입은 domain `formatRecalledMemory()`(FR-MEM-7/8/10, 출처 fail-safe)로만. 벤치 재프레이밍 금지. | Planned(P3/P4) |
| FR-HLMEM-3 | **실 MemoryPort SUT** — seed=`MemoryPort.save`, 회상=`recall`(makeNaiaMemory project-scoped strict). read-your-writes 준수, recall/save throw=fail-open. 주입 plain fn 금지. | Planned(P4) |
| FR-HLMEM-4 | **held-out + 위치편향 제어** — probe 어휘가 seed 와 비겹침(일반화 강제). 옵션→A/B 배정 trial 마다 무작위. blind pickedA≈50% 로 편향 중화 확인. | P3 core done / P5 live 대기 |
| FR-HLMEM-5 | **지표** — `predictionAccuracy(condition)`=correct/total; `selfSpecificity`=acc(matched)−acc(mismatched); mismatched<blind=타인기억 적극 오도. 기존 지표(taskAccuracy/factRecall/drift/latency) 직교 보존. | P3 core done / P5 live 대기 |
| FR-HLMEM-6 | **exec-error 분리·CI 결정론** — 빈/축퇴 응답=exec-error(infra 실패, 예측실패 아님). 라이브 관측→fixture 녹화, CI 는 파싱·채점 재생(모델·키 無, G15). | P3 core done / P5 live 대기 |
| FR-HLMEM-7 | **라이브 예측 seam·verified-runtime** — 라이브 예측은 `ProviderPort`/`SubLlmPort` 로만(raw client·`@nextain/agent-*`·naia-memory FS import 금지, import-boundary). opt-in(`NAIA_PROD_KEY`+게이트웨이 max_tokens≥32). "done"=실 e2e matched>blind, 시크릿 미출력. | Planned(P5) |

### NFR
- NFR-HLMEM-proxy: 예측정확도는 proxy 이지 telos 아님. 절대 rubric·"부적절=실패" 도덕채점 금지(필터=편향, SoT).
- NFR-HLMEM-salience(P6): F3 감정 family·salience 는 MemoryPort/RecalledMemory widen + naia-memory arousal-flashbulb 선행. valence(0.5 중립) vs intensity 혼동 금지(~0.5 경계 테스트).

| UC | FR 위치 |
|----|---------|
| UC-HLMEM | `docs/progress/99.dev-comm/UC-HLMEM-humanlike-memory-measurement-contract-2026-07-07.md` (+ 본 파일 FR-HLMEM-1~7) |
| UC1 | `docs/progress/99.dev-comm/UC1-agent-horizontal-contract-2026-06-10.md` |
| UC5 | `docs/progress/99.dev-comm/UC5-agent-tool-loop-contract-2026-06-10.md` |
| UC-provider-provenance | `docs/progress/99.dev-comm/UC-provider-provenance-contract-2026-06-12.md` |

## UC-SECURITY-WIRE-V2 FR/NFR — 처리 위치 공개 및 동의 결속

권위 계약서: `docs/progress/99.dev-comm/SECURITY-WIRE-V2-contract-2026-07-19.md`.
이 절은 wire와 순수 검증 계약만 정의하며 실제 endpoint 분류기·동의 저장소·런타임 도구 집행은 후속 범위다.

| ID | 요구 | 상태 |
|----|------|------|
| FR-SEC-WIRE-1 | `ChatRequest.processing`과 `AgentEvent.processing_disclosure`를 하위호환 필드 번호로 추가하고 폐쇄 enum/필드로 검증한다. | In Review |
| FR-SEC-WIRE-2 | Discord 요청은 신뢰 저장소의 binding·guild·channel·user·processing profile과 모두 일치해야 하며 누락·불일치는 fail-closed 한다. | In Review |
| FR-SEC-WIRE-3 | 외부 처리 전에 공개 이벤트가 먼저 방출되는 순서를 순수 계획 함수로 고정하고, 차단·추가확인 결정을 코드화한다. | In Review |
| FR-SEC-WIRE-4 | 동의는 opaque `consentId`를 원자적으로 claim하며 profile·destination·workload·session과 결속하고 `expiresAt <= now`를 거부한다. | In Review |

- **NFR-SEC-WIRE-zero-transit**: processing 요청의 inline `apiKey`/`naiaKey`는 값 반사 없이 경계에서 거부한다.
- **NFR-SEC-WIRE-ai-independent**: 검증·순서·동의 결속은 모델 호출 없이 결정론적 순수 코드로 동작한다.
- **NFR-SEC-WIRE-no-promotion**: caller의 `actualDestination` 주장은 신뢰 정보로 승격하지 않고 decode 시 폐기한다.

## UC-DISCORD-RUNTIME FR/NFR — 개인 guild bot runtime

연결 이슈: `nextain/naia-agent#85`. #89 security wire와
`discord-rag-prefreeze-policy-contract-2026-07-19.md`의 승인된 경계를 선행한다.

| ID | 요구 | 상태 |
|----|------|------|
| FR-DISCORD-RT-1 | token은 주입 포트로만 받고 Gateway Identify/REST Authorization에 사용하며 일반 설정·wire·로그·dedupe 파일에 저장하지 않는다. | In Review |
| FR-DISCORD-RT-2 | authenticated Gateway event의 guild/channel/user/message id를 정확한 binding tuple과 대조하고 DM·bot/self·비허용·미호출 메시지는 fail-closed 한다. | In Review |
| FR-DISCORD-RT-3 | 허용 메시지는 기존 agent ingress로 `ChatRequest`를 보내고 같은 message에 reply한다. session과 bounded history는 binding/guild/channel/user별로 격리한다. | In Review |
| FR-DISCORD-RT-4 | binding+message id를 bounded durable store의 `reserved→replying(outbox cursor)→completed/partial` 상태로 원자 전이해 reconnect·crash replay와 부분 응답을 정직하게 처리한다. store 손상·쓰기 실패는 fail-closed 한다. | In Review |
| FR-DISCORD-RT-5 | Gateway close/reconnect는 RESUME 우선과 상한 있는 backoff로 재시도한다. native supervisor의 nonce 인증 Shutdown은 신규 ingress를 막고 이미 수락한 turn을 bounded drain한 뒤 종료하며, timeout 시 예약을 삭제하지 않고 durable partial로 남긴다. lifecycle은 비밀 없는 generation status로 공개한다. | In Review |
| FR-DISCORD-RT-6 | 응답은 Discord 2,000자 제한과 전체 상한을 지키며 rate limit을 bounded retry한다. 인증·권한·intent·provider 실패는 분류된 진단과 비밀 없는 짧은 사용자 오류로 처리한다. | In Review |
| FR-DISCORD-RT-7 | 친구 등록은 정확한 binding에서 만료 전 one-time code를 원자 소비하며 평문 code를 저장하지 않는다. 처리 consent는 trusted store의 profile/destination/workload/session 전체 결속과 expiry/one-time 소비를 거친다. | In Review |

- **NFR-DISCORD-RT-local-lifetime**: agent 프로세스가 실행되는 동안만 동작한다. PC
  종료 뒤 24시간 daemon/cloud relay는 비범위다.
- **NFR-DISCORD-RT-bounded**: binding, active turn, session history, dedupe entry,
  reconnect delay, reply chunk/retry 수는 모두 상한을 갖는다.
- **NFR-DISCORD-RT-zero-content-log**: 기본 진단에는 token, message/response 원문,
  개인 문서·검색 근거를 기록하지 않고 식별자도 필요한 분류·개수만 남긴다.
- **NFR-DISCORD-RT-ai-independent**: allowlist, dedupe, lifecycle, 분할, 취소는
  특정 LLM이나 cloud provider 없이 결정론적으로 검증한다.

## UC-CODEX-DELEGATION FR/NFR — Codex main provider와 터미널 위임

## UC-CODING-JOB requirements

## UC-JEONJU-COURSE requirements

| ID | Requirement | Status |
|---|---|---|
| FR-JEONJU-1 | `selected-workspace` is an explicit coding-job execution mode. It is never inferred for the existing isolated-worktree/default job mode. | Pending |
| FR-JEONJU-2 | Before Codex starts, the selected path must resolve to the approved Git root, have no uncommitted changes, and be inside the host-approved workspace boundary. | Pending |
| FR-JEONJU-3 | The course mode permits only `index.html` and `hero.svg` to be added or changed. It verifies `./hero.svg`, the requested title/color contract, and reports a failure instead of a false completion on any extra change. | Pending |
| FR-JEONJU-4 | Course mode snapshots HEAD and remote before execution and rejects a job whose execution changed commit history or remote configuration. Codex does not receive authority to commit, push, or alter Pages settings. | Pending |
| FR-JEONJU-5 | A cancelled, timed-out, dirty, out-of-root, or validation-failed job reports its exact safe phase and never emits a completed course result. | Pending |
| NFR-JEONJU-1 | The user-visible Discord lifecycle is received → running → completed/failed, without prompt, token, raw Codex output, or absolute-path disclosure. | Pending |
| NFR-JEONJU-2 | The Shell supplies selected-workspace mode and selected Git root as explicit structured data; a model cannot select or override this path. | Pending |

| ID | Requirement | Status |
|---|---|---|
| FR-CW-1 | Coding jobs have durable ids, a constrained state machine, and owner-only persisted records. | In review |
| FR-CW-2 | A job receives a canonical source workspace, unique managed worktree, generated branch, and exclusive lease before runner start. | In review |
| FR-CW-3 | Start/Get/List/Cancel/Resume are available through gRPC and the JSON-line stdio codec. | In review |
| FR-CW-4 | Targeted cancellation is idempotent and cannot cross job boundaries; a terminal state cannot be overwritten. | In review |
| FR-CW-5 | Resume requires an actual durable checkpoint; a no-checkpoint Codex CLI job returns a precondition error. | In review |
| NFR-CW-1 | Caller-controlled paths, branches, worktree locations, and leases are not trusted. | In review |
| NFR-CW-2 | A restart preserves status but does not claim a lost process is still running. | In review |

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-CODEX-1 | Codex provider는 API key를 복사하지 않고 로컬 로그인과 app-server를 사용하며 현재 protocol의 experimental dynamic tool 계약을 따른다. | Done |
| FR-CODEX-2 | `tier=none`이고 외부 처리 metadata가 없는 등록 도구만 app-server에 광고하고, server tool request에 같은 call id의 결과를 응답한다. | Done |
| FR-CODEX-3 | provider-native 도구 실행은 toolUse/toolResult로 관측되되 기존 handler가 두 번 실행하지 않는다. | Done |
| FR-CODEX-4 | desktop/Discord host의 `delegate_agent`는 Codex만 허용하고 host가 선택한 단일 workspace 실경로에 고정하며 model의 workdir override를 거부한다. child Codex는 전역 config를 무시하고 `workspace-write` OS sandbox를 강제한다. | Done |
| FR-CODEX-5 | Discord는 도구 시작·성공·실패를 원래 reply에 직렬 전송하되 args/output/call id와 mention 가능한 도구명을 반사하지 않는다. | Done |

- **NFR-CODEX-approval-boundary**: 승인 필요 또는 외부 처리 도구는 provider-native 즉시 실행 경로에 들어가지 않는다.
- **NFR-CODEX-workspace-boundary**: `..`·심볼릭 링크 cwd 탈출을 거부하고, 전역 `add-dir`·sandbox 설정을 상속하지 않으며 child Codex 실행을 검증된 workspace 쓰기 경계로 제한한다.
