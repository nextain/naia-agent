# R4 Week 0 — Cross-Review Summary (2026-04-26)

> **session_id**: c03e4e41-9ef4-4809-9ec2-60329e3db5fa
> **상위**: `r4-hybrid-wrapper-2026-04-26.md`
> **review 형식**: 3-perspective parallel (architect / reference-driven / paranoid)
> **status**: 1차 review 완료, P0 반영 진행 중

---

## 1. 결론

| Perspective | Verdict |
|---|---|
| **Architect** | APPROVED with CRITICAL CONDITIONS (P0 3건) |
| **Reference-driven** | APPROVED with P0 3건 + P1 5건 + 신규 §D 5건 |
| **Paranoid auditor** | APPROVED_WITH_RISKS (P0 5건 — 외부 의존 검증 + 보안) |

→ **종합: APPROVED, P0 11건 반영 후 Phase 1 lock**

---

## 2. P0 통합 표 (11건)

| # | 출처 | 항목 | 처리 |
|:---:|---|---|---|
| 1 | Paranoid | opencode ACP 실제 지원 검증 (15min spike) | ✓ **resolved** — `@agentclientprotocol/sdk@0.20.0`, opencode `packages/opencode/src/acp/` (agent.ts/session.ts/types.ts/server.ts), protocol v1, JSON-RPC over stdio 정식 구현 확인 |
| 2 | Paranoid | Claude Agent SDK public availability | ✓ **resolved** — `@anthropic-ai/claude-agent-sdk@0.2.119` npm public 확인 |
| 3 | Paranoid | Phase 1 success criterion 정량화 (UI 없음 명시 + 단계 시간) | → `r4-phase-1-spec.md` 신설로 처리 |
| 4 | Reference + Architect | SpawnContext에 Tool context schema 추가 (sessionId/workingDir/ask/tier) | → `adapter-contract.md` §2 수정 |
| 5 | Architect | Adapter unsupported methods matrix (opencode/claude-code/shell × pause/inject/health) | → `adapter-contract.md` 신규 표 |
| 6 | Paranoid | Secret redact mandatory wrapper 명시 (event 변환 시점) | → `adapter-contract.md` §8 보강 + observability 의존 표시 |
| 7 | Paranoid | Interrupt deadline 500ms hard kill 강제 | → `architecture-hybrid.md` §6 + `adapter-contract.md` contract test C12 |
| 8 | Architect | SessionPhase enum 정의 | → `stream-protocol.md` §2 type alias 추가 |
| 9 | Architect | Core 내부 module DAG (supervisor/conversation/interrupt/stream-merger 의존) | → `architecture-hybrid.md` §5 명시 |
| 10 | Reference | Verification 3중 방어 (abort + memory limit + timeout) | → `architecture-hybrid.md` §6 추가 |
| 11 | Reference | onSessionEnd callback hook (Vercel onStepFinish 패턴) | → `stream-protocol.md` 신규 chunk + supervisor 책임 |

---

## 3. P1 통합 표 (Phase 1 시작 전 권장, 11건)

| # | 출처 | 항목 | Phase 시점 |
|:---:|---|---|---|
| P1-1 | Architect | WorkspaceWatcher debounce 100ms 의미 (multiple changes → 1 chunk) 명시 | Phase 1 시작 전 |
| P1-2 | Architect | Verifier timeout config + Phase 1 fast test 보장 | Phase 1 시작 전 |
| P1-3 | Architect | any-llm vs vllm-omni provider routing 정책 | Phase 4 진입 시 |
| P1-4 | Reference | Memory 3-tier blueprint (D15 구체화) | Phase 3 |
| P1-5 | Reference | Claude SDK pause/resume 실제 동작 spike | Phase 2 |
| P1-6 | Reference | viseme vocabulary spec (D03 AEIOU) | Phase 4 X7 |
| P1-7 | Reference | Sub-agent isolation (multi-session state) | Phase 3 |
| P1-8 | Reference | Prompt cache opinionated 정책 (D16) | Phase 2 |
| P1-9 | Paranoid | chokidar race condition test (rapid sequential write) | Phase 1 시작 전 (test fixture) |
| P1-10 | Paranoid | git diff stash/rebase 처리 | Phase 1 (test fixture) |
| P1-11 | Paranoid | Test flakiness — stable test only 명시 + verification 의미 ("미파괴" 수준) | Phase 1 spec docs |

---

## 4. P2 (Phase 진행 중 monitoring)

- Architect P2-1~3 (test pyramid 우선순위 / D09 contract test C11 / sub-agent error taxonomy)
- Reference P2-1~2 (Eval scorers Phase 5+ / Vercel provider fallback C04 재검토)
- Paranoid P2-1~4 (sessionId 일관성 / union exhaustiveness drift / audio chunk size 64KiB / approval gate bypass)

→ Phase별 issue로 트래킹.

---

## 5. 잘못된 가정 발견 (Paranoid)

| # | 가정 | 현실 | 대응 |
|---|---|---|---|
| A1 | "1주 5일 가능" | 정확한 작업 시간은 4~6h 추정, 그러나 emergency 1건 터지면 1주 다 씀 | Phase 1 spec에 "여유 ≥ 50%" 명시 |
| A2 | "opencode ACP production-ready" | ✓ resolved (acp/ 정식 구현) | — |
| A3 | "2,150 LOC 1~2개월 가능" | 외부 의존 4개 breaking 가능성 | 외부 의존 추적 process docs |
| A4 | "alpha-memory adapter trivial 100 LOC" | 실제 복잡도 미검증 (Phase 3 spike 필요) | Phase 3 진입 시 spike 명시 |
| A5 | "Hybrid LOC 감소 = 유지보수 향상" | 외부 의존 4개 추적 부담 증가 (반대 방향) | 외부 의존 monitoring docs (Phase 진행 중) |

---

## 6. 신규 §D 추가 (Reference 권고)

R4 §D 7건 (D18~D24) + cross-review에서 추가 5건:

| ID | 패턴 | 출처 | Phase | P |
|---|---|---|:---:|:---:|
| **D25** | Tool context schema 정형화 (sessionId/workingDir/ask/tier) | opencode + Vercel | Phase 1 | P0 |
| **D26** | onSessionEnd callback hook (supervisor report 전 aggregate) | Mastra + Vercel (D12 보강) | Phase 2 | P0 |
| **D27** | Verification 3중 방어 (abort + memory limit + timeout) | Mastra D13 | Phase 1 | P0 |
| **D28** | Memory 3-tier blueprint (D15 구체화 — history/working/observational) | Mastra | Phase 3 | P1 |
| **D29** | viseme vocabulary spec (AEIOU + lipsync 알고리즘) | project-airi D03 | Phase 4 X7 | P1 |

---

## 7. Open Questions for User (12건 → 6건 핵심)

cross-review에서 사용자 결정이 필요한 핵심:

| # | 질문 | 권고 default (사용자 별도 directive 없으면 채택) |
|---|---|---|
| Q1 | Module size enforcement (≤ 300 LOC) 엄격? | **soft 권고** — "1인이 한 번에 이해 가능" 정도로 완화 (코드 리뷰 시 판단) |
| Q2 | Sub-agent error taxonomy (failed/timeout/network 분류) | **adapter contract에 enum 명시** (failed=exit≠0, timeout=signal abort, network=ACP disconnect) |
| Q3 | Claude SDK adapter spike timing | **Phase 2 진입 시** (Phase 1은 opencode + shell만) |
| Q4 | Verifier timeout default | **Phase 1 = 60s** (fast test 강제), Phase 2+ = runner별 5분 default + override |
| Q5 | Phase 1 fallback (ACP 안 되면 shell only?) | ✓ resolved — ACP 확인됨, fallback 불필요 |
| Q6 | any-llm SLA / 자체 fork 유지보수 | **Phase 1은 사용자 본인 naia 계정 가용성에 의존**. Phase 3+ availability monitoring 추가 |

→ 모두 default 채택 가능. 사용자 별도 결정 없이 진행.

---

## 8. P0 반영 docs 변경 list

| docs | 수정 항목 |
|---|---|
| `docs/stream-protocol.md` | (P0-8) SessionPhase enum / (P0-11) onSessionEnd chunk 추가 |
| `docs/architecture-hybrid.md` | (P0-9) core 내부 DAG / (P0-10) verification 3중 방어 / (P0-7) interrupt deadline |
| `docs/adapter-contract.md` | (P0-4) SpawnContext Tool context / (P0-5) unsupported matrix / (P0-6) redact mandatory / (P0-7) C12 contract test |
| `.agents/progress/ref-adoption-matrix.md` | §D D25~D29 추가 |
| `.agents/progress/r4-phase-1-spec.md` | (신설) Phase 1 정량 spec (P0-3 처리) |

---

## 9. 다음 단계

1. P0 11건 반영 (위 docs 4개 + 매트릭스 + Phase 1 spec)
2. 2차 cross-review (Phase 1 spec 검토만 — P0-3 외 새 P0 발생 가능성 점검)
3. 매트릭스 §D D25~D29 lock + master issue update
4. R4 Week 0 close → Phase 1 ready

source 보고서 링크:
- Architect: 별도 transcript (49s 검토)
- Reference-driven: 별도 transcript (45s 검토)
- Paranoid: 별도 transcript (74s 검토)
