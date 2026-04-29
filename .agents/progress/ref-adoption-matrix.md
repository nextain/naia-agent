# Ref Adoption Matrix — naia-agent R0

**작성일**: 2026-04-25 (Phase R0)
**입력**: 8개 ref review (`refs/{cline,jikime-adk,jikime-mem,moltbot,openclaw,opencode,project-airi,cc}-review.md`) + Phase 1 explore + 4-repo plan v7.2 + agent-loop-design.md

목적: 모든 ref reference에서 도출된 채택·거부·이연 결정을 단일 표로 통합. **drift 위험 항목과 결정 누락 항목**도 포함하여 어디에 무엇이 살아있는지 가시화.

---

## A. 이미 채택된 결정 (코드/문서로 pin됨)

| # | 패턴 | 출처 ref | 우리 위치 (코드/문서) | 검증 테스트 |
|---|---|---|---|---|
| A01 | Stream-first API (`sendStream`/`send`) | opencode (D1) | `packages/core/src/agent.ts` | 23 unit (mock) |
| A02 | CompactableCapable 위임 | opencode (D2) | `packages/types/src/memory.ts` | shape only |
| A03 | Compaction policy constants (contextBudget=80K, keepTail=6) | opencode (D3) | `agent.ts` | mock |
| A04 | Tool-hop bounded (max 10) | careti via naia-os/agent (D4) | `agent.ts` `maxToolHops` | mock |
| A05 | Tier T0~T3 + GatedToolExecutor | careti (D5) | `packages/runtime/src/tool-executor.ts` | 13 unit |
| A06 | Bidirectional encode/recall | careti+opencode (D6) | `agent.ts` turn lifecycle | mock |
| A07 | Session 생명주기 (created/active/.../closed) | A.5 | `packages/types/src/session.ts` | mock |
| A08 | AgentStreamEvent union | opencode bus 단순화 (D8) | `agent.ts` types | mock |
| A09 | MemoryProvider 4 + N capability | mem0 audit + alpha-memory | `packages/types/src/memory.ts` | shape only |
| A10 | Anthropic LLMClient 구현 | MVM #3 | `packages/providers/src/anthropic.ts` | smoke + 15 unit (X1 adapter) |
| A11 | Voice 3-layer hybrid (Option C) | S6 결정 + project-airi 일치 | `packages/types/src/voice.ts` (`VoiceEvent`) | shape only |
| A12 | OpenClaw → MCP 4단계 | openclaw analysis | naia-os agent/ Phase 1~4 머지 (commit 1e04928) | 84 unit (naia-os) |
| A13 | Skill 표준 1등 시민 (`@naia-adk/skill-spec`) | claude-code skill, openclaw 4단계 | `packages/runtime/src/skill-loader.ts` | 16 unit |
| A14 | ToolExecutor 추상화 + Composite | claude-code(분석), opencode | `packages/runtime/src/composite-tool-executor.ts` | 14 unit |
| A15 | Agent halt-after-N consecutive errors | 자체 + opencode 영향 | `agent.ts` halt | 12 unit |
| **A16** | Tool 메타 (`isConcurrencySafe?`/`isDestructive?`/`searchHint?`/`contextSchema?`) | cc 분석 + Vercel + Mastra (D10 §D → §A 승격, Slice 1b 머지) | `packages/types/src/tool.ts` ToolDefinitionWithTier | additive shape, 사용처 Slice 2+ |
| **A17** | Tool context schema (sessionId/workingDir/signal/ask) | opencode + Vercel `ToolExecutionOptions` (D11/D05 §D → §A 승격, Slice 1b) | `packages/types/src/tool.ts` ToolExecutionContext | shape, orphan 상태 — Slice 2 ToolExecutor.execute() 시그니처 확장 시 사용 |
| **A18** | Workspace sentinel (`startsWith(root + sep)`) | cleanroom-cc deep-audit F3 fix + OWASP A01 (D09 §D → §A 승격, Slice 1b) | `packages/runtime/src/utils/path-normalize.ts` | 10 unit (path-normalize.test.ts) |
| **A19** | Fixture-replay minimal (StreamPlayer + 정규형 fixture) | opencode 갭 + 자체 (C21 부분 §C → §A 승격, Slice 1b) | `packages/runtime/src/testing/stream-player.ts` + `__fixtures__/anthropic-1turn.json` | 4 unit (fixture-replay.test.ts). 정식 framework는 Slice 5 |
| **A20** | env + JSON config auto-loader (camelCase → SCREAMING_SNAKE_CASE) | 자체 (Slice 1c) | `packages/runtime/src/utils/env-loader.ts` | 18 unit (env-loader.test.ts) |
| **A21** | OpenAI-compat client (zai GLM / vLLM / OpenRouter / Together / Groq / Ollama) | 자체 + zai 검증 (Slice 1c+) | `packages/providers/src/openai-compat.ts` (fetch wrapper, no SDK 의존) | 실 호출 검증 (GLM-4.5-Flash 한국어 응답 확인) |
| **A22** | Anthropic on Vertex AI provider | `@anthropic-ai/vertex-sdk` (Slice 1c) | `packages/providers/src/anthropic-vertex.ts` | shape only — gcloud ADC 환경 필요, 사용자 환경에서 검증 |
| **A23** | LLM Config Standard docs + multi-tool harness 표준화 | 자체 (Slice 1c+) | `docs/llm-config-standard.md` + `naia-agent.env.example` + `.naia-agent.example.json` | docs only |
| **A24** | DANGEROUS_COMMANDS regex catalog (12+ 패턴) | OWASP A03 + CWE-78 (D01 §D → §A, Slice 2). F09 cleanroom 라인 인용 0 | `packages/runtime/src/utils/dangerous-commands.ts` | 38 unit (dangerous-commands.test.ts — block 17 + allow 16 + assertSafe 2 + 메타 2) |
| **A25** | Bash skill (T1, execFile + DANGEROUS pre-filter + timeout) | 자체 (Slice 2) | `packages/runtime/src/skills/bash.ts` | 12 unit (bash-skill.test.ts) — 실 shell 실행 + BLOCKED + 타임아웃 |
| **A26** | Logger.tag()/time() (D06 §D → §A, Slice 2) | opencode pattern, additive (optional methods) | `packages/types/src/observability.ts` + `packages/observability/src/logger.ts` | 4 unit (console-logger.test.ts D06 sub-tests) |
| **A27** | Observability 단위 테스트 (G05 해소) | 자체 (Slice 2) | `packages/observability/src/__tests__/{console-logger,meter,tracer}.test.ts` | 17 unit (G05 0개 → 17개) |
| **A28** | host factory enableBash + extraTools 옵션 | 자체 (Slice 2) | `packages/runtime/src/host/create-host.ts` | bash-skill-host.ts smoke + bin --enable-bash 검증 |
| **A29** | OpenAI-compat tool calling translation (양방향) | 자체 (Slice 2.5). LLMRequest.tools ↔ OpenAI tools[] + tool_use ↔ tool_calls + tool_result ↔ role:"tool" | `packages/providers/src/openai-compat.ts` | 실 호출 검증 (GLM-4.5-Flash가 bash 도구 자율 호출 → 결과 자연어 정리) |
| **A30** | File ops skills (read_file/write_file/edit_file/list_files) — D09 sentinel 재사용 | 자체 + claude-code/aider 영감 (Slice 2.6). T0 read/list, T1 write/edit | `packages/runtime/src/skills/file-ops.ts` + `createFileOpsSkills()` bundle | 23 unit (file-ops.test.ts) + GLM 실 호출 검증 (list_files로 ref review 11개 정확히 출력) |
| **A31** | Log Policy + `Logger.fn()` helper (enter/branch/exit + caller file:line + elapsedMs + args/result) + Dev mode 자동 감지 + 파일 자동 저장 + 5-pattern secret redact | 자체 + opencode tag/time 영감 (Slice 2.7) | `docs/log-policy.md` + `packages/observability/src/{logger.ts, dev-logger.ts, redact.ts}` + 핵심 8 영역 적용 (bin/host/bash/file-ops/openai-compat/anthropic/env-loader/agent) | 250 PASS 회귀 + 실 호출 trace 검증 (`~/.naia-agent/logs/naia-agent-YYYYMMDD.jsonl` append) |

---

## B. 명시적으로 거부된 결정

| # | 거부한 것 | 출처 ref | 이유 |
|---|---|---|---|
| B01 | OpenClaw 스킬 완전 호환 래퍼 | openclaw analysis q1 | 옵션 B(핵심만 MCP 재구현) 선택 — 유지보수 부담 대비 ROI 낮음 |
| B02 | macOS 우선 지원 | E4 | defer 유지 — Linux/Windows 안정화 후 재평가 |
| B03 | Voice full-runtime 소유 (Option A) | voice-pipeline-audit §4 | STT Rust→Node 재작성 비용 과다 |
| B04 | Voice full-shell 소유 (Option B) | voice-pipeline-audit §4 | Agent 직접 음성 방출 기능 포기 불수용 |
| B05 | SQL/Drizzle ORM 영속화 | opencode | NotEffect + zero-runtime-dep 원칙 위배 |
| B06 | Effect Layer 직접 의존 | opencode | 1000+ LoC 번들. zero-runtime-dep 정의 위반 |
| B07 | Go+TUI 첫 commit 패턴 | opencode | 우리는 TS 단일 스택 (Tauri shell 별도 host) |
| B08 | IDE plugin 결합 (webview, comment review) | cline | embeddable runtime은 host 추상화만 |
| B09 | OpenTelemetry/PostHog 패키지 dep | cline | zero-runtime-dep 원칙 위배 |
| B10 | TUI 직접 (terminal layer) | cleanroom-cc | host 책임 분리 (Tauri shell, CLI host) |
| B11 | `/bug`, `/feedback`, `/install-github-app` 등 SaaS 특화 명령 | cleanroom-cc | self-hosted Naia OS — 적합 안 함 |
| B12 | Sentry-style telemetry | cleanroom-cc | 우리 Logger/Tracer/Meter가 더 진전 |
| B13 | Monorepo 구조 (project-airi 자유 결합) | project-airi | 4-repo 분리 + zero-runtime-dep contract 원칙 위배 |
| B14 | Go 바이너리 의존 | jikime-adk | 우리는 TypeScript 단일 스택 |
| B15 | jikime-mem MemoryProvider 재사용 | jikime-mem | 모놀리식 + Claude Code 플러그인 강결합 + Chroma 고정 의존 |
| B16 | moltbot 999K LOC gateway 전체 | moltbot/openclaw | 경량 임베드 런타임과 양립 불가 |
| **B17** | Mastra 28-package monorepo 강결합 | mastra | 4-repo 분리 + zero-runtime-dep 위배 (B13 재확정) |
| **B18** | Mastra Studio web IDE | mastra | host(naia-os) 책임 분리 — UI는 host |
| **B19** | LangChain `@langchain/core` 직접 의존 | langgraphjs | B09와 동일 — zero-runtime-dep 위배 + ecosystem lock-in |
| **B20** | LangGraph StateGraph 채널 reducer (정적 schema) | langgraphjs | D1 stream-first 결정과 모델 충돌 |
| ~~B21~~ | ~~Vercel `@ai-sdk/<provider>` 50개 직접 의존 + React hooks~~ — **DEMOTED by D44 (2026-04-29), refined by 5.x.6 cross-review P0-3 (2026-04-29)**. 실제 적용 형태: `@nextain/agent-providers`가 5개 default 번들 (`@ai-sdk/anthropic`/`@ai-sdk/google`/`@ai-sdk/openai-compatible`/`zhipu-ai-provider`/`ai-sdk-provider-claude-code`) 만 `optionalDependencies` 로 자동설치, 나머지 50개는 host가 peer로 opt-in 설치. (1) 50-provider sprawl 회피 (5개로 한정), (2) `@ai-sdk/react` hooks는 별도 패키지 — naia-agent는 headless로 import 안 함. zero-runtime-dep 정신 완전 보존은 아니지만 **사용자 directive ("자동설치")** 와 정합 + 50-provider sprawl 우려는 해소 | vercel-ai-sdk | demoted (5-provider default bundle, host opts into more) |
| **B22** | cleanroom 코드 라인 직접 복붙 (8 파일) | cleanroom-cc deep-audit F1~F12 | F4 강화 — 패턴 idea만 차용, 라인 복붙 금지 (LLM 환각 silent drift 위험) |
| **B23** | naia-agent를 claude-code/opencode 수준 자체 build (provider 50+, MCP, SQL session, compaction 정교, tool 본체 풀스택) | R4 1인 환경 평가 | 1인 70k+ LOC 1년+ 무리. Hybrid wrapper(D18)가 현실 path. wrapper layer ~2,150 LOC로 사용자 가치 80% 달성 가능 |

---

## C. 이연 (Deferred) — 트리거 조건 명시

| # | 항목 | 출처 | 트리거 조건 |
|---|---|---|---|
| C01 | Real tokenizer 통합 | agent-loop-design 한계 | provider-accurate tokenizer 제공 시 |
| C02 | Sub-agent spawning | claude-code 분석 + agent-loop-design | claude-code 패턴 정식 도입 시 (Phase 2+) |
| C03 | MCP bridge via runtime | agent-loop-design + opencode | X4 MCP 통합 진입 |
| ~~C04~~ | ~~Prompt caching opinionated 정책~~ — **§D16으로 격상 (Vercel 영향, 2026-04-25 R1 v2)** | ~~agent-loop-design~~ | ~~passthrough → 정책 정의 (Phase 2)~~ |
| C05 | Multi-session concurrency | A.12 | 1 HostContext = 1 Session 한계 해소 시 |
| C06 | TTS 추출 (Phase 2 X7) | voice-pipeline-audit | S6 결정 후 |
| C07 | ClawHub 호환 (backward-compat) | openclaw issue-201 | Phase 4 B-D 완료 후 |
| C08 | Flatpak dual-path (S3) | 4-repo plan §Z | Phase 2 CI |
| C09 | Tauri bundling matrix (S10) | 4-repo plan §Z | Phase 2 X1 진입 |
| C10 | Memory 로깅 패턴 (cline 5분 주기) | cline | compaction trigger or observability 검토 시 |
| C11 | Hook 쉘 escape 규칙 | cline | hook 설계 확정 후 (A.5 이후) |
| C12 | AuthManager 이벤트 기반 토큰 갱신 | cleanroom-cc adopt-cc-02 | daemon gateway 도입 시 |
| C13 | Command Registry 카테고리 + availability 필터 | cleanroom-cc adopt-cc-04 | 명령어 수 50개 도달 시 |
| C14 | ErrorCategory enum (단순화 버전) | cleanroom-cc adopt-cc-05 | nice-to-have, P2 |
| C15 | Engagement 정확도 (engage_mode + fan-out) | nanoclaw v2 | ExtensionPack 설계 시 (Phase 4) |
| C16 | Per-agent fan-out session 격리 | nanoclaw | Phase 4 후기 (multi-tenant 모델 후) |
| C17 | OneCLI Vault credential injection | nanoclaw v2 | Phase 2 (자체 실행 엔진) 권고 |
| C18 | Universal Speech Transformer segmentation | project-airi | Phase 2 X7 TTS 성능 평가 시 |
| C19 | Character card v3 호환 | project-airi | Phase 1 T5 character metadata 스키마 후 |
| C20 | Dual Orchestrator (J.A.R.V.I.S./F.R.I.D.A.Y.) | jikime-adk | Phase 2 이후 specialized agent 필요 시 |
| C21 | Fixture-replay E2E (StreamRecorder/Player) | opencode 갭 | R3+ Slice 단위로 도입 |
| C22 | DI 컨테이너 패턴 (단순화) | opencode | service factory 함수 + host 명시 주입 — 우리 구조에 부합 |

---

## D. 신규 채택 권고 (R0에서 추가, P0~P2 라벨)

| # | 패턴 | 출처 ref | 우선순위 | 예상 공수 | 슬라이스 후보 |
|---|---|---|---|---|---|
| D01 | DANGEROUS_COMMANDS regex (Bash 보안 필터) | cleanroom-cc adopt-cc-01 | **P0** | S (1h) | bash skill / ToolExecutor wrapper |
| D02 | Path normalization (directory traversal 방지) | cleanroom-cc adopt-cc-03 | **P0** | S (30m) | fileops native helper |
| D03 | wLipSync AEIOU viseme vocabulary + 2-stage 알고리즘 | project-airi | P1 | M | Phase 2 X7 TTS extraction |
| D04 | Narrative stripping 휴리스틱 (TTS 입력 정규화) | project-airi | P2 | S | Phase 2 X7 |
| D05 | Tool context 패턴 (sessionID/directory/ask 권한 전달) | opencode | P1 | S | D5 보강 |
| D06 | Logger.tag() + timestamp 편의 | opencode | P1 | S | Logger 확장 |
| D07 | Compaction overflow + 동적 preserveRecent (D3 구체화) | opencode | P1 | M | Agent.maybeCompact 보강 |
| D08 | ChannelPlugin adapter 패턴 | moltbot | P2 | M | naia-os messenger layer |
| **D09** | Workspace sentinel (`path.resolve` + `startsWith(root + sep)` throw) | cleanroom-cc deep-audit F3/F10 fix | **P0** | S (30m) | Slice 1b — D02와 묶음 |
| **D10** | Tool 메타 (`description`/`inputSchema`/`contextSchema?`/`isConcurrencySafe?`/`isDestructive?`) | cc 분석 + Vercel AI SDK + Mastra | **P0** | S (1h) | Slice 1b — Tool 정의 정식 확장 |
| **D11** | Tool context schema (sessionId/dir/abort/ask) — D05 보강 | opencode + Vercel `ToolExecutionOptions` | P1 | S | Slice 1b → 2 보강 |
| **D12** | onStepFinish/onChunk callback 표준 — Logger event 보강 | Vercel `onStepFinish` + Mastra hook | P1 | S | Slice 2 |
| **D13** | Compaction 3중 방어 (overflow + onstep + abort signal) — D07 강화 | Mastra + cleanroom F11 silent drop 회피 | P1 | M | Slice 4 (D07과 통합) |
| **D14** | Eval scorers framework (MastraScorer interface) | Mastra | P1 | M | Slice 5 또는 R3+ |
| **D15** | Memory 3-tier blueprint (history/working/observational) | Mastra | P2 | M | alpha-memory R3+ spec only |
| **D16** | Prompt cache opinionated 정책 (passthrough → 정책) — **C04 격상** | Vercel `cache_control` + Anthropic provider 자동 처리 | P1 | S | Slice 2 이후 |
| **D17** | Provider fallback array (`model: [{...}, {...}]`) | Mastra + Vercel | P2 | S | Slice 2 이후 백로그 (multi-provider 진입 전) |
| **D18** | **Hybrid wrapper path (B)** — opencode + claude-code SDK를 sub-agent로 wrap, naia-agent는 thin supervisor | R4 (사용자 본질 고민 — 1인 70k+ LOC 풀 build 불가) | **P0** | XL (Phase 1~4) | apps/cli + adapters/{opencode,claude-code,shell} |
| **D19** | **단일 대화 + workspace 가시성 + 자동 verification + 수치 정직 보고** | R4 (사용자 vision — 보고 ≠ 실제 낭패 해소) | **P0** | L | apps/cli/repl + workspace/{watcher,diff} + verification/* + report/formatter |
| **D20** | **NaiaStreamChunk multi-modal protocol** (text/audio/image/tool/workspace/session/verification/report/interrupt) | R4 (omni-voice 시대 vllm-omni / GPT-4o realtime) | **P0** | M | packages/types/src/stream.ts + core/stream-merger |
| **D21** | **Real-time interrupt + pause/resume** (음성 "중지중지" / Ctrl+C / 카드 [중지]) | R4 (사용자 통제권) | **P0** | M | core/interrupt + adapter cancel/pause/resume contract |
| **D22** | **vllm-omni adapter** (omni audio output, audio_delta passthrough) | R4 + 사용자 자체 fork (nextain/vllm-omni MiniCPM-o 4.5) | P1 | L | adapters/vllm-omni (Phase 4+) |
| ~~D23~~ | ~~**Vercel AI SDK 보류** — any-llm으로 충분 (multi-provider routing은 원격 gateway). 외부 distribution 시 재검토~~ — **SUPERSEDED by D44 (2026-04-29)**. D23 근거의 결함: any-llm gateway는 원격 naia 계정 한정이고, 사용자 자체 키 환경에서는 multi-provider 확보 못함. 5개 자체 provider는 이전 naia-os/agent에서 carry-over일 뿐 실질 신규 abstraction 아님 | R4 (any-llm = naia 자체 fork, naia-anyllm) | ~~P2~~ | — | superseded |
| **D24** | **Sub-agent supervisor pattern** (ACP/Claude SDK adapter + 다중 session orchestration + audit trail) | R4 (사용자 다중 터미널 워크플로우 자동화) | **P0** | L | core/supervisor + adapters/{opencode,claude-code} + observability audit |
| **D25** | **Tool context schema 정형화** (sessionId/workingDir/ask/tier) — SpawnContext.toolContext | R4 cross-review (opencode + Vercel) | **P0** | S | adapters/* — `ToolExecutionContext` interface (adapter-contract.md §2) |
| **D26** | **onSessionEnd hook → session_aggregated chunk** (supervisor가 stats/verification aggregate 후 emit, report 전 단계) | R4 cross-review (Mastra + Vercel onStepFinish, D12 보강) | **P0** | S | core/supervisor + stream-protocol.md §5b 신규 |
| **D27** | **Verification 3중 방어** (abort signal + memory limit + wall-clock timeout) | R4 cross-review (Mastra D13 + cleanroom F11 회피) | **P0** | M | verification/orchestrator + architecture-hybrid.md §6b |
| **D28** | **Memory 3-tier blueprint** (D15 구체화 — history/working/observational) | R4 cross-review (Mastra) | P1 | M | alpha-memory adapter Phase 3 진입 시 정식화 |
| **D29** | **viseme vocabulary spec** (AEIOU + lipsync 알고리즘, NaiaStreamChunk audio_delta 확장) | R4 cross-review (project-airi D03) | P1 | M | stream-protocol.md audio_delta + Phase 4 X7 (TTS extraction) |
| **D30** | **Verification 3중 방어 재근거화** (cleanroom 단독 의존 해제 → OWASP/Mastra 출처 cross-reference) | R4 Week 0 2차 cross-review (Reference) | P1 | S | docs/verification-audit.md 신설 (Phase 4 verification pkg 완료 후) — F09 강제 |
| **D31** | **onSessionEnd hook 정형화** (D26 구체화 — supervisor pseudo-code 예시) | R4 Week 0 2차 cross-review (Reference) | P1 | S | stream-protocol.md §5b 명시화 (현 docs에 이미 일부 있음) — Phase 2 supervisor 구현 시 |
| **D32** | **bash/file-ops dev-only marker** (R3 250 PASS test 보존 정책 명시) | R4 Week 0 2차 cross-review (Reference + Paranoid R3-R4) | **P0** | S | runtime/skills/README.md 신설 + bash/file-ops test에 `describe.skip(production)` marker — Day 1 진행 중 |
| **D33** | **opencode `run --format json` JSON event protocol** (Phase 1 채택, ACP는 Phase 2) | R4 Week 0 spike 2026-04-26 | **P0** | S | adapters/opencode-cli/ — Phase 1 정식 path. JSON event NDJSON parse → NaiaStreamChunk 변환 |
| **D43** | **naia-agent의 STT/TTS provider abstraction** (Vercel AI SDK 패턴, omni audio_delta 호환) — naia-os는 device IO만 (mic/speaker via Tauri Rust cpal) | R4 Phase 4 cross-review 사용자 통찰 — "tts/stt naia-shell 처리 시 omni 곤란" | P1 | M | naia-agent에 audio provider layer (Vercel `experimental_generateSpeech` / `experimental_transcribe` 패턴) — Phase 5+ |
| **D44** | **Vercel AI SDK 로컬 LLM 단일 abstraction 채택** (D23 supersede) — `ai` core를 peer dep, `@ai-sdk/<provider>`도 optional peer dep. 50+ provider 즉시 호환. 자체 5개(`anthropic`/`anthropic-vertex`/`gemini`/`openai-compat`/`claude-cli`) → `VercelClient` adapter 1개로 대체. CLI 구독 path는 community provider (`ai-sdk-provider-claude-code`/`-codex-cli`/`-gemini-cli`/`-opencode-sdk`)로 흡수. **lab-proxy / lab-proxy-live는 보존** (naiaKey 보호 + WebSocket Live API, Vercel 영역 밖). vllm-omni 텍스트 mode = `@ai-sdk/openai-compatible`로 즉시 호환, audio_delta realtime은 D43 자체 layer 유지 | 사용자 directive 2026-04-29 — D23 silent drift 정정. 토큰 부족 → multi-provider 확보 절실. RunPod naia 계정 통합은 별도 (D45 후보) | **P0** | L (Phase 5.x slices) | packages/providers/src/vercel-client.ts (adapter) + 5개 자체 provider deprecate → 제거 (slice 시퀀스). bin / examples / fixture-replay 갱신 |

---

## E. Drift 위험 — 적혔지만 코드/테스트로 pin 안 됨

| # | 위험 항목 | 위치 | 현재 상태 |
|---|---|---|---|
| E01 | gateway 내부 circular 2건 | naia-os/agent/gateway/ (`client.ts ↔ tool-bridge.ts`, `tool-bridge.ts ↔ sessions-spawn.ts`) | known debt, X8(messengers 추출) 시 해결 |
| E02 | 테스트 커버리지 전면 부족 | Phase 1 + X1 | smoke/self-review only. issue #1 트래킹. PASS 정의 v2 상향 |
| E03 | VRM lip-sync viseme vocabulary 미정 | `VoiceEvent.visemeId` | ARKit/Oculus/custom 미결정. project-airi의 wLipSync(D03) 후보로 해소 가능 |
| E04 | Agent-level smoke test 미존재 | scripts/smoke-anthropic.ts | AnthropicClient 직접만 테스트. Agent 레벨(InMemory + Mock) 부재 |
| E05 | Memory stubs 구현 | alpha-memory `contentTokens`/`jaccardSimilarity`/`mergeRelatedFacts` | stub 상태, dedup branch dead code. silent data-loss 위험 |
| E06 | X1 wiring + factory env-gate 검증 | naia-os adapter | `yield { finish }` closure 미검증, factory 수동 1회만 확인 |
| E07 | Memory 양방향성 시점/전환 규약 | claude-code 분석 결론 부재 | claude-code "single-directional" 인식만, 우리 정책 명시 미흡 |
| E08 | provider DI 방식 (alpha-memory adapter) | memory-provider-audit §4 | wrapper class vs direct peerDep 미결정 |

---

## F. 결정 누락 — 분석은 있는데 정식 결정문 없음

| # | 항목 | 분석 출처 | 누락 사유 |
|---|---|---|---|
| F01 | claude-code 15-agent 분석 (`11-ref-cc-analysis.json`) "Naia OS 도입 계획" | 보고서 작성 완료 | 채택/거부/이연 정식 매핑 부재 — **본 매트릭스 §A·D에서 cleanroom 비교 후 부분 해소** |
| F02 | Dashboard (E1) | 4-repo plan v7 | Part B 미결정 — K3 실행 시점 |
| F03 | `@naia-agent/cli` 패키지 신설 (E2) | 4-repo plan v7 | Part B 미결정 |
| F04 | jikime-adk Dual Orchestrator 채택 깊이 | jikime-adk-review | Phase 2 이후 specialized agent 필요성 검증 후 |
| **F05** | cleanroom 폐기 대응 plan (archived 2025-03, 974 stars) — D01/D02 OWASP/RFC 재근거화 | cleanroom-cc deep-audit + GitHub 페이지 신호 | **F09 forbidden_action으로 부분 해소**. Slice 2 진입 전 OWASP A03 + RFC 3986 출처 docs 신설 |

---

## G. ref별 채택 점수표 (한눈 요약)

| ref | 우리에게 채택 가치 | 핵심 차용 | 거부 사유 |
|---|---|---|---|
| **opencode** | ★★★★★ | tool context, Logger tag/time, compaction 동적, DI 단순화 (4건) | SQL, Effect Layer 의존, Go+TUI |
| **claude-code (private + cleanroom)** | ★★★★★ | DANGEROUS_COMMANDS, Path normalize, AuthMgr 이벤트, Cmd registry, Error enum (5건) | TUI, SaaS 특화 명령, Sentry telemetry |
| **project-airi** | ★★★★ | wLipSync viseme, Narrative stripping, Emotion blending (3건) | monorepo, Hono backend, Stripe |
| **openclaw / nanoclaw v2** | ★★★ | OpenClaw→MCP 4단계 (이미 완료), engage_mode + fan-out, OneCLI Vault | 999K LOC, gateway server overhead |
| **cline** | ★★ | Memory 모니터링, Hook escape, Proto enum 매핑 | IDE plugin 결합, OTel/PostHog |
| **jikime-adk** | ★★ | Dual Orchestrator 개념, 세분화 Hook | Go 의존, Webchat UI, 마이그레이션 특화 |
| **moltbot** | ★ | ChannelPlugin adapter, Manifest lazy load | 999K LOC, gateway, ecosystem 강결합 |
| **jikime-mem** | ★ | (직접 차용 없음, 검토만) | 모놀리식, Claude Code 플러그인 강결합, Chroma 고정 |
| **mastra** | ★★★★★ | Eval scorers (D14), Memory tiers (D15), Tool context (D11), 3중 방어 (D13), provider fallback (D17) | monorepo (B17), Studio web IDE (B18), DynamicArgument 복잡도 |
| **vercel-ai-sdk** | ★★★★ | ToolLoopAgent 시그니처 검증 (A01 보강), Tool context schema (D11), onStepFinish (D12), prompt cache (D16) | 50 provider 직접 의존 (B21), React hooks 결합 |
| **langgraphjs** | ★★★ | Checkpoint 패턴 (C05 후보), interrupt/resume (C12 인접), Send sub-agent (C02 인접) | LangChain core 의존 (B19), StateGraph reducer (B20), Python parity 우선 |

---

## H. 매트릭스 사용 가이드

- **A 항목**은 변경 금지 — 이미 결정 + 코드. 변경 시 별도 ADR.
- **B 항목**은 재검토 시 `B##` 인용. 새로 거부 추가 시 §B에 append.
- **C 항목**은 트리거 조건 충족 시 `C##` → `D##` 또는 `A##`로 승격.
- **D 항목**은 R0.7 sub-issue로 변환됨. P0=즉시, P1=다음 슬라이스, P2=백로그.
- **E 항목**은 issue #1(test coverage audit) 또는 별도 issue로 트래킹.
- **F 항목**은 R1 plan 작성 시 결정 강제 (Part B로 이연 또는 R0 추가 결정).

---

## 참고 — ref별 review 파일 경로

- `refs/cline-review.md` (commit 901d1b5c9, 2026-04-25)
- `refs/jikime-adk-review.md` (commit b9f4fb98, 1.8.1)
- `refs/jikime-mem-review.md` (commit 0e3f6920)
- `refs/moltbot-review.md` (commit f29e15c05d)
- `refs/openclaw-review.md` (commit 8d85222, prior analysis: `alpha-adk/.agents/progress/issue-186-openclaw-analysis.md`)
- `refs/opencode-review.md` (commit 91468fe45)
- `refs/project-airi-review.md` (commit 2b125d5f, v0.9.0+94)
- `refs/cc-review.md` (private nextain/ref-cc 분석 docs + public ghuntley/claude-code-source-code-deobfuscation cleanroom)
- `refs/cc-cleanroom-security-audit-2026-04-25.md` (cleanroom 보안 audit, F1~F4 미완성 stub 발견)
- `refs/cc-cleanroom-deep-audit-2026-04-25.md` (paranoid bait audit, F5~F12 LLM 환각/silent fail + 8 파일 블랙리스트)
- `refs/mastra-review.md` (commit b97a0594, ★★★★★ Eval/Memory tiers/Tool context)
- `refs/langgraphjs-review.md` (commit 7f3320cd, ★★★ Checkpoint/Sub-agent/Interrupt)
- `refs/vercel-ai-sdk-review.md` (commit 10432742, ★★★★ ToolLoopAgent/onStepFinish)

---

## I. v2 변경 이력 (2026-04-25 R1 cross-review 적용)

**3-perspective cross-review 결과** (architect + reference-driven + paranoid auditor):

- **§D 신규 9건** (D09~D17) — workspace sentinel / Tool 메타 / Tool context / onStepFinish / 3중 방어 / Eval scorers / Memory tiers / Prompt cache(C04 격상) / Provider fallback
- **§B 신규 6건** (B17~B22) — Mastra monorepo / Mastra Studio / LangChain core / StateGraph reducer / Vercel multi-provider / cleanroom 라인 복붙
- **§C04 → §D16 격상** (Vercel 영향)
- **§F05 신규** — cleanroom 폐기 대응 plan
- **§G 점수표** — Mastra/LangGraph/Vercel 3 ref 추가

채택 옵션 A (light, 가볍게 directive): D09/D10 P0만 즉시 ingrain (Slice 1b), 나머지 P1/P2는 슬라이스 진행 시 자연 §A 승격. R3+ slice 신설은 outline만 (정식 신설은 R1 종료 후).

---

## J. R4 변경 이력 (2026-04-26 Hybrid Wrapper Pivot)

**trigger**: 사용자 본질 고민 — "바닥부터 만드는 게 맞나" + "팀장 역할이 피곤" + "보고 ≠ 실제로 큰 낭패" + "알파와 단일 대화창에서 연속적으로 일을 시키고 싶다"

**변경 요약**:

- **§D 신규 7건** (D18~D24) — Hybrid wrapper / 단일 대화 + 정직 보고 / NaiaStreamChunk multi-modal / Real-time interrupt / vllm-omni adapter / Vercel AI SDK 보류 / Sub-agent supervisor
- **§B 신규 1건** (B23) — naia-agent 풀 자체 build 거부 (1인 70k+ LOC 무리)
- **§A 변경 0건** — R0 lock 보존 (interface contract / D1~D8 / Voice 3-layer 등 그대로)
- **신규 docs 4건** — `docs/{vision-statement, architecture-hybrid, stream-protocol, adapter-contract}.md`
- **R4 progress** — `.agents/progress/r4-hybrid-wrapper-2026-04-26.md`
- **master issue** — nextain/naia-agent#2 댓글 R4 announce

**vision lock**:
> "Real-time interruptible multi-agent supervisor with multi-modal stream + 정직 보고"
>
> 3차원 차별화 (다른 framework에 거의 없음):
> 1. Multi-modal stream (audio_delta 1급)
> 2. Sub-agent supervisor (ACP/SDK + audit + interrupt)
> 3. 단일 대화 + 정직 보고 (verification + diff + 수치)

**Phase outline**:
- Phase 1 (Week 1): 알파 CLI + opencode 단순 stdio + workspace watcher + verification + 수치 보고 → 사용자 피로 30~50% 감소 검증
- Phase 2 (Week 2~3): ACP 정식 + Interrupt + Approval gate
- Phase 3 (Week 4~6): claude SDK + sub-session card + alpha-memory
- Phase 4 (Week 7~10): Adversarial review + naia-shell 통합 + vllm-omni audio

**Week 0 cross-review (2026-04-26)** — 3-perspective parallel:

- **Architect**: APPROVED with conditions (P0 3건 — SessionPhase enum / unsupported matrix / core 내부 DAG)
- **Reference-driven**: APPROVED with P0 3건 + P1 5건 + 신규 §D 5건 (D25 tool context / D26 onSessionEnd / D27 3중 방어 / D28 memory 3-tier / D29 viseme vocab)
- **Paranoid auditor**: APPROVED_WITH_RISKS — P0 5건 (외부 의존 검증 + secret redact + interrupt 500ms hard kill)

**resolved by spike** (2026-04-26):
- opencode ACP: ✓ `@agentclientprotocol/sdk@0.20.0`, opencode `packages/opencode/src/acp/` 정식 구현
- Claude Agent SDK: ✓ `@anthropic-ai/claude-agent-sdk@0.2.119` public

**P0 11건 모두 docs 반영** (stream-protocol §2/§5b, architecture-hybrid §5b/§6b/§6c, adapter-contract §2/§3 매핑/§8 보안/§9 contract test C11~C15).

상세: `.agents/progress/r4-week0-cross-review-summary.md`

---

## K. R5 변경 이력 (2026-04-29 Vercel AI SDK 채택 정정)

**trigger**: 사용자 directive 2026-04-29 — "Vercel ai sdk를 쓰면 어쨌든 llm확보가 매우 쉬워지잖아" + "토큰이 딸리게 생겨서 naia계정, anyllm에서 runpod을 지원할 수 있을지도 고려" + "우선 vercel ai sdk 적용으로 정리하고 계획 세우고 작업 진행해 / 우리 any-llm의 runpod지원은 이후에 추가 논의하자"

**배경**: D23 (Vercel AI SDK 보류, R4 lock)이 사용자 원래 의사 ("로컬은 vercel꺼 쓰면 다 해결")와 정반대로 기록되어 silent drift. R3~R4에서 만든 7개 자체 provider 중 5개가 이전 naia-os/agent에서 carry-over일 뿐 실질 신규 abstraction 아니고, registry/factory layer는 오히려 후퇴.

**변경 요약**:

- **§D 신규 1건** (D44) — Vercel AI SDK 로컬 LLM 단일 abstraction 채택, peer-dep 패턴
- **§D supersede** — D23 → D44 (strikethrough + supersede 명시)
- **§B 격하** — B21 → demoted (sub-concern 회피 가능 명시: optional peer dep + headless)
- **§A 영향 (예정)** — A10/A21/A22 자체 provider 채택 항목들은 Slice 시퀀스에서 §C/§deprecated 이동 후 제거. lab-proxy / lab-proxy-live (gateway 경로) + claude-cli (subprocess) 검토
- **§D 미결 (RunPod)** — 사용자 directive로 "이후 논의" 보류. D45 후보 자리 표시: naia-anyllm gateway에 RunPod backend 통합 (lab-proxy `runpod:<model>` prefix 라우팅 + naiaKey 단일 인증)

**P0 결정 (Phase 5.x, slices)**:

| Slice | 목표 | success criterion |
|---|---|---|
| **5.x.0** | 매트릭스 + progress lock (본 commit) | docs only — S03/S04 면제 (matrix_id_citation 면제 항목) |
| **5.x.1** | `VercelClient` adapter MVP — `LanguageModelV2` → `LLMClient` wrap | S01 신규 명령 (Vercel-backed `pnpm naia-agent`) + S02 unit (stream/generate 양방향 변환) + S03 integration (real Anthropic via Vercel) + S04 CHANGELOG entry |
| **5.x.2** | 자체 `anthropic.ts` deprecate → VercelClient + `@ai-sdk/anthropic` | S01 동일 명령에서 Vercel-backed 동작 + S02 회귀 + S03 fixture-replay 재녹화 (F11 강제) |
| **5.x.3** | `gemini.ts` / `openai-compat.ts` / `anthropic-vertex.ts` deprecate → Vercel | (3 sub-slices) GLM via zhipu-ai-provider, vLLM via @ai-sdk/openai-compatible, Vertex via @ai-sdk/google-vertex |
| **5.x.4** | `claude-cli.ts` deprecate → `ai-sdk-provider-claude-code` (community) | subprocess wrap → Vercel SDK 패턴, Pro/Max 구독 path 보존 |
| **5.x.5** | bin / examples / fixture-replay 갱신 + 자체 provider 5개 제거 | 250 PASS 회귀 + bin --help가 Vercel-backed provider 노출 |
| **5.x.6** | Cross-review 3-perspective (architect / reference / paranoid) | review docs 3건 + P0 fix 반영 |

**out of scope (별도 논의)**:
- RunPod 통합 (D45 후보, naia-anyllm gateway 측 작업)
- vllm-omni RunPod 호스팅 (자체 컨테이너 빌드 + Pod 배포, Phase 5+ 별도 검토)

**보존 (Vercel 영역 밖, 변경 없음)**:
- `lab-proxy.ts` (HTTPS, naiaKey)
- `lab-proxy-live.ts` (WSS, naiaKey, vllm-omni `/v1/realtime`)
- D43 자체 audio provider layer (Phase 5+)

상세: `.agents/progress/vercel-ai-sdk-adoption-2026-04-29.md`
