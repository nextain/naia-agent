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

### NFR
- 헥사고날 경계: domain 순수(formatRecalledMemory)·app 포트만·adapter 데이터만(프롬프트 정책 비누출).
- 불변식: terminal 래치(finish XOR error 1회)·usage=terminal 직전 1회·registry finally 해제 — memory 경로 무영향.
- recall 정확성은 content+project 기반(session/encode 순서 무관) → 동시 턴 교차 안전.

## UC-PROV FR/NFR (FR-PROV-1 ~ 5, FR-MODEL-1)

권위 계약·검증: 아래 FR-PROV-1~5·FR-MODEL-1 표 + Test Coverage Map 의 계약 테스트
(`src/test/all-providers-wiring.contract.test.ts` 등). 상세 진행기록은 메인테이너 워크스페이스 보관(repo 외부).

| ID | 요구사항 | 상태 |
|----|----------|:----:|
| FR-PROV-1 | config-first precedence — naia-settings `loadMain` 이 `config.json`(naia-os 셸 정본)을 `llm.json`(구 CLI)보다 먼저 읽는다. desktop SoT 원칙; stale `llm.json` 이 UI 선택(config.json)을 그림자 처리(shadow)해 openai-compat 크래시를 유발하면 안 됨. | Done |
| FR-PROV-2 | 라이브 설정 reload (R1-2) — 사용자가 naia-os 에서 provider/model 교체 → OS 가 naia-settings 갱신 후 `ReloadSettings`/`SetWorkspace` 재호출 → agent 가 활성 `defaultConfig` 를 재기동 없이 swap. startup-only 금지(R1-2). | Done |
| FR-PROV-3 | native host-override gating — `naiaGatewayUrl`/`NAIA_ANYLLM_BASE_URL` 는 nextain(lab-proxy) 전용. native provider 는 고정 공개 endpoint(또는 `vllmHost`/`ollamaHost`/`llm.json` baseUrl). config 에 남은 stale `naiaGatewayUrl` 이 native provider 를 오라우팅하지 않도록 게이트. | Done |
| FR-PROV-4 | anthropic·claude-code-cli 연결 — Anthropic Messages API(`/v1/messages`, `x-api-key`, `anthropic-version`) 전용 어댑터(raw fetch, SSE). claude-code = SDK/API 패러다임(CLI 바이너리 아님). text/tool_use(`input_json_delta`)/usage/thinking 매핑 + tool_result 병합 + prompt caching(`cache_control` on system). 키=`ANTHROPIC_API_KEY`(credentials 포트). 비용 레지스트리에 모델 등재(claude-sonnet-4-6 등). naia-os 전 9 provider 연결 완성. | Done |
| FR-PROV-5 | claude-code-cli = Claude Agent SDK 분리(2026-06-18) — `claude-code-cli` 는 anthropic(Messages API 직접키)에서 격리된 `claude-code` 라우트로, `@anthropic-ai/claude-agent-sdk` `query()`(로컬 Claude Code 구독 인증)를 사용. **apiKey 불요**(keychain `ANTHROPIC_API_KEY` 매핑 제거 → null), naia-settings `claude-code` 분기는 secret/baseUrl 미주입(구독을 직접키로 오인 금지). 비용 = $0(`SUBSCRIPTION_PROVIDERS` + chat-turn-handler `costProvider` 분기 — 동일 model ID 의 anthropic 직접키와 구별). | Done |
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

## 기타 UC FR

| UC | FR 위치 |
|----|---------|
| UC1 | `docs/progress/99.dev-comm/UC1-agent-horizontal-contract-2026-06-10.md` |
| UC5 | `docs/progress/99.dev-comm/UC5-agent-tool-loop-contract-2026-06-10.md` |
| UC-provider-provenance | `docs/progress/99.dev-comm/UC-provider-provenance-contract-2026-06-12.md` |
