# naia-agent vision statement (R4 lock 2026-04-26)

> **One-liner**: "Real-time interruptible multi-agent supervisor with multi-modal stream + 정직 보고."

---

## 1. What naia-agent is

사용자 (luke) 의 **AI 비서 + 작업 운영자**. 단일 대화창 안에서 사용자가 명령하고, naia-agent가 다중 sub-agent를 운영해 실제 작업을 수행하며, **수치 기반 정직 보고**로 신뢰를 유지한다.

핵심 use case (R4 motivation):

| # | 사용자 niddy | naia-agent의 답 |
|---|---|---|
| 1 | 여러 터미널 + 여러 AI agent 병렬은 피곤 | 단일 대화창에 통합 |
| 2 | 자꾸 놓침 (인지 부담) | naia-agent가 sub-session 운영 + 통합 보고 |
| 3 | 보고 ≠ 실제 (큰 낭패) | 자동 verification (test/lint/build) + 수치 diff stats |
| 4 | 잘못되면 즉시 멈춤 | "중지중지" 음성 / Ctrl+C / 카드 [중지] |
| 5 | workspace 변경 즉시 확인 | file watcher + diff preview |
| 6 | sub-session 활동 파악 | ACP/SDK event stream 카드 view |

---

## 2. What naia-agent is NOT

| ✗ NOT | 위임 또는 위 layer |
|---|---|
| 자체 coding tool 본체 (bash/file/git/refactor) | opencode / claude-code (sub-agent) |
| 자체 LLM provider 50+ | any-llm 원격 gateway |
| 자체 음성/avatar/UI | naia-shell (별도 repo) |
| 자체 long-term memory | alpha-memory (별도 repo) |
| 자체 skill 카탈로그 | naia-adk (별도 repo) |
| IDE / file editor / 자체 git impl | 사용자 기존 IDE 사용 |
| Agent framework for 외부 사용자 | 1인(luke) 전용으로 시작 |

---

## 3. 차별화 (3차원, 다른 framework에 거의 없음)

| 차원 | naia-agent | claude-code / opencode / Mastra / Vercel AI SDK |
|---|:---:|:---:|
| **Multi-modal stream** (audio_delta 1급) | ★★★ | text only |
| **Sub-agent supervisor** (ACP/SDK + audit + interrupt) | ★★★ | standalone (supervisor가 아닌 supervisee) |
| **단일 대화 + 정직 보고** (verification + diff + 수치) | ★★★ | 보고 ≠ 실제 (hallucination 문제 그대로) |

→ **omni-voice 시대 + multi-agent 운영 시대의 supervisor runtime**.

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
| ★★ | 연속 context (alpha-memory) | "연속적으로 일을 시키는" |
| ★★ | Multi-modal stream protocol (audio/image forward) | omni-voice |
| ★★ | Interface 정의 (SubAgentAdapter / Verifier / WorkspaceWatcher / LLMClient / MemoryProvider / SkillLoader) | DI |

---

## 4b. Naia (engine) vs alpha (persona instance)

| layer | 이름 | 정의 |
|---|---|---|
| **runtime engine** (이 repo) | **Naia** | generic, 페르소나 없음. default CLI label "[Naia]" |
| **persona instance** | **alpha** | luke 개인용 AI = naia-adk(skill+convention) + alpha-memory(user context) 결합 |

**원칙**: naia-agent는 페르소나를 가지지 않는다. "alpha"는 인스턴스 이름이며, 다음 두 layer가 정의한다:

1. **naia-adk** — naia 인스턴스의 **스킬 + 프로세스 + 기본 컨텍스트 (페르소나)**
   - skill 표준 + skill 카탈로그
   - 워크플로우 프로세스 (예: 검토 → 결정 → 실행 패턴)
   - 페르소나 system prompt 컨벤션 (캐릭터, 한국어 default, 비서 role, 대화 스타일)
   - 모두 정적 (사용자 무관, 인스턴스 정의)
2. **alpha-memory** — 사용자별 long-term **기억** (동적)
   - 이전 대화 history
   - 사용자 선호 / 메타데이터
   - 작업 history / task 컨텍스트

### 페르소나 위치 trade-off (디자인 결정 기록)

**의미론적 정당성**: 페르소나(personality, identity)는 "그 사람을 그 사람이게 하는 기억"의 일부 → 본질적으로 alpha-memory에 속하는 게 자연스러움.

**현실 (기존 시스템 호환)**: 그러나 Claude / opencode / Vercel AI SDK 등 모든 기존 agent 시스템은 페르소나를 **system prompt** (정적 spec) 으로 inject한다. naia-agent도 sub-agent로 그들을 wrap하므로, 페르소나는 **system prompt 컨벤션 영역 = naia-adk**가 가지는 게 현실적이고 호환됨.

**결정**: naia-adk가 페르소나 (정적 base) + alpha-memory가 사용자 컨텍스트 (동적). 두 layer가 합쳐져 "alpha" 인스턴스를 정의.

→ Phase 3에서 두 layer 동시 inject 메커니즘 정식화: `TaskSpec.extraSystemPrompt = naia-adk persona base + alpha-memory.recall() result`

### 4-repo 책임 분리 LOCK (2026-04-26 사용자 directive)

| repo | 책임 |
|---|---|
| **naia-os** (host) | host OS 전체 — UI + Avatar + audio device IO (mic/speaker via Tauri Rust cpal) + channel adapters + OS-specific skills (Device/Voicewake/Panel/Channels) |
| **naia-agent** (engine) | LLM core + **audio stream orchestration** (Vercel AI SDK 패턴 — STT/TTS provider abstraction + omni audio_delta stream, D43) + supervisor + sub-agent |
| **naia-adk** | skill **spec/interface only** + 9 generic skills 카탈로그 (Cron/Memo/Time/Weather/Notify/Diagnostics/Sessions/Skill-manager/Config/SystemStatus). 실행은 naia-agent |
| **naia-memory** (= alpha-memory pkg) | memory engine (encode/recall/decay/etc) |

### omni model 호환 (D43 — Vercel AI SDK 패턴)

```
[mic PCM in (naia-os device)]
  ↓ (audio_delta upstream via IPC)
naia-agent audio provider layer:
  ├─ omni model (vllm-omni / GPT-4o realtime / Gemini Live):
  │   audio_delta in → omni LLM → audio_delta out (직접)
  └─ 비-omni model:
      audio_delta in → STT provider → text → LLM → TTS provider → audio_delta out
  ↓ (audio_delta downstream via IPC)
[speaker PCM out (naia-os device) + Avatar lip-sync (naia-os UI)]
```

**naia-os = thin device IO + UI / naia-agent = audio orchestration**.

이 분리 → vllm-omni / GPT-4o realtime 같은 end-to-end 음성 모델 자연 통합 (STT/TTS 분리 layer 강제 X).

### naia-* / alpha-* prefix 체계 (이름 일관성)

**모든 engine 모듈은 `naia-` prefix** (사용자 directive 2026-04-26 결정 — alpha-memory → naia-memory rename):

| prefix | 의미 | 예 |
|---|---|---|
| **naia-** | generic engine 모듈 (모두에게 동일, npm `@nextain/`) | naia-agent / naia-adk / **naia-memory** / naia-os / naia-shell |
| **(개인 prefix)** | **사용자 인스턴스** workspace (host repo) | **alpha-adk** (luke의 host repo, 페르소나 = "alpha") / `bob-adk` (bob의 host) 등 |

따라서:
- **alpha** = luke의 AI **페르소나/인스턴스 이름**
- **alpha-adk** = luke workspace root (이 repo, host) — alpha 인스턴스의 모든 데이터 보관
- **naia-memory** = generic memory 엔진 (npm pkg `@nextain/naia-memory`)

### alpha 인스턴스 백업 시나리오 (사용자 directive)

**`alpha-adk` 디렉터리만 백업하면 alpha 인스턴스 완전 복원**:

```
alpha-adk/                            # ← 이걸 backup하면 alpha 전체 복원
├── data/                             # 인스턴스 데이터 (naia-adk 컨벤션)
│   ├── memory/                       # ← naia-memory가 여기 저장 (사용자 기억)
│   ├── skills/                       # ← 사용자 추가 skill 정의
│   └── persona/                      # ← 페르소나 override (한국어 톤, 호칭 등)
├── projects/                         # ← submodule pointers
│   ├── naia-agent/                   # generic engine
│   ├── naia-adk/                     # generic skill+process+persona convention
│   ├── alpha-memory/ → naia-memory   # generic memory engine (디렉터리명 alpha-memory 유지, pkg name `@nextain/naia-memory`)
│   └── naia-os/                      # generic host shell
├── .agents/                          # workspace context/rules
└── ... (기타 user 영역)
```

→ `git push alpha-adk origin main` (또는 tar backup) = alpha의 **skill + context + 기억 모두 보존**.
→ engine module들 (naia-agent / naia-memory 등) 은 generic이라 어디서든 받아 결합.

### naia-adk가 정의하는 memory storage path 컨벤션 (Phase 3 정식화)

```
${ADK_ROOT}/data/memory/        # naia-adk 컨벤션 (relative)
```

`alpha-adk`가 host로 동작 시:
- `ADK_ROOT=/var/home/luke/alpha-adk` (또는 env에서)
- `naia-memory`가 `/var/home/luke/alpha-adk/data/memory/` 에 SQLite/vector store 저장
- alpha-adk repo backup = memory data 자동 포함

다른 사용자 (`bob-adk`):
- `ADK_ROOT=/path/to/bob-adk` → `bob-adk/data/memory/` 에 저장
- 동일 `naia-memory` engine으로 격리된 데이터.

이 컨벤션은 Phase 3 alpha-memory(현 naia-memory) 통합 시점에 정식 wire.

naia-agent는 두 layer를 **inject할 hook만 제공**:

| hook | 시점 | Phase |
|---|---|---|
| `NAIA_PERSONA_LABEL` env | CLI 출력 label override (예: "Naia" → "alpha") | **Phase 2 (현재)** |
| `TaskSpec.extraSystemPrompt` | sub-agent system prompt에 페르소나/memory 주입 | Phase 3 (alpha-memory 통합 시) |
| `MemoryProvider.recall()` | 대화 시작 시 사용자 컨텍스트 가져옴 → extraSystemPrompt | Phase 3 |

**alpha-adk (이 workspace) host 가 inject 예시** (Phase 3):
```bash
export NAIA_PERSONA_LABEL=alpha
# alpha-adk가 naia-adk에서 페르소나 spec 로드 + alpha-memory.recall() 결과 결합 →
# TaskSpec.extraSystemPrompt 채워서 naia-agent 호출
pnpm naia-agent "..."
```

→ 동일 naia-agent 엔진으로 다양한 페르소나 인스턴스 (alpha / 다른 사용자용 / public Naia 등) 생성 가능. naia-agent는 "**페르소나 hosting platform**"이지 페르소나 자체가 아님.

---

## 5. lock된 결정 요약 (R4)

| | 결정 |
|---|---|
| Path | Hybrid wrapper (B) — 자체 ~2,150 LOC + 외부 wrap |
| LLM | any-llm 원격 gateway main, vllm-omni omni audio, Vercel AI SDK 보류 |
| Sub-agent | opencode (ACP) + claude-code SDK + 단순 stdio fallback |
| Memory | alpha-memory peer dep |
| Skill | naia-adk peer dep (향후) |
| UI | CLI (Phase 1~3) → naia-shell 통합 (Phase 4+) |

---

## 6. Phase outline

| Phase | 기간 | 검증 |
|---|:---:|---|
| **Phase 1** | Week 1 (5일) | "hello 함수 추가" → 진행 보임 + diff + "test PASS" 보고 |
| Phase 2 | Week 2~3 | ACP 정식 + Interrupt + Approval gate |
| Phase 3 | Week 4~6 | claude SDK + sub-session card + alpha-memory |
| Phase 4 | Week 7~10 | Adversarial review + naia-shell 통합 + vllm-omni |

**Phase 1 목표**: 사용자 피로 30~50% 감소. 안 되면 Path A(IDE 회귀) 또는 Path C(손으로 계속) 회귀, 노력 1주만 잃음.

---

## 6b. 보안 stance (Phase별)

| Phase | path traversal | secret redact | approval gate | bash 위험 명령 |
|---|:---:|:---:|:---:|:---:|
| **Phase 1** | **CLI 미차단 (의도 미이행)** | ✓ adapter emit 시점 | ✗ skipPermissions | ✗ |
| Phase 2 | runtime BashSkill + workspace sentinel (D09) | ✓ | ✓ T2/T3 ApprovalBroker | ✓ DANGEROUS_COMMANDS regex (D01) |
| Phase 3+ | + 4-repo plan A.13 보안 lockstep | + | + | + |

**Phase 1 보안 가정** (사용자 trust model):
- naia-agent CLI는 **사용자 본인이 직접 실행** (untrusted input source 없음)
- workdir은 **사용자가 명시적으로 지정** — path traversal 책임 = 사용자
- sub-agent (opencode)가 받은 prompt도 **사용자 본인 작성** — prompt injection 위협 낮음
- 따라서 Phase 1은 redact + workdir cwd 격리 + UnsupportedError throw 정도만 (functional review C1 결과 정합)

Phase 1을 untrusted/multi-tenant 환경에서 사용 금지. Phase 2부터 정식 보안 layer.

---

## 7. 변경 절차

R4 lock 이후 본 vision 변경 시:
1. 본 파일에 Change log 섹션
2. r4-hybrid-wrapper-2026-04-26.md 에 사유
3. 매트릭스 §D 새 결정 또는 §B 새 거부
4. master issue #2 댓글 + cross-review

§A 채택 항목은 변경 금지 (R0 lock 유지).
