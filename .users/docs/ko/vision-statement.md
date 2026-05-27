# naia-agent vision statement (R4 lock 2026-04-26)

> **언어**: [English](../../../docs/vision-statement.md) · 한국어 (이 파일)

> **한 줄**: "Real-time interruptible multi-agent supervisor with multi-modal stream + 정직 보고."

---

## 1. naia-agent 란

사용자 (luke) 의 **AI 비서 + 작업 운영자**. 단일 대화창 안에서 사용자가 명령하고, naia-agent 가 다중 sub-agent 를 운영해 실제 작업을 수행하며, **수치 기반 정직 보고** 로 신뢰를 유지한다.

핵심 use case (R4 motivation):

| # | 사용자 페인포인트 | naia-agent 의 답 |
|---|---|---|
| 1 | 여러 터미널 + 여러 AI agent 병렬은 피곤 | 단일 대화창에 통합 |
| 2 | 자꾸 놓침 (인지 부담) | naia-agent 가 sub-session 운영 + 통합 보고 |
| 3 | 보고 ≠ 실제 (큰 낭패) | 자동 verification (test/lint/build) + 수치 diff stats |
| 4 | 잘못되면 즉시 멈춤 | "중지중지" 음성 / Ctrl+C / 카드 [중지] |
| 5 | workspace 변경 즉시 확인 | file watcher + diff preview |
| 6 | sub-session 활동 파악 | ACP/SDK event stream 카드 view |

---

## 2. naia-agent 가 아닌 것

| 아님 | 위임 또는 상위 layer |
|---|---|
| 자체 coding tool 본체 (bash/file/git/refactor) | opencode / claude-code (sub-agent) |
| 자체 LLM provider 50+ | any-llm 원격 gateway |
| 자체 음성 / avatar / UI | naia-shell (별도 repo) |
| 자체 long-term memory | naia-memory (별도 repo) |
| 자체 skill 카탈로그 | naia-adk (별도 repo) |
| IDE / file editor / 자체 git impl | 사용자 기존 IDE 사용 |
| 외부 사용자용 Agent framework | 1인 (luke) 전용으로 시작 |

---

## 3. 차별화 (3 차원, 다른 framework 에 거의 없음)

| 차원 | naia-agent | claude-code / opencode / Mastra / Vercel AI SDK |
|---|:---:|:---:|
| **Multi-modal stream** (audio_delta 1급) | ★★★ | text only |
| **Sub-agent supervisor** (ACP/SDK + audit + interrupt) | ★★★ | standalone (supervisor 가 아닌 supervisee) |
| **단일 대화 + 정직 보고** (verification + diff + 수치) | ★★★ | 보고 ≠ 실제 (hallucination 문제 그대로) |

→ **voice-capable + multi-agent 운영 시대의 supervisor runtime**.

(주: voice I/O = naia-os + naia-omni 영역. naia-agent는 text turn only.)

---

## 4. 핵심 책임 (priority lock)

| 우선 | 책임 | 근거 |
|:---:|---|---|
| ★★★ | 단일 대화 인터페이스 | vision motivation #1 |
| ★★★ | Workspace event stream (file watcher + diff) | motivation #5 |
| ★★★ | Sub-session event stream (ACP/SDK capture) | motivation #6 |
| ★★★ | 자동 verification + 수치 정직 보고 | motivation #3 |
| ★★★ | Real-time interrupt + pause/resume | motivation #4 |
| ★★★ | Sub-agent supervision (다중 orchestration) | motivation #2 |
| ★★ | 연속 context (naia-memory) | "연속적으로 일을 시키는" |
| ★★ | Multi-modal stream protocol (audio/image forward) | voice cascade (Slice 3-XR-Voice / P0c-2) |
| ★★ | Interface 정의 (SubAgentAdapter / Verifier / WorkspaceWatcher / LLMClient / MemoryProvider / SkillLoader) | DI |

---

## 4b. Naia (engine) vs alpha (persona instance)

| layer | 이름 | 정의 |
|---|---|---|
| **runtime engine** (이 repo) | **Naia** | generic, 페르소나 없음. default CLI label "[Naia]" |
| **persona instance** | **alpha** | luke 개인용 AI = naia-adk (skill + convention) + naia-memory (user context) 결합 |

**원칙**: naia-agent 는 페르소나를 가지지 않는다. "alpha" 는 인스턴스 이름이며, 다음 두 layer 가 정의한다:

1. **naia-adk** — naia 인스턴스의 **스킬 + 프로세스 + 기본 컨텍스트 (페르소나)**
   - skill 표준 + skill 카탈로그
   - 워크플로우 프로세스 (예: 검토 → 결정 → 실행 패턴)
   - 페르소나 system prompt 컨벤션 (캐릭터, 한국어 default, 비서 role, 대화 스타일)
   - 모두 정적 (사용자 무관, 인스턴스 정의)
2. **naia-memory** — 사용자별 long-term **기억** (동적)
   - 이전 대화 history
   - 사용자 선호 / 메타데이터
   - 작업 history / task 컨텍스트

### 페르소나 위치 trade-off (디자인 결정 기록)

**의미론적 정당성**: 페르소나 (personality, identity) 는 "그 사람을 그 사람이게 하는 기억" 의 일부 → 본질적으로 naia-memory 에 속하는 게 자연스러움.

**현실 (기존 시스템 호환)**: 그러나 Claude / opencode / Vercel AI SDK 등 모든 기존 agent 시스템은 페르소나를 **system prompt** (정적 spec) 으로 inject 한다. naia-agent 도 sub-agent 로 그들을 wrap 하므로, 페르소나는 **system prompt 컨벤션 영역 = naia-adk** 가 가지는 게 현실적이고 호환됨.

**결정**: naia-adk 가 페르소나 (정적 base) + naia-memory 가 사용자 컨텍스트 (동적). 두 layer 가 합쳐져 "alpha" 인스턴스를 정의.

→ Phase 3 에서 두 layer 동시 inject 메커니즘 정식화: `TaskSpec.extraSystemPrompt = naia-adk persona base + naia-memory.recall() result`

### 4-repo 책임 분리 LOCK (2026-04-26 사용자 directive)

| repo | 책임 |
|---|---|
| **naia-os** (host) | host OS 전체 — UI + Avatar + audio device IO (mic/speaker via Tauri Rust cpal) + channel adapters + OS-specific skills (Device/Voicewake/Panel/Channels) |
| **naia-agent** (engine) | LLM core + supervisor + sub-agent. Voice I/O = naia-os + naia-omni 영역 (naia-agent는 text turn only). |
| **naia-adk** | skill **spec/interface only** + 9 generic skills 카탈로그 (Cron/Memo/Time/Weather/Notify/Diagnostics/Sessions/Skill-manager/Config/SystemStatus). 실행은 naia-agent |
| **naia-memory** | memory engine (encode/recall/decay/etc) |

### Voice / multi-modal (naia-os + naia-omni 영역)

Voice I/O는 **naia-os + naia-omni** 가 담당. naia-agent는 text turn only — 오디오 장치, STT, TTS, 스트리밍 오케스트레이션을 인식하지 않음.

- naia-omni 내부 구현은 캡슐화됨. naia-agent 코드·문서에 노출 금지.
- naia-agent는 `chat_request` IPC로 텍스트를 받고 텍스트를 반환. Voice wrapping은 naia-os 담당.
- 이전 "omni model" 계획 (vllm-omni / MiniCPM-o-4.5) 폐기. 메모리 `project_minicpm_o_4_5_deprecated_2026_05_20` 참조.

### naia-* / alpha-* prefix 체계 (이름 일관성)

**모든 engine 모듈은 `naia-` prefix** (사용자 directive 2026-04-26 결정 — alpha-memory → naia-memory rename):

| prefix | 의미 | 예 |
|---|---|---|
| **naia-** | generic engine 모듈 (모두에게 동일, npm `@nextain/`) | naia-agent / naia-adk / **naia-memory** / naia-os / naia-shell |
| **(개인 prefix)** | **사용자 인스턴스** workspace (host repo) | **alpha-adk** (luke 의 host repo, 페르소나 = "alpha") / `bob-adk` (bob 의 host) 등 |

따라서:
- **alpha** = luke 의 AI **페르소나/인스턴스 이름**
- **alpha-adk** = luke workspace root (이 repo, host) — alpha 인스턴스의 모든 데이터 보관
- **naia-memory** = generic memory 엔진 (npm pkg `@nextain/naia-memory`)

### alpha 인스턴스 백업 시나리오 (사용자 directive)

**`alpha-adk` 디렉터리만 백업하면 alpha 인스턴스 완전 복원**:

```
alpha-adk/                            # ← 이걸 backup 하면 alpha 전체 복원
├── data/                             # 인스턴스 데이터 (naia-adk 컨벤션)
│   ├── memory/                       # ← naia-memory 가 여기 저장 (사용자 기억)
│   ├── skills/                       # ← 사용자 추가 skill 정의
│   └── persona/                      # ← 페르소나 override (한국어 톤, 호칭 등)
├── projects/                         # ← submodule pointers
│   ├── naia-agent/                   # generic engine
│   ├── naia-adk/                     # generic skill+process+persona convention
│   ├── naia-memory/                  # generic memory engine (pkg name `@nextain/naia-memory`)
│   └── naia-os/                      # generic host shell
├── .agents/                          # workspace context/rules
└── ... (기타 user 영역)
```

→ `git push alpha-adk origin main` (또는 tar backup) = alpha 의 **skill + context + 기억 모두 보존**.
→ engine module 들 (naia-agent / naia-memory 등) 은 generic 이라 어디서든 받아 결합.

### naia-adk 가 정의하는 memory storage path 컨벤션 (Phase 3 정식화)

```
${ADK_ROOT}/data/memory/        # naia-adk 컨벤션 (relative)
```

`alpha-adk` 가 host 로 동작 시:
- `ADK_ROOT` 가 alpha-adk repo 를 가리킴 (env 에서 해석)
- `naia-memory` 가 `${ADK_ROOT}/data/memory/` 에 SQLite/vector store 저장
- alpha-adk repo backup = memory data 자동 포함

다른 사용자 (`bob-adk`):
- `ADK_ROOT` 가 bob-adk repo 를 가리킴 → `bob-adk/data/memory/` 에 저장
- 동일 `naia-memory` engine 으로 격리된 데이터.

이 컨벤션은 Phase 3 naia-memory 통합 시점에 정식 wire.

naia-agent 는 두 layer 를 **inject 할 hook 만 제공**:

| hook | 시점 | Phase |
|---|---|---|
| `NAIA_PERSONA_LABEL` env | CLI 출력 label override (예: "Naia" → "alpha") | **Phase 2 (현재)** |
| `TaskSpec.extraSystemPrompt` | sub-agent system prompt 에 페르소나/memory 주입 | Phase 3 (naia-memory 통합 시) |
| `MemoryProvider.recall()` | 대화 시작 시 사용자 컨텍스트 가져옴 → extraSystemPrompt | Phase 3 |

**alpha-adk (이 workspace) host 가 inject 예시** (Phase 3):
```bash
export NAIA_PERSONA_LABEL=alpha
# alpha-adk 가 naia-adk 에서 페르소나 spec 로드 + naia-memory.recall() 결과 결합 →
# TaskSpec.extraSystemPrompt 채워서 naia-agent 호출
pnpm naia-agent "..."
```

→ 동일 naia-agent 엔진으로 다양한 페르소나 인스턴스 (alpha / 다른 사용자용 / public Naia 등) 생성 가능. naia-agent 는 "**페르소나 hosting platform**" 이지 페르소나 자체가 아님.

---

## 5. lock 된 결정 요약 (R4)

| | 결정 |
|---|---|
| Path | Hybrid wrapper (B) — 자체 ~2,150 LOC + 외부 wrap |
| LLM | any-llm 원격 gateway main; voice = naia-os + naia-omni 영역 (naia-agent는 LLM 텍스트 턴만); Vercel AI SDK 보류 |
| Sub-agent | opencode (ACP) + claude-code SDK + 단순 stdio fallback |
| Memory | naia-memory peer dep |
| Skill | naia-adk peer dep (향후) |
| UI | CLI (Phase 1~3) → naia-shell 통합 (Phase 4+) |

---

## 6. Phase outline

| Phase | 기간 | 검증 |
|---|:---:|---|
| **Phase 1** (freeze 2026-04-21) | Week 1 (5일) | "hello 함수 추가" → 진행 보임 + diff + "test PASS" 보고 |
| Phase 2 (대부분 shipped) | Week 2~3 | ACP 정식 + Interrupt + Approval gate (`ApprovalBroker` / `CliApprovalBroker` / `AutoDenyApprovalBroker` 가 `bin/naia-agent.ts` 에 shipped; T2/T3 `GatedToolExecutor` wiring 은 아직 진행 중) |
| Phase 3 (부분 shipped) | Week 4~6 | claude SDK + sub-session card + naia-memory. `--memory` 플래그 + `LiteMemoryProvider` wiring SHIPPED (Slice 3-XR-C / 3-XR-G / 3-XR-I, 2026-05-20); supervisor 측에서 `MemoryProvider.recall()` 결과를 `TaskSpec.extraSystemPrompt` 로 auto-inject 하는 부분은 여전히 로드맵에 있음 |
| Phase 4 | Week 7~10 | Adversarial review + naia-shell 통합 + voice cascade (Slice 3-XR-Voice / P0c-2, 별도 세션에 deferred) |

**Phase 1 목표**: 사용자 피로 30~50% 감소. 안 되면 Path A (IDE 회귀) 또는 Path C (손으로 계속) 회귀, 노력 1주만 잃음.

---

## 6b. 보안 stance (Phase 별)

| Phase | path traversal | secret redact | approval gate | bash 위험 명령 |
|---|:---:|:---:|:---:|:---:|
| **Phase 1** | **CLI 미차단 (의도 미이행)** | ✓ adapter emit 시점 | ✗ skipPermissions | ✗ |
| Phase 2 | runtime BashSkill + workspace sentinel (D09) | ✓ | ✓ T2/T3 ApprovalBroker | ✓ DANGEROUS_COMMANDS regex (D01) |
| Phase 3+ | + 4-repo plan A.13 보안 lockstep | + | + | + |

**Phase 1 보안 가정** (사용자 trust model):
- naia-agent CLI 는 **사용자 본인이 직접 실행** (untrusted input source 없음)
- workdir 은 **사용자가 명시적으로 지정** — path traversal 책임 = 사용자
- sub-agent (opencode) 가 받은 prompt 도 **사용자 본인 작성** — prompt injection 위협 낮음
- 따라서 Phase 1 은 redact + workdir cwd 격리 + UnsupportedError throw 정도만 (functional review C1 결과 정합)

Phase 1 을 untrusted/multi-tenant 환경에서 사용 금지. Phase 2 부터 정식 보안 layer.

---

## 7. 변경 절차

R4 lock 이후 본 vision 변경 시:
1. 본 파일에 Change log 섹션
2. r4-hybrid-wrapper-2026-04-26.md 에 사유
3. 매트릭스 §D 새 결정 또는 §B 새 거부
4. master issue #2 댓글 + cross-review

§A 채택 항목은 변경 금지 (R0 lock 유지).
