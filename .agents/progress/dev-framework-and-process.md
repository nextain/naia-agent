# Dev framework + process — naia-agent

**작성일**: 2026-04-25 (R1.5 micro-phase)
**Master tracking**: nextain/naia-agent#2
**SoT for**: 개발 프레임웍 / 프로세스 특징 / 슬라이스 뼈대 / scope creep 방지

목적: 본 세션에서 결정·논의된 것이 미래 세션에서 유실되지 않도록 SoT 보존. CLAUDE/Gemini/opencode/Codex/naia 어떤 도구로 작업해도 동일한 frame 적용.

---

## 1. 개발 프레임웍

### 1.1 기술 스택 (확정 / R0~R5 변경 없음)

| 영역 | 선택 | 이유 |
|---|---|---|
| 언어 | **TypeScript** strict, ESM only | 4-repo 단일 스택 (naia-os Tauri shell도 TS) |
| 런타임 | Node ≥ 22 | top-level await, fetch 빌트인 |
| 패키지 매니저 | **pnpm workspace** | symlink 기반 monorepo, alpha-memory file: 의존 가능 |
| 빌드 | **tsc --build** (현재) | composite project, incremental |
| 테스트 | **vitest** | run/watch, ESM 친화, snapshot |
| 의존성 | 최소 — `@anthropic-ai/sdk`(providers 한정) + `@nextain/*` workspace:* | A.3 zero-runtime-dep contract 유지 |
| 형식 | (R2에서 확정) prettier + 최소 ESLint | over-config 회피 |

### 1.2 명시적으로 거부한 프레임웍 (매트릭스 §B 인용)

| 후보 | 거부 이유 |
|---|---|
| Effect TS (opencode 채택) | **B06** — 1000+ LoC 번들, zero-runtime-dep 위배 |
| Drizzle ORM / SQLite (opencode 채택) | **B05** — NotEffect 원칙 위배. 영속화는 host 책임 |
| Bun runtime (opencode 채택) | (검토 안 함) — Node 호환성 우선, alpha-memory도 Node |
| OpenTelemetry SDK (cline 채택) | **B09** — zero-runtime-dep 위배. 자체 Logger/Tracer/Meter contract |
| changesets, lerna | A.8 — 각 패키지 독립 semver, lockstep 안 함 |

### 1.3 패키지 구조 (6개, 4-repo plan A.4)

```
packages/
├── types          ← 계약 (zero-runtime-dep) — 변경 시 MAJOR 위험
├── protocol       ← wire (zero-runtime-dep) — types와 별개 semver
├── core           ← Agent 루프 ★ 척추
├── runtime        ← tool exec + skill loader
├── providers      ← AnthropicClient (여기만 SDK import)
└── observability  ← Logger/Tracer/Meter 기본 구현
```

**규칙 (A.3 불변식)**:
- Contract 3개(types/protocol/skill-spec)는 impl 패키지 import **절대 금지**
- Impl는 contract 자유 import
- Contract 끼리 type-only import 가능 (런타임 의존 아님)

### 1.4 테스트 분류

| 종류 | 위치 | 양 (현재) |
|---|---|---|
| pure-function unit | `packages/protocol/__tests__/` (Phase A) | 73 |
| trust boundary unit | `packages/runtime/__tests__/` (Phase B) | 93 |
| Agent loop unit | `packages/core/__tests__/` (Phase B + C.2) | 23 |
| **integration / fixture-replay** | (R3+ Slice 1부터 도입) | **0** |
| **real-LLM smoke (CI conditional)** | `scripts/smoke-anthropic.ts` (AnthropicClient 직접만) | 1 |
| **Agent-level smoke (real LLM)** | (Slice 1에서 도입) | **0** |

drift 위험 §E04 — Agent-level smoke 미존재. Slice 1에서 fixture-replay 도입으로 해소.

---

## 2. 프로세스 특징 — 런타임 모델

### 2.1 Single process (Slice 1 기준)

```
┌────────────────────────────────┐
│  bin/naia-agent.ts              │
│   └── Agent {                   │
│        host: HostContext (DI)   │
│        ├ llm: AnthropicClient   │ → HTTPS → Anthropic API
│        ├ memory: InMemory       │ (Slice 3: alpha-memory)
│        ├ tools: InMemory        │ (Slice 2: bash skill)
│        ├ logger: Console        │
│        └ ...                    │
│       }                         │
│   └── stdin/stdout/stderr       │
└────────────────────────────────┘
```

**특징**:
- **단일 프로세스** (Slice 1~5)
- **DI = 단순 객체 주입** — Effect Layer/IoC 컨테이너 거부 (B06). `new Agent({ host: {...} })` 한 번
- **Stream-first API** — `sendStream()` AsyncGenerator가 1차, `send()`는 drain wrapper (D1)
- **이벤트 emit 의무** — 모든 transition에서 Logger emit (A.5/A.11). 무시 = 계약 위반
- **1 HostContext = 1 Session** — multi-session은 host가 여러 HostContext 만들어 관리 (A.12)

### 2.2 호출 흐름 (1턴 = "ls 도구 호출 후 답")

```
user input "ls /tmp 해줘"
  ↓
Agent.sendStream(input)
  ├─ memory.recall(input, {topK:5})           [turn.started event]
  ├─ build messages = [system, ...recall, ...history, user]
  ├─ llm.stream(req)                          [llm.chunk events]
  │    ├─ text_delta → yield {type:"text"}
  │    └─ tool_use → yield {type:"tool.started"}
  │         ↓
  │    tools.execute(invocation, signal)      [tool.ended event]
  │         ↓
  │    if more iterations < maxToolHops(10):
  │         loop again with tool_result       [maxToolHops bound = D4]
  ├─ memory.encode(input, "user")             [non-critical, error logged]
  ├─ memory.encode(assistantText, "assistant")
  └─ yield {type:"turn.ended", assistantText}

# Long session 시 (Slice 4)
maybeCompact() 매 LLM 호출 전:
  if estimateTokens(req) > contextBudget(80K):
    if memory has CompactableCapable:
      → memory.compact()                      [delegated to alpha-memory rolling summary]
    else:
      → drop head N, keep tail 6              [fallback]
    yield {type:"compaction", droppedCount, realtime}
```

### 2.3 Multi-process 모델 (Slice 6+, R3+)

```
naia-os Tauri shell (Rust + WebView)
  └── spawn child process: naia-agent CLI
        ├── stdio frame protocol = @nextain/agent-protocol StdioFrame
        ├── shell sends: { type: "send", text: "..." }
        ├── agent yields: { type: "text"/"tool.started"/.../"turn.ended" }
        └── shell renders: avatar lip-sync, approval UI, audit log
```

이 IPC 프레임이 `@nextain/agent-protocol`이 존재하는 이유 (types와 별개 semver 이유).

### 2.4 보안 + 권한 모델 (4-repo plan A.6)

| 관심사 | 누가 | 어디 |
|---|---|---|
| LLM API key | shell stronghold | `HostContext.llm` 생성 시점 주입 |
| Tier 정책 (T0~T3) | runtime (`GatedToolExecutor`) | 자동 + 승인 요청 |
| 승인 UI | shell | `ApprovalBroker.decide()` shell 구현 |
| 감사 로그 | shell | tamper-evident, 30일+ |
| Bash 위험 명령 차단 (Slice 2) | runtime | DANGEROUS_COMMANDS regex (D01) |
| Path traversal (Slice 2) | runtime | path normalization (D02) |

---

## 3. 어떻게 만들 건지 — 프로세스 특징

### 3.1 슬라이스 단위 개발 (R1 강제)

매 슬라이스 = 1 PR 단위. **success criterion 4가지** (S01~S04, 머지 차단 게이트):

```
┌─────────────────────────────────────────────────┐
│ 1. 새 실행 가능 명령 (사용자 가치 1줄)            │
│ 2. vitest 단위 테스트 1+                         │
│ 3. 통합 검증 1+                                  │
│    ├─ fixture-replay (선호)                       │
│    ├─ real-LLM smoke (CI에서 KEY 있을 때만)       │
│    └─ 실 backend 호출 (alpha-memory 등)           │
│ 4. README/CHANGELOG entry 1건                    │
└─────────────────────────────────────────────────┘
```

(c) 통합 검증 부재 슬라이스 = **머지 거부**.

### 3.2 TDD vs 스켈레톤-우선 — 우리의 절충

이번 R0의 핵심 깨달음: 직전 세션이 **TDD를 너무 일찍 시작**해서 (189 unit test 만들었지만 한 번도 동작 안 함). 그래서 새 정책:

| 단계 | 우선순위 |
|---|---|
| **Slice 1** | **스켈레톤 먼저** (real Anthropic 통합) → 그다음 그 동작을 fixture로 녹화해 테스트 |
| Slice 2~5 | **스켈레톤 + 단위 테스트 동시** (각 슬라이스가 작아서 가능) |
| 추후 (Phase B/C rewind 재개) | TDD rewind 재개 (스켈레톤 살아있음 확인 후) |

요약: "TDD 우선" 대신 "**살아남는 코드 우선, 즉시 fixture 회귀 잡기**".

### 3.3 Branch + PR 워크플로 (4-repo plan A.7 — 1인 self-discipline)

```
main
  └── migration/slice-{N}-{name}    ← 이 prefix 강제
        ├── commit (단계별, 매트릭스 ID 인용)
        ├── PR open (자기 review 24h 이상)
        ├── E2E 1회 직접 실행
        ├── 매트릭스 §C → §A 승격 작업 (PR 마지막 단계)
        └── merge → main
```

매 commit message:
```
type(scope): summary [fixes G##/D##/E##]

(본문 — 변경 이유, 매트릭스 영향)

Co-Authored-By: ...
```

### 3.4 Fixture-replay = 우리의 핵심 회귀 무기

opencode가 안 한 것을 우리가 함 (매트릭스 §D + §C21 승격 후보):

```
[Slice 1 — ad-hoc]
1. 한 번 진짜 Anthropic 호출
2. SDK 스트림 청크를 JSON으로 dump
3. JSON을 read해서 AsyncIterable<Chunk>로 재생
4. Agent.sendStream() input은 동일하게 → assistantText 결정적

[Slice 5 — 정식 framework]
@nextain/agent-testing 패키지로 격상:
- StreamRecorder (env에서 키 있으면 자동 녹화)
- StreamPlayer (CI에서 키 없을 때 자동 재생)
- 모든 슬라이스의 fixture를 cross-check
```

이게 있으면 **CI에서 매번 진짜 LLM 안 부르고도 회귀 잡힘**. 비용·결정성 둘 다 해결.

### 3.5 슬라이스 진행 순서

```
Now ─→ R2(Slice 0) ─→ Slice 1 ─→ Slice 2 ─→ Slice 3 ─→ Slice 4 ─→ Slice 5
                       ★ 여기 살아남으면 R1 성공
```

상세는 `r1-slice-spine-2026-04-25.md`.

**중단 트리거**:
- Slice 1 실패 (real Anthropic 통합 못 함, fixture도 안 됨) → R0 재진입
- A.3 의존 방향 깨짐 발견 → 매트릭스 §A 재검토
- 사용자 directive 변경 → R0 재진입

---

## 4. 슬라이스 뼈대 — 두 layer

### 4.1 Layer 1: 4-repo 생태계 뼈대 (R0/R1 변경 없음, plan A.1)

```
┌─ naia-os (host) ──────────────────────┐
│  Tauri shell + 3D avatar + OS image    │
│  approval UI, identity, audit log      │
└──── embeds ────┬──────────────────────┘
                 ▼
┌─ naia-agent (이 레포 = 척추) ────────────┐
│  Runtime: Agent loop, tool exec, mem    │
│  Contracts: LLMClient, MemoryProvider,  │
│   ToolExecutor, SkillLoader, HostContext│
└──── injects ┬─────┬──────────────────────┘
              ▼     ▼
   alpha-memory   naia-adk
   (memory impl)  (skill format)
```

**핵심**: 4개 레포가 런타임에 서로 import 안 함. host(naia-os 또는 CLI)가 구현체 주입. naia-agent는 인터페이스 + 루프 엔진만 정의.

### 4.2 Layer 2: 슬라이스 뼈대 (R1 6개)

```
Slice 0 (R2)   골격 페인트 ........ (코드 0줄, 인프라)
   │
Slice 1   ★ 척추 ..............  bin/naia-agent + real Anthropic
   │       └─ 여기서 "처음 살아남음"
Slice 2     손  ................. bash skill (진짜 도구)
   │
Slice 3     기억 ................. alpha-memory 통합
   │
Slice 4     폐  ................. compaction (long session)
   │
Slice 5   허파 ................. fixture-replay framework
```

### 4.3 Slice 1 = naia-agent가 처음 살아남는 모습

R0 직전까지 naia-agent는 라이브러리 import만 가능. Slice 1 후엔:

```bash
$ pnpm exec naia-agent "hello"     # args 모드
Hello! How can I help?
$ echo "1+1?" | pnpm exec naia-agent  # stdin 모드
2
$ pnpm exec naia-agent              # REPL 모드
naia> _
```

부품 조립 (예상 ~80줄, examples/minimal-host.ts에서 mock 교체):

```typescript
// bin/naia-agent.ts
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "@nextain/agent-core";
import { AnthropicClient } from "@nextain/agent-providers";
import { InMemoryMemory, InMemoryToolExecutor } from "@nextain/agent-runtime";
import { ConsoleLogger, InMemoryMeter, NoopTracer } from "@nextain/agent-observability";

const sdk = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const agent = new Agent({
  host: {
    llm: new AnthropicClient(sdk, { defaultModel: "claude-haiku-4-5-20251001" }),
    memory: new InMemoryMemory(),         // Slice 3: alpha-memory 교체
    tools: new InMemoryToolExecutor(),    // Slice 2: bash skill 추가
    logger: new ConsoleLogger(),
    tracer: new NoopTracer(),
    meter: new InMemoryMeter(),
    approvals: { async decide() { throw new Error("T2+ not wired in Slice 1"); } },
    identity: { deviceId: "dev", publicKeyEd25519: "dev", async sign() { throw new Error(); } },
  },
});

const input = await getInput();  // args / stdin / REPL 분기
for await (const ev of agent.sendStream(input)) {
  if (ev.type === "text") process.stdout.write(ev.delta);
}
```

### 4.4 의도적으로 Slice 1에서 빠진 것 (다른 슬라이스 책임)

- 진짜 도구 실행 → Slice 2
- 진짜 기억 → Slice 3
- 동적 compaction → Slice 4
- 정식 fixture framework → Slice 5
- 승인 UI → naia-os shell 책임 (plan A.6, naia-agent는 contract만)
- TUI 색깔/포맷 → host 책임 (plain stdout)

### 4.5 왜 "Slice 1만 척추"인가

- **Slice 1** = 한 번 동작하면 다른 모든 슬라이스가 이 위에 build
- Slice 2~5 = 척추에 부품 추가
- Slice 1 실패 = 전체 R1 abort

### 4.6 Slice 6+ (R3+, naia-os 통합) — 미래

```
Slice 1: naia-agent CLI 단독 동작 (host = CLI 자체)
Slice 3: naia-agent CLI + alpha-memory 통합 (host = CLI, alpha-memory injected)
Slice 6+ (R3+): naia-os shell이 naia-agent CLI를 sidecar로 spawn
                = 4-repo 통합 첫 증거
```

즉 **Slice 1~5 = naia-agent 단독 뼈대 완성**, **Slice 6+ = 4-repo 통합 뼈대 합체**.

---

## 5. Scope creep 방지 메커니즘 (4 + 1)

### 5.1 작동 중 (4가지)

| # | 메커니즘 | 위치 | 효과 |
|---|---|---|---|
| ① | **forbidden_actions (F01~F08)** | `.agents/context/agents-rules.json` | 8개 자동 게이트 (bin 미존재 시 코드 변경 차단 등) |
| ② | **AGENTS.md "절대 금지" 섹션** | `AGENTS.md` (canonical SoT) | 사람·AI 공통 룰. 4개 mirror 자동 동기 |
| ③ | **매트릭스 ID 인용 강제** | commit message + PR description | `fixes G##/D##` 형식 — trace 가능 |
| ④ | **Master status board** | nextain/naia-agent#2 | 한 곳에서 R0/R1/Slice 0~5 진행 가시 |

### 5.2 보강된 메커니즘 (R1.5에서 추가)

- **⑤ 매트릭스 업데이트 forgetting 방지**: Slice PR 머지 마지막 단계에서 매트릭스 §C → §A 승격, §E → 해소 작업 강제. PR template 체크박스로 (R2 Slice 0에서 추가).

### 5.3 점검 흐름

```
새 작업 시작 시
  → AGENTS.md (또는 mirror) 읽음
  → forbidden_actions 확인 (agents-rules.json)
  → 매트릭스 §A~F 해당 항목 ID 확보
  ↓
작업 중
  → 매 commit에 매트릭스 ID 인용
  → 슬라이스 success criterion 4가지 체크
  ↓
PR 마지막 단계
  → 매트릭스 §C → §A 승격 commit (별도 또는 병합)
  → README/CHANGELOG entry
  → 통합 검증 1+ 도입 확인
  ↓
PR open
  → 24h 자가 review
  → E2E 1회 직접 실행
  → CI: sync-harness-mirrors.sh --check + vitest
  ↓
머지 → main
  ↓
#2 status board에 슬라이스 entry 체크
```

이 흐름 어디에서 "다른 데로 빠지면" 자동 게이트(forbidden_actions) 또는 success criterion 검증에서 잡힘.

---

## 6. 본 문서 위치

본 문서는 **R1.5 micro-phase**의 산출물. R0(설계 재점검) + R1(슬라이스 척추) 결정 + 본 세션 사용자와의 논의 (개발 프레임웍/프로세스/뼈대 질문에 답변한 내용)을 단일 SoT로 통합.

미래 세션에서 도구 무관하게 (Claude/Gemini/opencode/Codex/naia) 본 문서를 읽으면 이 시점의 결정·근거·구조 모두 파악 가능.

---

## 7. 변경 이력

- **2026-04-25** (R1.5): 초기 작성. 본 세션 논의 SoT로 통합.
