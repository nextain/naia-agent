#!/usr/bin/env python3
"""
R8.2d — LongMemEval-S → our Fixture format adapter (subset).

Source: /tmp/hf-cache/.../longmemeval_s_cleaned.json (500 items, 264 MB)

We pick 12 items (2 per question type) to keep measurement tractable.
Each LongMemEval item has ~550 turns over ~53 sessions; we keep the full
haystack so LLM compaction is actually stressed.

Output: packages/benchmarks/src/fixtures/F-LME-s-*.fixture.json
"""
import json
import os
import random

random.seed(42)
SOURCE = "/tmp/hf-cache/datasets--xiaowu0162--longmemeval-cleaned/snapshots/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json"
OUT_DIR = "/var/home/luke/alpha-adk/projects/naia-agent-worktrees/slice-compact-v2/packages/benchmarks/src/fixtures"

# 2 items per question_type → 12 fixtures total.
PER_TYPE = 2


def adapt(item: dict) -> dict:
    qid = item["question_id"]
    qtype = item["question_type"]
    sessions = item["haystack_sessions"]
    question = item["question"]
    answer = item["answer"]

    turns: list[dict] = []
    fact_turns: list[int] = []
    for sess_idx, session in enumerate(sessions):
        if sess_idx > 0:
            turns.append({"role": "system", "content": f"[Session {sess_idx + 1} starts]"})
        for turn in session:
            role = turn["role"]
            if role not in ("user", "assistant", "system", "tool"):
                role = "user"
            content = turn["content"]
            turns.append({"role": role, "content": content})
            if turn.get("has_answer"):
                fact_turns.append(len(turns))

    # mid-point compaction so the answer is genuinely behind the cut
    # for most LongMemEval question types.
    cp = max(1, len(turns) // 2)

    criterion = (
        f"Response must include the answer '{answer}' (or a clear paraphrase, "
        f"same factual content). Empty or contradictory answers fail. "
        f"LongMemEval-S {qtype} probe."
    )
    fixture = {
        "id": f"F-LME-s-{qid}",
        "domain": f"longmemeval-s-{qtype}",
        "notes": (
            f"R8.2d: LongMemEval-S {qtype} from xiaowu0162/longmemeval-cleaned. "
            f"{len(turns)} turns across {len(sessions)} sessions. Published "
            f"baselines (paper Table 4-ish): GPT-4 ~0.775, Claude 3 Opus ~0.765, "
            f"Llama 3 70B ~0.745. Our stack is measured against these via the "
            f"same recap-only probe class."
        ),
        "turns": turns,
        "probes": [
            {
                "afterTurn": len(turns) + 1,
                "type": "task-accuracy",
                "question": question,
                "criterion": criterion,
                "factTurns": fact_turns,
            }
        ],
        "compactionPoints": [cp],
    }
    return fixture


def main() -> None:
    with open(SOURCE, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"loaded {len(data)} LongMemEval-S items")

    by_type: dict[str, list[dict]] = {}
    for item in data:
        by_type.setdefault(item["question_type"], []).append(item)

    selected: list[dict] = []
    for qtype, items in by_type.items():
        random.shuffle(items)
        selected.extend(items[:PER_TYPE])
    print(f"selected {len(selected)} items ({PER_TYPE} per type)")

    for item in selected:
        fx = adapt(item)
        path = os.path.join(OUT_DIR, f"{fx['id']}.fixture.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(fx, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"  {fx['id']}: {len(fx['turns'])} turns, cp={fx['compactionPoints'][0]}, factTurns={len(fx['probes'][0]['factTurns'])}")


if __name__ == "__main__":
    main()
