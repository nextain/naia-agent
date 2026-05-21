# @nextain/voice-bench

naia-agent multi-turn dialogue benchmark — RAG + LangGraph + 상황 시나리오 기반.

**External reference align**: RAGAS (Faithfulness/AnswerRelevance/ContextPrecision/ContextRecall) + DSTC dialogue success + MT-Bench-101 multi-turn coherence.

## Run

```bash
# TypeScript CLI (bridge → Python runner)
pnpm --filter @nextain/voice-bench bench -- \
  --endpoint wss://pc-bazzite.tail4f7a25.ts.net:9443/v1/realtime \
  --scenarios scenarios/scenarios.jsonl \
  --output results/run_001.json

# Python 직접
python3 packages/voice-bench/scripts/run_bench.py \
  --endpoint ws://127.0.0.1:8889/v1/realtime \
  --scenarios packages/voice-bench/scenarios/scenarios.jsonl \
  --output packages/voice-bench/results/run_001.json
```

## Metrics (10 axes)

| axis | metric | target |
|---|---|---|
| A | dialogue_success_rate | ≥ 0.80 |
| B | context_retention (LLM-judge 0-5) | ≥ 4.0 |
| C | rag_faithfulness | ≥ 0.85 |
| D | rag_answer_relevance | ≥ 0.80 |
| E | rag_context_precision | ≥ 0.70 |
| F | rag_context_recall | ≥ 0.80 |
| G | graph_branch_accuracy | ≥ 0.85 |
| H | escalation_safety | = 1.0 |
| I | per_turn_latency (chain_deaf p50) | ≤ 700 ms |
| J | out_of_scope_handling | ≥ 0.90 |

Reference: `naia-labs/.agents/voice_cascade/p0c4/ralph_plan.md`
