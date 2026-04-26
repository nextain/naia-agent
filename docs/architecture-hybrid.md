# Architecture (Hybrid Wrapper, R4 lock 2026-04-26)

> **상위**: `docs/vision-statement.md` (R4 lock)
> **이전**: `docs/ARCHITECTURE.md` (R0~R3, 정규 SoT 보존; R4는 sup 추가)
> **status**: design lock (Week 0)

---

## 1. layer overview

```
┌────────────────────────────────────────────────────────────────────┐
│ [사용자]  voice / text / keypress (interrupt 포함)                  │
└─────┬──────────────────────────────────────────────────────────────┘
      │
┌─────▼────────── naia-shell (별도 repo, Phase 4+) ──────────────────┐
│  • voice (STT/TTS)                                                 │
│  • avatar (VRM, lip-sync)                                          │
│  • 통합 UI (대화 main + sub-session 카드 + workspace diff panel)    │
└─────┬──────────────────────────────────────────────────────────────┘
      │ stdio / IPC (Phase 1~3 = 직접 CLI 사용 가능)
      ▼
┌─────────────── naia-agent (이 repo) ───────────────────────────────┐
│                                                                    │
│  apps/cli/repl                  ← 알파 대화창 (Phase 1)             │
│       │                                                            │
│  ┌────▼─────────────────────────────────────────────────────────┐ │
│  │ core (얇음)                                                   │ │
│  │   conversation  supervisor  interrupt  stream-merger          │ │
│  └────┬─────────────────┬─────────────────┬─────────────────────┘ │
│       │                 │                 │                        │
│  ┌────▼────────┐  ┌────▼────────┐  ┌────▼────────────────────┐  │
│  │ adapters/   │  │ workspace/  │  │ verification/             │  │
│  │ opencode    │  │ watcher     │  │ orchestrator              │  │
│  │ claude-code │  │ diff        │  │ runners {test/lint/build} │  │
│  │ shell       │  │             │  │ reporter                  │  │
│  └────┬────────┘  └────┬────────┘  └────┬─────────────────────┘  │
│       │                │                 │                        │
│  ┌────▼────────┐  ┌────▼────────┐  ┌────▼────────┐                │
│  │ providers/  │  │ memory/     │  │ observability│                │
│  │ openai-     │  │ alpha-memory│  │ logger/dev/  │                │
│  │ compat      │  │ adapter     │  │ redact       │                │
│  └────┬────────┘  └────┬────────┘  └─────────────┘                │
└───────┼────────────────┼───────────────────────────────────────────┘
        │                │
   ┌────▼──────┐    ┌────▼──────────────────┐
   │ any-llm   │    │ alpha-memory (peer)   │
   │ vllm-omni │    │ naia-adk (peer, 미래) │
   └───────────┘    └───────────────────────┘
        ▲
        │ HTTP OpenAI-compat
   external LLM (Anthropic / Google / GLM / OpenAI / OpenRouter ...)
```

**의존 방향**: 단방향 (위 → 아래). naia-agent는 sub-agent 본체 모름 (interface로만).

---

## 2. 패키지 맵 (R4 추가/이동)

| 위치 | R3 까지 | R4 변경 |
|---|---|---|
| `packages/types/` | LLM/Tool/Memory/Skill/Observability interface | + `SubAgentAdapter` `Verifier` `WorkspaceWatcher` `NaiaStreamChunk` (D20/D24) |
| `packages/core/` | `Agent` (turn loop) | + `Supervisor` `Conversation` `Interrupt` `StreamMerger` |
| `packages/runtime/skills/{bash,file-ops}` | bash/file-ops skill 본체 | **dev-only 강등** (Phase 1 fallback) — production은 opencode/cc 위임 |
| `packages/providers/anthropic.ts` | Anthropic SDK 직접 | **dev-only 강등** — production은 any-llm 통해 |
| `packages/providers/openai-compat.ts` | OpenAI-compat fetch | **유지** (any-llm 호출 main) |
| `packages/providers/anthropic-vertex.ts` | Vertex SDK | **폐기 후보** — any-llm이 Vertex routing |
| `packages/observability/` | Logger / dev-logger / redact | **유지** (Logger.fn() trace 표준 적용 영역 확장) |
| **`packages/adapters/`** (신설) | — | opencode / claude-code / shell adapter |
| **`packages/workspace/`** (신설) | — | watcher (chokidar) + diff (git diff) |
| **`packages/verification/`** (신설) | — | orchestrator + runners + reporter |
| **`packages/memory/`** (신설) | — | alpha-memory adapter |
| **`apps/cli/`** (신설) | bin/naia-agent.ts (R3 이미 있음) | 분리 + Conversation/Supervisor 사용 |

---

## 3. 7 설계 원칙

| # | 원칙 | 강제 |
|---|---|---|
| 1 | **Layered architecture** — 단방향 의존 (위→아래만) | tsconfig project references + lint rule |
| 2 | **Interface-first** — `@nextain/agent-types`에 interface, 구현 pkg 분리. host inject | F03 변형 강제 |
| 3 | **Stream-first** — 모든 layer가 `AsyncIterable<NaiaStreamChunk>`. blocking 금지 | code review |
| 4 | **No global state** — singleton/global 변수 0건. 모든 state ctor 주입 | lint rule (no-mutable-export) |
| 5 | **Adapter pattern** — opencode/claude-code/vllm-omni 모두 같은 interface. 새 sub-agent = adapter 1개 | adapter contract test |
| 6 | **모듈 ≤ 300 LOC** — 한 책임 원칙 | code review |
| 7 | **Logger.fn() trace 표준** — 모든 함수에 enter/branch/exit | dev mode 자동 검사 (Slice 2.7 도입) |

---

## 4. 핵심 인터페이스 (뼈대의 뼈대)

전체 spec은 `docs/adapter-contract.md` 참조. 여기는 핵심 5개만:

```typescript
// types/src/sub-agent.ts
interface SubAgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly Capability[];
  spawn(task: TaskSpec, ctx: SpawnContext): Promise<SubAgentSession>;
}

interface SubAgentSession {
  readonly id: string;
  readonly adapterId: string;
  events(): AsyncIterable<SubAgentEvent>;
  cancel(reason?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  status(): SubAgentStatus;
}

// types/src/verification.ts
interface Verifier {
  readonly id: string;
  run(workdir: string, signal: AbortSignal): Promise<VerificationResult>;
}

// types/src/workspace.ts
interface WorkspaceWatcher {
  start(workdir: string): AsyncIterable<WorkspaceChange>;
  stop(): Promise<void>;
}

// types/src/stream.ts
type NaiaStreamChunk = { ... }  // 자세히는 stream-protocol.md
```

---

## 5. 의존 방향 (단방향, lint-enforced)

### 5a. pkg 간 의존 (top-level)

```
apps/cli  →  core  →  {adapters, workspace, verification, memory, providers, observability}  →  types
                                                                                                   ↑
                                                                                          (모두가 types 참조 OK)
```

**금지** (lint rule):
- `core` → `apps/cli` (역방향)
- `types` → 다른 pkg (types는 leaf)
- `adapters/X` → `adapters/Y` (cross-adapter 직접 의존)
- `providers` ↔ `adapters` (서로 모름)

**예외**:
- `observability`는 모든 pkg에서 import OK (logger 횡단)
- `tests/` 는 모든 pkg import OK (test fixture)

### 5b. core 내부 module DAG (P0-9 fix, Architect 권고)

`core/`는 4개 module — 명시적 단방향 DAG:

```
                  ┌─────────────────────┐
                  │  core/conversation  │  (LLM 호출 + history + decompose)
                  │  depends: types,    │
                  │           providers │
                  └──────────┬──────────┘
                             │ uses
                  ┌──────────▼──────────┐
                  │  core/supervisor    │  (sub-agent orchestration)
                  │  depends: types,    │
                  │   conversation,     │
                  │   adapters (DI),    │
                  │   stream-merger,    │
                  │   interrupt,        │
                  │   verification (DI),│
                  │   workspace (DI),   │
                  │   memory (DI)       │
                  └──────────┬──────────┘
                             │ owns
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      ┌─────────────┐  ┌──────────┐  ┌──────────────┐
      │stream-merger│  │interrupt │  │ (event emit) │
      │ depends:    │  │ depends: │  │              │
      │  types only │  │  types   │  │              │
      └─────────────┘  └──────────┘  └──────────────┘
```

**규칙**:
- `conversation` → `types` + `providers` (LLM 호출 위해 LLMClient interface)
- `supervisor` → 모두 (DI로 주입). 자체 logic은 orchestration만
- `stream-merger` → `types` only (pure function, N stream → 1 stream merge)
- `interrupt` → `types` only (pure signal management)

**lint rule**: tsconfig project references 강제, eslint `import/no-restricted-paths` 정책 (각 module의 허용된 import만).

**예시 — supervisor.ts**:
```typescript
import { Conversation } from "./conversation.js";        // OK (core 내부 사용)
import { mergeStreams } from "./stream-merger.js";        // OK
import { Interrupt } from "./interrupt.js";               // OK
import type { SubAgentAdapter } from "@nextain/agent-types"; // OK (types)
// import { OpenCodeAdapter } from "@nextain/agent-adapter-opencode"; // ✗ — adapter 직접 import 금지, DI로
```

---

## 6. 성능 + 안정성 설계

### 6a. 성능 (기본)

| 영역 | 전략 | 근거 |
|---|---|---|
| Sub-agent stream | async iterable (back-pressure 자연 지원) | matrix D01 stream-first |
| File watcher | chokidar debounce 100ms — 같은 파일 다중 변경은 1 chunk (latest state) | matrix D27 + Architect P1-1 |
| Diff compute | lazy (사용자 요청 시만 git diff 호출) | 큰 repo overhead 방지 |
| LLM cache | any-llm/Anthropic의 cache_read 활용 | matrix D16 prompt cache |
| 다중 stream merge | `Promise.race` round-robin (block X) | block-free |
| Verification | 병렬 (test/lint/build 동시) | wall-time 단축 |
| Logger | dev-only 파일 기록 (production overhead 0) | Slice 2.7 dev-mode auto |
| ACP/SDK call | timeout + cancel signal 항상 | 무한 hang 방지 |

### 6b. Verification 3중 방어 (P0-10, matrix D27)

verification orchestrator는 다음 3 layer로 fail-safe:

| layer | mechanism | trigger |
|---|---|---|
| **L1: abort signal** | 모든 verifier가 `VerifierContext.signal` 체크. abort 시 즉시 stop | 사용자 cancel / parent timeout |
| **L2: memory limit** | child process spawn 시 `--max-old-space-size` 또는 cgroup memory limit. 초과 시 OOM kill | runaway test/lint |
| **L3: wall-clock timeout** | 각 runner별 default timeout (Phase 1=60s, Phase 2+=5min override 가능) | hang / infinite loop |

세 layer 중 하나라도 trigger → `verification_result(pass: false, ...)` emit + `session_end(reason: "timeout")`.

**근거**: cleanroom F11 silent drop 회피 + Mastra D13 패턴.

### 6c. Interrupt deadline (P0-7, Paranoid)

음성 "중지중지" → STT → naia-agent supervisor → adapter cancel:

| 단계 | 예산 |
|---|---|
| 마이크 캡처 | 50ms |
| STT (Whisper minimal) | ≤ 800ms (keyword detection + partial decode) |
| naia-agent core dispatch | ≤ 50ms |
| **adapter.cancel() invocation** | ≤ 50ms |
| **adapter session_end emit** | ≤ 500ms (hard deadline) |
| **합계 음성 → child kill** | **≤ 1.5초** |

**hard kill 강제**:
- adapter.cancel() 후 500ms 내 session_end 미emit → supervisor가 SIGKILL (Node.js `subprocess.kill('SIGKILL')`)
- contract test C12 (`adapter-contract.md`)에서 검증

**T2/T3 tool 사전 차단** (race 보호):
- destructive tool (rm, git push, chmod 등) = T2/T3 → ApprovalBroker 사전 승인 강제
- 사용자 승인 전 실행 불가 → "중지" latency 동안 destructive action 불가능

→ "중지" 음성 → 1.5초 내 child process 종료 보장. 그 사이 destructive action은 approval gate로 차단.

---

## 7. 유지보수 설계

| 변경 시나리오 | 영향 범위 | 회귀 위험 |
|---|---|:---:|
| opencode v1 → v2 (breaking) | `adapters/opencode/` 만 | low |
| 새 sub-agent (예: aider) | `adapters/aider/` 신설 | none |
| LLM provider 추가 | `providers/` 만 | none |
| verification runner 추가 | `verification/runners/` 만 | none |
| stream chunk 타입 추가 | `types/stream.ts` + 표시 layer | medium (consumer 모두 union 처리) |
| naia-shell 신설 | `apps/shell` 옆 추가 — core 무수정 | none |
| any-llm endpoint 변경 | env config | none |

---

## 8. test pyramid

| 레벨 | 도구 | 대상 |
|---|---|---|
| **unit** (mock) | vitest + mock 모든 의존 | 각 모듈 logic 단독 |
| **adapter contract** | vitest + 가짜 ACP/SDK server | adapter spec 준수 |
| **integration** (fixture) | vitest + StreamPlayer (G15) | sub-agent event sequence replay |
| **integration** (real) | vitest opt-in (KEY 필요) | 실제 opencode/any-llm 1 turn |
| **E2E** | shell script + naia-agent CLI | "hello 함수 추가" → 결과 검증 |

CI: unit + adapter contract + integration fixture만 (KEY 없이). real-LLM은 opt-in.

---

## 9. 보안 설계 (4-repo plan A.6 보존 + Hybrid 추가)

| 관심사 | 위치 | R4 추가 |
|---|---|---|
| LLM API key | shell stronghold (HostContext.llm 주입) | any-llm key는 naia 계정 1개 |
| Tier 정책 (T0~T3) | runtime (`GatedToolExecutor`) | sub-agent도 tier 적용 (ACP approval) |
| 승인 UI | shell (`ApprovalBroker.decide()`) | sub-session card에서도 가능 |
| 감사 로그 | shell (tamper-evident, 30일+) | sub-agent event도 trail에 포함 |
| Bash 위험 명령 차단 | runtime (DANGEROUS_COMMANDS regex) | opencode/cc 자체 보안 위 우리 추가 layer (옵션) |
| Path traversal | runtime (path normalization) | sub-agent workdir 격리 (`spawn` ctx에 강제) |
| Sub-agent 감금 | adapter ctor에 workdir / env 명시 | escape 방지 (`adapters/*` spec) |
| Interrupt 우선순위 | core/interrupt | T2/T3 tool 실행 중에도 SIGTERM 가능 |

---

## 10. R4 lock 후 변경 절차

본 architecture 변경 시:
1. 본 파일에 Change log 섹션
2. r4-hybrid-wrapper-2026-04-26.md 에 사유
3. 매트릭스 §D 새 결정 또는 §B 새 거부
4. master issue #2 댓글
5. cross-review (3-perspective) 후 진행

§A 채택은 R0 lock, R4도 변경 X.
