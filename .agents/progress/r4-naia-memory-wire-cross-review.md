# R4 naia-memory wire — cross-review (2026-04-26)

> **session_id**: c03e4e41-9ef4-4809-9ec2-60329e3db5fa
> **trigger**: 사용자 directive — "연결방식 적당한지 다른AI와 리뷰"
> **status**: review 완료 + 적어만 둠 (사용자 directive: "리뷰는 적어만 둬, 알파메모리는 이후에")
> **action**: P0 모두 deferred (코드 변경 없음). UI 통합 우선.

---

## 1. 검토 대상

- `docs/naia-memory-wire.md` (방금 작성된 wire spec)
- `docs/memory-provider-audit.md` (이전 façade 감사)
- `packages/types/src/memory.ts` (MemoryProvider interface)
- `examples/naia-memory-host.ts` (LocalAdapter wire)
- `projects/alpha-memory/CLAUDE.md` (R5/R6 benchmark + known issues)

## 2. 결과 (3 perspective)

| Perspective | Verdict | P0 |
|---|---|:---:|
| **Architect** | APPROVED with 2 P0 | 2 |
| **Reference-driven** | APPROVED with 3 P0 | 3 |
| **Paranoid** | NEEDS_REVISION | 3 |
| **합계 P0 (deduped)** | | **8** |

## 3. P0 통합 8건

| # | 출처 | 항목 | 우선순위 |
|:---:|---|---|:---:|
| 1 | Paranoid | **KO 24% 성능 — luke 직접 영향** (alpha-memory#5 vector search + #9 KO threshold) | 🔴 critical |
| 2 | Paranoid | text-embedding-004 deprecated, 대체 provider 결정 | 🔴 critical |
| 3 | Paranoid | recall() latency 미측정 (R7 benchmark 추가) | 🟡 |
| 4 | Architect | Phase3Supervisor memory **optional** (graceful degradation) | 🟡 |
| 5 | Architect | Storage isolation (ADK_ROOT 강제 + LocalAdapter 기본값 변경) | 🟡 |
| 6 | Reference | Memory tier 정형화 (`RecallOpts.store: episodic\|semantic\|procedural`) | 🟡 |
| 7 | Reference | cache_control (D16) Phase 3 wire path 명시 | 🟢 |
| 8 | Reference | TaskSpec.extraSystemPrompt 토큰 예산 (truncation 정책) | 🟢 |

## 4. 책임 분리 (사용자 자신 작업 vs naia-agent)

| 영역 | 책임 | 우선순위 |
|---|---|---|
| #1, #2, #3 (alpha-memory 자체 성능/embedding/benchmark) | **사용자 본인** (성능 테스트 진행 중) | Phase 3 진입 전 |
| #4, #5, #6, #7, #8 (naia-agent wire spec + interface 보강) | naia-agent | UI 통합 후 |

## 5. 신규 §D 권고 (3건, 코드 X, 매트릭스만)

| ID | 패턴 | Phase |
|---|---|:---:|
| **D32a** (Reference) | Memory adapter fallback + quality SLA (LocalAdapter > Mem0 > null + accuracy threshold) | Phase 3 중기 |
| **D32b** (Reference) | Recall result token budgeting (extraSystemPrompt 토큰 예산 truncation) | Phase 3 중기 |
| **D43** (Architect+Paranoid) | ADK_ROOT 강제 + multi-instance isolation (default fallback warn/abort) | Phase 3 |

## 6. 잘못된 가정 발견 (Paranoid 검출)

- E1: LocalAdapter vector search O(topK) — 사실 BM25 keyword-only fallback (embeddingProvider 미주입)
- E2: consolidateNow() O(MAX_EPISODES) — 사실 O(facts × topK × facts) 폭발 가능
- E3: Phase 3 supervisor "자동 recall + inject" 구현됨 — 사실 interface만 정의, supervisor 미구현

## 7. 다음 단계 (사용자 directive — 2026-04-26)

### 즉시
- 본 review docs commit
- UI 통합 옵션 정리 (사용자 결정 권유)

### Deferred (alpha-memory 자체 성능 fix 후)
- P0 #1~#3: 사용자 본인 alpha-memory 작업
- P0 #4~#8: naia-agent wire spec + supervisor 구현 (UI 통합 후)

### Phase 3 진입 조건 (모두 ✓ 후 시작)
- alpha-memory KO 50%+ benchmark
- embedding provider 결정
- recall latency &lt; 200ms 검증
- naia-agent wire spec docs 보강 완료

## 8. 본 review 결과 commit 외 코드 변경 0건

사용자 directive ("리뷰는 적어만 둬") — 본 docs 외 코드/spec 변경 없음.

매트릭스 §D 갱신도 deferred (UI 통합 후 또는 사용자 결정 시점에).
