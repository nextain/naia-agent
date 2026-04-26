# R4 Week 0 — 2차 Cross-Review Summary (Phase 1 spec, 2026-04-26)

> **session_id**: c03e4e41-9ef4-4809-9ec2-60329e3db5fa
> **상위**: `r4-week0-cross-review-summary.md` (1차)
> **검토 대상**: `r4-phase-1-spec.md` (Phase 1 정량 spec)
> **review 형식**: 3-perspective parallel (architect / reference-driven / paranoid)
> **status**: 2차 review 완료, P0 8건 모두 docs 반영, **Phase 1 spec LOCK**

---

## 1. 결론

| Perspective | Verdict | 핵심 |
|---|---|---|
| **Architect** | APPROVED with CRITICAL REFINEMENT | P0 2건 (Day 5 분량 / linting setup) + P1 1건 (모듈 분할 재고) |
| **Reference-driven** | APPROVED | P0 3건 (ACP vs CLI trade-off / bash test 보존 / smoke:opencode) + P1 3건 + 신규 §D 3건 |
| **Paranoid** | APPROVED_WITH_CRITICAL_RISKS | P0 3건 (시간 buffer 수학 / opencode CLI 검증 / verification destructive) + 신규 가정 A6~A9 |

→ **종합: APPROVED + Phase 1 LOCK** — P0 8건 통합 후 모두 spec 반영 완료.

---

## 2. opencode CLI 결정적 spike (2026-04-26)

Paranoid P0-2 + Reference P0-1 통합 해결:

| 항목 | 결과 |
|---|---|
| `opencode-ai@1.14.25` install | ✓ 정상 |
| `opencode --version` | `1.14.25` |
| `opencode run [message..]` | ✓ **1-turn invocation 정식 지원** |
| `--format json` | ✓ **raw JSON events 출력** (NaiaStreamChunk 변환에 정확히 fit) |
| `--continue` / `--session <id>` | session 관리 가능 |
| `-m provider/model` | provider 명시 가능 |
| `opencode acp` (Phase 2) | ✓ 별도 ACP server mode 존재 |
| `--print-logs` | stderr 로그 (debug용) |

→ **Phase 1 = `opencode run --format json` 채택 정당화 + 매트릭스 D33 신설**

---

## 3. P0 8건 통합 표 (모두 반영 완료)

| # | 출처 | 항목 | 처리 위치 |
|:---:|---|---|---|
| 1 | Paranoid | 시간 buffer 정직 고지 (45% 실제, 1인 hidden cost 인정) | r4-phase-1-spec.md §3 — 정직 명시 + 비관 30% / 낙관 65% / proceed 정당화 |
| 2 | Paranoid | opencode CLI 호출 가능성 검증 (smoke 의무) | ✓ resolved (spike) + Day 2.0 obligatory smoke test |
| 3 | Paranoid | verification destructive isolation (git stash/pop + --no-verify) | r4-phase-1-spec.md Day 4.2 + Day 4.7 |
| 4 | Reference | smoke:opencode script 신설 | Day 2.5 + package.json |
| 5 | Architect | Day 5 분량 재분배 + StreamMerger interleave 정책 | Day 5.0 spike (interleave 정책 결정) + Day 5 5h target |
| 6 | Architect | tsconfig project references + eslint setup | Day 1.1 (5 신규 pkg 통합 setup) |
| 7 | Reference | bash/file-ops test 보존 경로 (dev-only marker) | Day 1 진행 중 + 매트릭스 D32 신설 (runtime/skills/README.md) |
| 8 | Reference | opencode ACP vs CLI trade-off 정량 근거 | r4-phase-1-spec.md 상단 spike 결과 + 매트릭스 D33 |

---

## 4. 신규 §D 4건 추가

| ID | 패턴 | Phase | P |
|---|---|:---:|:---:|
| **D30** | Verification 3중 방어 재근거화 (cleanroom 단독 의존 해제, OWASP/Mastra) | Phase 4 | P1 |
| **D31** | onSessionEnd hook 정형화 (D26 구체화) | Phase 2 | P1 |
| **D32** | bash/file-ops dev-only marker (R3 250 PASS test 보존 정책) | Phase 1 | **P0** |
| **D33** | opencode `run --format json` JSON event protocol | Phase 1 | **P0** |

---

## 5. 신규 가정 A6~A9 (Paranoid)

| # | 가정 | 처리 |
|:---:|---|---|
| A6 | opencode workdir 격리 실제 동작 미검증 | Day 2.5 unit test + path traversal fixture |
| A7 | chokidar 파일 간 race (5개 동시 write ordering) | Day 3.5 fixture 추가 명시 |
| A8 | opencode-ai 1.14.25 + ACP SDK 0.20.0 호환성 | Phase 2 spike 위임 (Phase 1은 CLI만, 무관) |
| A9 | Phase 1 → Phase 2 ACP 전환 시 코드 throw-away | spec에 "prototype mindset, code reuse 기대 X" 명시 |

---

## 6. P1 통합 (Phase 1 진행 중 monitoring)

- **Architect P1**: 모듈 분할 5개 신설 부담 — pre-commit hook으로 lint debt 예방 (Day 1.1 setup에 흡수)
- **Reference P1-1**: chokidar race fixture 구체 — Day 3.5 명시
- **Reference P1-2**: verification timeout 60s partial result — Day 4.4 명시
- **Reference P1-3**: anthropic.ts dev-only 강등 + any-llm endpoint 정책 — Day 5.1 (bin 정리)
- **Paranoid 신규**: chokidar race + workdir 격리 + opencode-ai SDK 호환성 + Phase 1 코드 throw-away — 위 A6~A9으로 흡수

---

## 7. Open Questions for User (사용자 자리 비움 — default 채택 선언)

| # | 질문 | default 채택 (사용자 별도 directive 없으면) |
|---|---|---|
| Q1 | StreamMerger interleave 정책 | (B) sessionId별 strict + 다른 세션 간 timestamp round-robin (Day 5.0 spike에서 fixture 작성) |
| Q2 | Phase 1 verification 자동 `pnpm test` 사이드 이펙트 허용? | yes (default) + `--no-verify` flag fallback |
| Q3 | 5일 confidence | 50% (낙관 65% / 비관 30%). proceed |
| Q4 | Phase 1 코드 Phase 2 throw-away 용인? | yes (prototype mindset) |
| Q5 | E2E 정확성 metric | "기존 test 미파괴 + 변경 사실 보고" (Phase 2+ assertion-level) |
| Q6 | 250 PASS 출처 (Reference Q1) | runtime 160 + protocol 73 + observability 17 = 250 (R3 마지막 commit 확인) |
| Q7 | extraSystemPrompt 정책 (Reference Q2) | Phase 1 = empty string (alpha-memory Phase 3) |
| Q8 | anthropic SDK 제거 일정 (Reference Q3) | Phase 2 (Phase 1 = dev-only 강등 + deprecation warning) |
| Q9 | naia-anyllm endpoint Phase 1 E2E LLM | E2E는 mock LLM (실제 API 미사용 — 사용자 환경 보호) |
| Q10 | Verification partial result (Reference Q5) | timeout 시 partial result emit + warning (Day 4.4) |

→ 모두 default 채택 가능. 사용자가 자리에 돌아온 후 다른 결정 시 수정.

---

## 8. R4 Week 0 종료 + Phase 1 ready

### 산출물

| docs | 상태 |
|---|---|
| `.agents/progress/r4-hybrid-wrapper-2026-04-26.md` | ✓ |
| `.agents/progress/r4-week0-cross-review-summary.md` (1차) | ✓ |
| `.agents/progress/r4-week0-cross-review-2nd-summary.md` (2차, 본 파일) | ✓ |
| `.agents/progress/r4-phase-1-spec.md` | ✓ LOCK |
| `docs/vision-statement.md` | ✓ LOCK |
| `docs/architecture-hybrid.md` | ✓ LOCK (P0 반영) |
| `docs/stream-protocol.md` | ✓ LOCK (P0 반영) |
| `docs/adapter-contract.md` | ✓ LOCK (P0 반영) |
| `.agents/progress/ref-adoption-matrix.md` | ✓ §D D18~D33 + §B23 + §J 갱신 |
| nextain/naia-agent#2 | ✓ R4 announce + Week 0 reviews 댓글 |

### Phase 1 시작 조건 (모두 ✓)

- [x] R4 Week 0 docs 5건 lock
- [x] cross-review 2회 통과 (1차 + 2차, P0 모두 반영)
- [x] 외부 의존 spike 모두 ✓ (opencode ACP / Claude SDK / opencode CLI / alpha-memory)
- [x] Phase 1 spec 정량화 + 50% buffer 정직 명시
- [x] fallback chain 5건 명시
- [x] master issue tracking
- [x] forbidden_actions (F01) 자동 해제 확인 (bin 존재)

### Day 1 시작은 사용자 confirmation 후

R4 Week 0 종료 = 코드 0 LOC. Day 1 코드 작성은 **사용자가 자리에 돌아온 후 명시적 confirmation 후** 시작 권고.

(사용자 directive: "단계별로 크로스 리뷰 받으며 끝까지 진행" — Week 0 단계 끝까지 진행 완료. Phase 1 코드 작업은 별도 단계로 사용자 결정 권고.)

---

## 9. 사용자가 자리에 돌아왔을 때 보고할 것

1. **결정 lock 완료**: Hybrid wrapper path B + opencode `run --format json` 채택 + ~1,500 LOC naia-agent thin layer
2. **Phase 1 spec 정량화**: 5일, 22.5h 작업 + 17.5h buffer (44%), confidence 50%
3. **외부 의존 모두 ✓**: opencode ACP/CLI / Claude SDK / any-llm / alpha-memory
4. **신규 §D 12건**: D18~D29 (1차) + D30~D33 (2차) — 매트릭스에 모두 추가
5. **fallback chain 5건**: opencode CLI fail / chokidar fail / vitest parse fail / pnpm test timeout / 전체 Phase 1 실패 시 IDE 회귀
6. **다음 step 권고**: Phase 1 Day 1 코드 작성 시작 (사용자 confirmation 후)
