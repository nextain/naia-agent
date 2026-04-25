# Runnable + Testable Gap Analysis — naia-agent R0

**작성일**: 2026-04-25 (Phase R0)
**원칙 (사용자 directive 2026-04-25)**: "점진적 구동 + 테스트 가능 상태 유지하며 개발 — 큰 덩어리 멈춤 금지"

목적: 현재 naia-agent가 위 원칙을 만족하는지 정밀 점검. 만족 못 하는 갭 항목과 매 슬라이스가 가져야 하는 검증 형태(success criterion)를 정의.

---

## 1. 현재 표면 (inventory)

### 1.1 패키지 (6개)

| 패키지 | 역할 | 상태 | 단위 테스트 |
|---|---|---|---|
| `@nextain/agent-types` | 계약 (zero-runtime-dep) | v0.1.0 freeze | shape only (사용처 테스트 없음) |
| `@nextain/agent-protocol` | wire (zero-runtime-dep) | v0.1.0 freeze | 73 unit (Phase A) |
| `@nextain/agent-core` | Agent 루프 | WIP | 23 unit (Phase B + C.2) |
| `@nextain/agent-runtime` | 도구 + skill loader | WIP | 93 unit (Phase B) |
| `@nextain/agent-providers` | LLMClient (Anthropic) | implemented | smoke + 15 unit (X1 adapter) |
| `@nextain/agent-observability` | Logger/Tracer/Meter 기본 구현 | implemented | 0 (P0 drift) |

총 단위 테스트: **189개 green** (`tsc --build` exit 0).

### 1.2 실행 가능 명령 (`package.json` scripts)

| script | 동작 | LLM | Memory | Skills | E2E? |
|---|---|---|---|---|---|
| `build` | tsc --build | n/a | n/a | n/a | n/a |
| `smoke:anthropic` | scripts/smoke-anthropic.ts | **REAL** Anthropic | none | none | AnthropicClient만 (Agent 우회) |
| `smoke:agent` | examples/minimal-host.ts | **MOCK** | InMemory | InMemory | Agent loop 1회 (mock) |
| `smoke:compaction` | examples/compaction-host.ts | MOCK | mock CompactableCapable | none | compaction trigger |
| `smoke:alpha-memory` | examples/alpha-memory-host.ts | MOCK | **REAL** alpha-memory | none | 메모리 실 동작 |
| `smoke:tool-error-halt` | examples/tool-error-halt.ts | MOCK | InMemory | InMemory | halt 동작 |
| `smoke:skill-loader` | examples/skill-loader-host.ts | MOCK | InMemory | **REAL** FileSkillLoader | SKILL.md 파싱 |
| `smoke:skill-tool` | examples/skill-tool-host.ts | MOCK | InMemory | **REAL** SkillToolExecutor | skill을 tool로 |
| `smoke:composite` | examples/composite-host.ts | MOCK | InMemory | **REAL** Composite + shadow warn | 다층 tool exec |

`bin/` **존재하지 않음**. `pnpm naia-agent` 같은 사용자 명령 부재.

### 1.3 테스트 (7개 `.test.ts` 파일, 189 케이스)

- protocol: 73 (Phase A — frame parse/encode pure functions)
- runtime: 93 (Phase B — GatedTool, SkillTool, Composite, Agent halt)
- core: 23 (Phase B + C.2 — Agent halt, streamLLM 청크 조립)

전부 unit. **integration 0건. fixture-replay E2E 0건. real-LLM 통합 0건.**

---

## 2. 원칙 만족도 평가

### 2.1 "점진적 구동" 만족 여부

| 척도 | 현재 | 갭 |
|---|:---:|---|
| 사용자 한 줄 명령으로 진짜 LLM 통신 가능? | ❌ | `bin/naia-agent` 부재. `smoke:anthropic`은 AnthropicClient만 직접 테스트, Agent 우회 |
| 사용자 한 줄 명령으로 진짜 Agent 루프 동작 가능? | ❌ | 모든 `smoke:agent*`이 MockLLMClient 사용 |
| 진짜 LLM + 진짜 memory + 진짜 skill 조합 1개 명령? | ❌ | 0건. examples/는 변수 1개씩만 real (각각 alpha-memory or skill만) |
| `echo hi \| naia-agent` 같은 stdin 인터페이스? | ❌ | 없음 |
| REPL? | ❌ | 없음 |
| **소비자 가치** | **0** | 어떤 사용자도 naia-agent를 "쓰지" 못 함. 라이브러리로 삽입만 가능 |

### 2.2 "테스트 가능" 만족 여부

| 척도 | 현재 | 갭 |
|---|:---:|---|
| `tsc --build` PASS | ✓ | — |
| `vitest` PASS (189 unit) | ✓ | — |
| 매 PR마다 회귀 잡힘? | 🟡 | unit만 있음. 실제 LLM 호출은 SDK 변경 시 silent fail 가능 |
| Agent 루프 결정적 재생 가능? | ❌ | fixture-replay 부재. 매 테스트 새로 mock 작성 |
| E2E test (real LLM with recorded fixture) 1건이라도? | ❌ | 0건 |
| skill catalog 회귀 잡힘? | 🟡 | unit만. skill 추가 시 통합 테스트 부재 |
| memory consolidation 회귀 잡힘? | 🟡 | shape only. consolidate 동작 stub (issue #1 trk) |

### 2.3 종합 점수

- **구동**: 0/6 (zero consumer value beyond library import)
- **테스트**: 2/6 (build + unit OK, integration/fixture/E2E 부재)
- **원칙 만족**: ❌ — 사용자 directive 미달

---

## 3. 갭 항목 (R1 슬라이스 척추 입력)

### 3.1 P0 — 다음 슬라이스를 막음

| # | 갭 | 해결 슬라이스 |
|---|---|---|
| G01 | `bin/naia-agent` 진입점 부재 | Slice 1: bin REPL 최소 구현 (real Anthropic + InMemoryMemory + 빈 ToolExecutor) |
| G02 | 진짜 LLM × Agent 통합 검증 0건 | Slice 1 도중 fixture-replay 1건 추가 |
| G03 | DANGEROUS_COMMANDS regex 보안 필터 미존재 (D01) | Slice 1: bash skill 추가 시 동시 도입 |
| G04 | Path normalization helper 미존재 (D02) | Slice 1: fileops native 도입 시 동시 |

### 3.2 P1 — 슬라이스 진행 중 함께

| # | 갭 | 해결 슬라이스 |
|---|---|---|
| G05 | observability 패키지 단위 테스트 0개 (E02 sub) | Slice 2: ConsoleLogger/InMemoryMeter/NoopTracer 단위 테스트 |
| G06 | Memory stubs 미구현 (E05) | issue #1 트래킹 — Slice 3 또는 별도 |
| G07 | Tool context 패턴 (D05) — sessionID/directory 전달 | Slice 1+ 진행하며 |
| G08 | Logger.tag/time 편의 (D06) | Slice 2 observability 보강 시 |
| G09 | Compaction overflow + 동적 preserveRecent (D07) | Slice 4 (compaction 재방문 시) |
| G10 | wLipSync viseme vocabulary (D03) | Phase 2 X7 |

### 3.3 P2 — 백로그

| # | 갭 | 해결 시점 |
|---|---|---|
| G11 | fixture-replay framework (StreamRecorder/Player) 자체 | Slice 1 진행하며 ad-hoc로 시작, Slice 5쯤 정식 framework |
| G12 | ChannelPlugin adapter 패턴 (D08) | naia-os messenger 리뷰 후 |
| G13 | AuthManager 이벤트 (C12) | daemon gateway 도입 시 |
| G14 | Command Registry 카테고리 (C13) | 명령어 50+ 도달 시 |

---

## 4. 슬라이스 success criterion 정의

R1 단계에서 모든 슬라이스는 **다음 4가지 모두**를 만족해야 한다 (생략 불가):

1. **새 실행 가능 명령** — 사용자가 한 줄로 새 동작 호출 가능
   - 예: `pnpm exec naia-agent "echo hi"` 또는 `pnpm dev:repl`
2. **단위 테스트 1+** — vitest로 실행되며 회귀 잡힘
3. **통합 검증 1+** — 가능한 형태:
   - fixture-replay (StreamRecorder 녹화 → Player 재생)
   - 또는 real-LLM smoke (CI에서 `ANTHROPIC_API_KEY` 있을 때만)
   - 또는 실제 alpha-memory consolidate 호출 검증
4. **README/CHANGELOG에 슬라이스 entry 1건** — 사용자 향한 변화 기록

(c) 통합 검증이 부재한 슬라이스는 **머지 금지**.

---

## 5. R0 종료 시점 갭 처리

본 plan(R0)은 갭을 **분석만** 한다. 해결은 R1+에서 슬라이스 단위로 처리.

R0 종료 직전(R0.7)에 P0/P1 갭을 sub-issue로 등록 — 본 매트릭스 ID(G01~G14)를 issue 제목 또는 label에 인용.

---

## 6. 참고 — 매트릭스 인용

본 갭 분석의 D-항목(D01~D08, D03, D05, D06, D07)은 `ref-adoption-matrix.md` §D 참조. ID 일관성 유지.

E-항목(E02, E05) 등은 같은 매트릭스 §E 참조. 본 갭 분석은 **새 갭만 G## 신규 부여** (G01~G14).
