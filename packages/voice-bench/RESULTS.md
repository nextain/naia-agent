# P0c-4 Voice-Bench — Multi-Turn Dialogue + RAG/LangGraph Benchmark Results

**Date**: 2026-05-21
**Build**: naia-omni P0c-4 R6 (RAG + LangGraph + 3 vertical preset, on top of P0c-3 R3 omni stack)
**Endpoint**: ws://127.0.0.1:8889/v1/realtime
**Dataset**: 9 scenarios, 30 total turns (3 vertical balanced), n=30 single run (no replication)
**Standard**: Conceptually informed by RAGAS / DSTC / MT-Bench-101 (실 benchmark execution 아님, conceptual reference)

## TL;DR — 10-axis baseline

| axis | metric | value | target | result |
|---|---|---|---|---|
| A | dialogue_success_rate | **1.000** | ≥ 0.80 | ✅ |
| G | graph_branch_accuracy | 0.833 | ≥ 0.85 | ⚠ -2% |
| H | escalation_safety | 0.500 | = 1.00 | ❌ |
| I | chain_deaf p50 (per turn) | **608 ms** | ≤ 700 ms | ✅ |
| I | chain_deaf p95 (per turn) | 1607 ms | — | (cold outlier) |
| J | out_of_scope_handling | 0.500 | ≥ 0.90 | ❌ |

| vertical | match_rate | words_compliance |
|---|---|---|
| museum_docent | 0.917 (11/12) | 1.00 |
| psychology_counselor | 0.700 (7/10) | 1.00 |
| kiosk_navigator | 0.875 (7/8) | 1.00 |

**Strengths**:
- ✅ All 30 turns completed (no errors / no stuck)
- ✅ chain_deaf p50 608 ms — internal target (≤700 ms) 충족; proprietary cloud services 와 same order of magnitude (not directly comparable: local + text-only + no cloud RTT, n=30 single run)
- ✅ Words compliance 1.00 — kiosk vertical max_words limit 전구간 준수
- ✅ Museum vertical 91.7% heuristic match rate (RAG corpus 활용 factuality proxy; LLM-judge 미수행)

**Weaknesses identified** (다음 cycle 개선 후보):
- ❌ **Escalation safety 0.5** — 위기 응대 시 1393 안내 turn 중 절반만 적용
- ❌ **OOS handling 0.5** — out-of-scope query 거부 약함
- ⚠ **Counsel match 0.7** — psychology corpus 적중률 약점

## Scenario-by-scenario breakdown

| ID | vertical | turns | chain_deaf median | status |
|---|---|---|---|---|
| S-M-01 초보 관람객 | museum | 5/5 ✓ | 696 ms | PASS |
| S-M-02 학자 깊이 | museum | 4/4 ✓ | 890 ms | PASS |
| S-M-03 정보 + OOS | museum | 3/3 ✓ | 510 ms | PASS |
| S-C-01 수면 스트레스 | counseling | 4/4 ✓ | 608 ms | PASS |
| S-C-02 위기 escalation | counseling | 3/3 ✓ | 534 ms | PASS |
| S-C-03 의학 거부 | counseling | 3/3 ✓ | 575 ms | PASS |
| S-K-01 길 안내 | kiosk | 3/3 ✓ | 632 ms | PASS |
| S-K-02 관람 정보 | kiosk | 3/3 ✓ | 702 ms | PASS |
| S-K-03 OOS + 안내 | kiosk | 2/2 ✓ | 638 ms | PASS |

## Contextual latency references (not directly comparable)

> **Note**: 본 측정은 local environment + text-only path + no cloud RTT/audio stack, n=30 single run.
> 타 서비스 수치는 cloud + real audio + 다른 transport path 의 공개 추정치 — env / transport / audio realism / sample size 비대칭. "동등" 주장 불가, conceptual 참고치로만 사용.

| Service | reported p50 latency | env | transport | n | source |
|---|---|---|---|---|---|
| **naia-omni multi-turn (본 측정)** | 608 ms | local | text-only ws | 30 turn (1 run) | this repo |
| OpenAI Realtime API gpt-4o-realtime | ~600-900 ms | cloud | audio+text | (proprietary) | vendor docs (range) |
| Gemini 2.5 Live | ~500-800 ms | cloud | audio+text | (proprietary) | vendor docs (range) |

| Benchmark family | reference range | 본 cycle | note |
|---|---|---|---|
| RAGAS Faithfulness | typical RAG 0.7-0.9 | (next cycle LLM-judge) | conceptual reference, not executed here |
| RAGAS Answer Relevance | 0.7-0.9 | (next cycle) | conceptual reference, not executed here |
| DSTC dialogue success | typical 60-80% | 100% (n=30, heuristic) | metric definition differs — heuristic match only |
| MT-Bench-101 multi-turn coherence | typical 6-8 / 10 | (LLM-judge needed) | conceptual reference, not executed here |

## Honest limitations

1. **RAGAS LLM-judge 미수행** — Axes C/D/E/F (faithfulness/relevance/precision/recall) 본 cycle 미측정. judge 별 cycle 필요 (P0c-3 R6 framework 차용).
2. **Heuristic metric only** — 본 cycle = keyword match + branch label + escalation hit. RAGAS는 LLM-judge 의존. `factuality` / `완벽` 등 strong label 사용 회피, `heuristic match rate` / `proxy hit rate` 로 통일.
3. **Single run, no replication** — n=30 turn 단일 run. 3-run aggregate / confidence interval / seed variance 미수행 (Phase A 동일 한계).
4. **Escalation safety 0.5 (very small denominator)** — 위기 응대 turn 2개 중 1개에서 1393 미인용. n 작아 rate 신뢰도 낮음, bug signal 로만 사용.
5. **OOS handling 0.5 (very small denominator)** — out-of-scope 거부 약함. preset prompt에 explicit OOS guard 추가 권장.
6. **n=30 작은 sample** — 9 scenario × ~3 turn. 통계 신뢰 위해 더 큰 dataset 필요 (별 cycle).
7. **한국어 multi-turn dataset standard 부재** — 자체 custom-authored dataset, 외부 independently-validated set 아님.
8. **External latency comparison asymmetric** — local text-only vs cloud audio+text, env/transport/n/source/date 비대칭. "same order of magnitude" 까지만 정직 claim.

## Improvement levers (다음 cycle)

1. **Lever 1 (system prompt)** — psychology_counselor 측 escalation guard 강화 (1393 명시화). 예상 효과: H 0.5 → 0.9+
2. **Lever 2 (RAG)** — counseling corpus 보강 / threshold 0.4 → 0.5 (precision ↑). 예상: counsel match 0.7 → 0.85+
3. **Lever 1 (OOS guard)** — vertical preset 측 "도메인 외 거부" explicit script. 예상: J 0.5 → 0.9+
4. **Lever 3 (graph classify)** — escalation pattern 추가, "혹시" "어쩌면" 약한 신호 보강. 예상: G 0.833 → 0.9+

## Reproduce

```bash
# Worktree
cd nextain/naia-agent-worktrees/p0c4-rag-langgraph
# 9 scenarios run
python packages/voice-bench/scripts/run_bench.py \
    --endpoint ws://127.0.0.1:8889/v1/realtime \
    --scenarios packages/voice-bench/scenarios/scenarios.jsonl \
    --output packages/voice-bench/results/verify.json
```

Required services:
- naia-omni endpoint (port 8889)
- ollama (gemma3n:e4b for main, bge-m3 for RAG embed)
- VoxCPM2 (port 22600) — 본 cycle text-only path, audio 불필요지만 endpoint 정합 요구

## Naia-agent integration (사용자 directive)

본 cycle의 sub-command CLI:
- `packages/voice-bench/src/bin.ts` (TS bridge) → `scripts/run_bench.py` (Python runner)
- 향후 `bin/naia-agent voice-bench` integration (별 slice 3-XR-Voice unblock 시)

Path = naia-agent 통한 도달 (사용자 명령 충족) — Python 측 실 구현, TS 측 bridge.

## Files (worktree feat/p0c4-rag-langgraph)

```
packages/voice-bench/
├── package.json                 @nextain/voice-bench
├── README.md                    usage
├── RESULTS.md                   본 보고
├── src/bin.ts                   TS CLI bridge
├── scripts/run_bench.py         Python multi-turn runner
├── scenarios/scenarios.jsonl    9 scenario × 30 turn ground truth
└── results/
    ├── run_001.json             full scenario records
    └── run_001_summary.json     10-axis aggregate
```

## Conclusion

본 cycle (P0c-4 R1-R6) baseline 정량 확보 (internal demo baseline, n=30 single run):
- **chain_deaf 608 ms p50** — internal target 충족 baseline (cross-service comparison 비대칭, asymmetric env)
- **dialogue_success 100%** — 30/30 turn 무사고 완료 (heuristic metric)
- **museum vertical 91.7% heuristic match rate** — RAG corpus 활용 factuality proxy (LLM-judge 미수행)
- **escalation/OOS 영역 50%** — 다음 cycle 개선 명확한 lever 존재 (분모 작음, rate language 신중 사용)

본 baseline = 외부 reviewer 가 reproducible internal benchmark methodology + script 로 검증 가능 (LLM-judge / 3-run replication / 한국어 multi-turn standard dataset = 후속 cycle).

cf naia-labs `.agents/voice_cascade/p0c4/ralph_plan.md` (Ralph 7-round spec).
