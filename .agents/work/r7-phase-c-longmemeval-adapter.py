#!/usr/bin/env python3
"""
R7 Phase C — LongMemEval-S → Fixture adapter.

LongMemEval-S 의 test-dataset.json (3 sample 항목) 을 우리 Fixture
형식으로 변환. published baseline (OMEGA 95.4% / Memoria ~89% /
RetainDB 79%) 와 비교 가능한 fixture 생성.

Mapping:
  - LongMemEval question_id → Fixture id (e.g., F-LME-test-001)
  - haystack_sessions[*] flatten → Fixture turns (skip system markers)
  - question + answer + has_answer turns → task-accuracy probe
  - factTurns = has_answer == true 인 turn 의 1-based 인덱스
  - compactionPoints = [turn count / 2] (mid-point auto)
  - domain = "longmemeval-" + question_type
"""
import json
import os

SOURCE = "/var/home/luke/alpha-adk/projects/refs/ref-mastra/explorations/longmemeval/src/__fixtures__/test-dataset.json"
OUT_DIR = "/var/home/luke/alpha-adk/projects/naia-agent-worktrees/slice-compact-v2/packages/benchmarks/src/fixtures"


def adapt_item(item: dict) -> dict:
    qid = item["question_id"]
    qtype = item["question_type"]
    sessions = item["haystack_sessions"]
    question = item["question"]
    answer = item["answer"]

    # Flatten sessions into a turn list with session markers as system turns.
    turns: list[dict] = []
    fact_turns: list[int] = []
    for sess_idx, session in enumerate(sessions):
        if sess_idx > 0:
            # Session boundary marker as system turn.
            turns.append({
                "role": "system",
                "content": f"[Session {sess_idx + 1} starts]",
            })
        for turn in session:
            # Map LongMemEval roles to fixture roles. LongMemEval uses
            # "user" and "assistant".
            role = turn["role"]
            if role not in ("user", "assistant", "system", "tool"):
                role = "user"  # fallback
            content = turn["content"]
            turns.append({"role": role, "content": content})
            if turn.get("has_answer"):
                fact_turns.append(len(turns))  # 1-based

    # compactionPoint at mid-point so the answer location splits across
    # recap vs tail predictably.
    cp = max(1, len(turns) // 2)

    # Probe at end of conversation, asking the LongMemEval question.
    criterion = (
        f"Response must include the answer '{answer}' (or a clear paraphrase). "
        f"Empty or contradictory answers fail. This is a {qtype} probe from "
        f"LongMemEval-S."
    )

    fixture = {
        "id": f"F-LME-{qid}",
        "domain": f"longmemeval-{qtype}",
        "notes": (
            "R7 Phase C: LongMemEval-S subset (ref-mastra test-dataset.json). "
            f"question_type={qtype}. compactionPoint at mid-point ({cp}) so "
            "the answer location is predictable wrt recap vs tail. "
            "Published baseline (OMEGA 95.4%, Memoria ~89%, RetainDB 79%) "
            "uses the full 500-question set — this 3-item subset is sanity, "
            "not direct head-to-head."
        ),
        "turns": turns,
        "probes": [
            {
                "afterTurn": len(turns),
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

    for item in data:
        fx = adapt_item(item)
        out_path = os.path.join(OUT_DIR, f"{fx['id']}.fixture.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(fx, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"wrote {fx['id']} ({len(fx['turns'])} turns, cp={fx['compactionPoints'][0]}, factTurns={fx['probes'][0]['factTurns']})")


if __name__ == "__main__":
    main()
