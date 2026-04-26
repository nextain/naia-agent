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

## 7. 변경 절차

R4 lock 이후 본 vision 변경 시:
1. 본 파일에 Change log 섹션
2. r4-hybrid-wrapper-2026-04-26.md 에 사유
3. 매트릭스 §D 새 결정 또는 §B 새 거부
4. master issue #2 댓글 + cross-review

§A 채택 항목은 변경 금지 (R0 lock 유지).
