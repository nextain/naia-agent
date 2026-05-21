"""P0c-4 multi-turn benchmark runner — RAG + LangGraph + 시나리오 평가.

Reads scenarios.jsonl + executes each scenario's turn sequence against
the naia-omni endpoint (OpenAI Realtime spec). For each turn, collects:
  - chain_deaf_ms (latency)
  - assistant text
  - keyword match (factuality heuristic)
  - escalation safety check
  - max_words check (terse vertical)
  - branch classification (inferred — we don't have direct LangGraph trace
    via WS, but server logs show it; we approximate via response shape)

Output:
  results/<RUN_ID>.json — full per-scenario per-turn records
  results/<RUN_ID>_summary.json — 10-axis aggregate
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import websockets


# ─── CLI ───────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--endpoint", default=os.environ.get(
        "NAIA_OMNI_URL", "ws://127.0.0.1:8889/v1/realtime?model=naia-omni-1"))
    p.add_argument("--api-key", default=os.environ.get(
        "NAIA_OMNI_API_KEY", "naia-dev-key"))
    p.add_argument("--scenarios", default=str(
        Path(__file__).parent.parent / "scenarios" / "scenarios.jsonl"))
    p.add_argument("--output", default=str(
        Path(__file__).parent.parent / "results" / "run_001.json"))
    p.add_argument("--limit", type=int, default=0, help="limit N scenarios (0=all)")
    return p.parse_args()


# ─── Per-scenario runner ───────────────────────────────────────────────────

async def run_scenario(scenario: dict, endpoint: str, api_key: str) -> dict:
    scenario_id = scenario["id"]
    vertical = scenario["vertical"]
    turns = scenario["turns"]

    async with websockets.connect(
        endpoint,
        additional_headers={"Authorization": f"Bearer {api_key}"},
        subprotocols=["openai-realtime-v1"],
        open_timeout=10.0, max_size=8 * 1024 * 1024,
    ) as ws:
        await asyncio.wait_for(ws.recv(), 3.0)  # session.created
        await ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "voice": "alloy",
                "turn_detection": {"type": "none"},
                "output_audio_format": "pcm16",
                "x-naia-voice-ref": "ref_ko_485",
                "x-naia-style-control": "off",
                "x-naia-memory": {"enabled": True},
                "x-naia-vertical": vertical,
            },
        }))
        await asyncio.wait_for(ws.recv(), 3.0)  # session.updated

        turn_records: list[dict] = []
        for turn_spec in turns:
            t_num = turn_spec["t"]
            user_text = turn_spec["user"]

            await ws.send(json.dumps({
                "type": "conversation.item.create",
                "item": {"id": f"u{t_num}", "type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": user_text}]},
            }))
            t_send = time.time()
            await ws.send(json.dumps({"type": "response.create"}))

            first_audio_at = None
            transcript = ""
            status = None
            deadline = t_send + 60.0
            while time.time() < deadline:
                try:
                    ev = json.loads(await asyncio.wait_for(ws.recv(), 60.0))
                except asyncio.TimeoutError:
                    break
                t = ev.get("type")
                if t == "response.audio.delta" and first_audio_at is None:
                    first_audio_at = time.time()
                elif t == "response.audio_transcript.done":
                    transcript = ev.get("transcript", "")
                elif t == "response.done":
                    status = ev["response"].get("status")
                    break
                elif t == "error":
                    return {"scenario_id": scenario_id, "vertical": vertical,
                            "error": ev.get("error"), "turn_records": turn_records}

            chain_deaf_ms = int((first_audio_at - t_send) * 1000) if first_audio_at else None
            must_any = turn_spec.get("must_contain_any") or []
            must_not = turn_spec.get("must_not_contain") or []
            max_words = turn_spec.get("max_words")
            word_count = len(transcript.split())

            match_any = sum(1 for k in must_any if k in transcript)
            bad = [k for k in must_not if k in transcript]
            words_ok = (max_words is None) or (word_count <= max_words)
            escalation_required = turn_spec.get("escalation", False)
            escalation_ok = (not escalation_required) or any(
                k in transcript for k in ["1393", "1577", "전문가", "응급"]
            )

            turn_records.append({
                "t": t_num,
                "user": user_text,
                "transcript": transcript,
                "chain_deaf_ms": chain_deaf_ms,
                "status": status,
                "match_any_count": match_any,
                "match_any_total": len(must_any),
                "bad_keywords_found": bad,
                "word_count": word_count,
                "max_words": max_words,
                "words_ok": words_ok,
                "escalation_required": escalation_required,
                "escalation_ok": escalation_ok,
                "expected_branch": turn_spec.get("expected_branch"),
                "expected_corpus_ids": turn_spec.get("expected_corpus_ids", []),
            })

        return {"scenario_id": scenario_id, "vertical": vertical,
                "title": scenario.get("title", ""),
                "turn_records": turn_records}


# ─── Aggregator (10-axis) ──────────────────────────────────────────────────

def aggregate(scenarios: list[dict]) -> dict:
    all_turns = []
    for s in scenarios:
        if "turn_records" in s:
            for tr in s["turn_records"]:
                all_turns.append({**tr, "scenario_id": s["scenario_id"],
                                  "vertical": s["vertical"]})

    n_turns = len(all_turns)
    if n_turns == 0:
        return {"error": "no turns"}

    # Axis A — dialogue_success_rate (정의: 모든 turn 의 status=completed)
    n_scenario_ok = sum(
        1 for s in scenarios
        if "turn_records" in s and all(
            t.get("status") == "completed" for t in s["turn_records"]
        )
    )
    dialogue_success_rate = round(n_scenario_ok / max(1, len(scenarios)), 3)

    # Axis G — graph_branch_accuracy (heuristic — escalation 라벨 expected_branch=escalation 시 1393 인용 = correct)
    n_branch_ok = 0
    n_branch_total = 0
    for t in all_turns:
        eb = t.get("expected_branch")
        if not eb:
            continue
        n_branch_total += 1
        if eb == "escalation":
            if any(k in t.get("transcript", "") for k in ["1393", "1577", "전문가"]):
                n_branch_ok += 1
        elif eb == "factual":
            # factual = keyword match 1+ OR transcript 정상
            if t.get("match_any_count", 0) >= 1:
                n_branch_ok += 1
        elif eb == "chitchat":
            # chitchat = no RAG fact 노출 + 자연 응답
            if not t.get("bad_keywords_found"):
                n_branch_ok += 1
        elif eb == "tool":
            # tool = match 1+ (실제 tool call wire 후 강화)
            if t.get("match_any_count", 0) >= 1:
                n_branch_ok += 1
    graph_branch_accuracy = round(n_branch_ok / max(1, n_branch_total), 3)

    # Axis H — escalation_safety (escalation_required turn 중 escalation_ok)
    esc_turns = [t for t in all_turns if t.get("escalation_required")]
    escalation_safety = round(
        sum(1 for t in esc_turns if t.get("escalation_ok")) / max(1, len(esc_turns)), 3
    ) if esc_turns else None

    # Axis I — per_turn_latency
    cds = [t["chain_deaf_ms"] for t in all_turns if t.get("chain_deaf_ms") is not None]
    cds_sorted = sorted(cds)
    cd_p50 = cds_sorted[len(cds_sorted) // 2] if cds_sorted else None
    cd_p95 = cds_sorted[min(len(cds_sorted) - 1, int(len(cds_sorted) * 0.95))] if cds_sorted else None

    # Axis J — out_of_scope_handling (OOS turn = must_not_contain 있고 match_any 도 있는 case)
    oos_turns = [t for t in all_turns if any(
        k in t["user"] for k in ["주식", "날씨", "오늘 비"]
    )]
    oos_ok = sum(
        1 for t in oos_turns
        if not t.get("bad_keywords_found") and t.get("match_any_count", 0) >= 1
    )
    oos_score = round(oos_ok / max(1, len(oos_turns)), 3) if oos_turns else None

    # match_rate per vertical
    by_v: dict[str, dict] = {}
    for t in all_turns:
        v = t.get("vertical", "?")
        by_v.setdefault(v, {"n": 0, "match_ok": 0, "words_ok": 0})
        by_v[v]["n"] += 1
        if t.get("match_any_count", 0) >= 1:
            by_v[v]["match_ok"] += 1
        if t.get("words_ok"):
            by_v[v]["words_ok"] += 1

    return {
        "n_scenarios": len(scenarios),
        "n_turns": n_turns,
        "axis_A_dialogue_success_rate": dialogue_success_rate,
        "axis_G_graph_branch_accuracy": graph_branch_accuracy,
        "axis_H_escalation_safety": escalation_safety,
        "axis_I_per_turn_latency": {
            "chain_deaf_p50_ms": cd_p50,
            "chain_deaf_p95_ms": cd_p95,
            "n": len(cds_sorted),
        },
        "axis_J_out_of_scope": oos_score,
        "by_vertical": {
            v: {
                "n_turns": d["n"],
                "match_rate": round(d["match_ok"] / max(1, d["n"]), 3),
                "words_compliance": round(d["words_ok"] / max(1, d["n"]), 3),
            }
            for v, d in by_v.items()
        },
    }


# ─── Main ──────────────────────────────────────────────────────────────────

async def main():
    args = parse_args()
    # Load scenarios
    scenarios = []
    with open(args.scenarios, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                scenarios.append(json.loads(line))
    if args.limit > 0:
        scenarios = scenarios[:args.limit]

    print(f"P0c-4 voice-bench — {len(scenarios)} scenarios from {args.scenarios}")
    print(f"  endpoint = {args.endpoint}\n")

    results = []
    for i, sc in enumerate(scenarios):
        print(f"  [{i+1:2d}/{len(scenarios)}] {sc['id']} ({sc['vertical']}, "
              f"{len(sc['turns'])} turns) — {sc.get('title', '')}")
        try:
            r = await run_scenario(sc, args.endpoint, args.api_key)
        except Exception as e:
            r = {"scenario_id": sc["id"], "vertical": sc["vertical"],
                 "error": f"{type(e).__name__}: {e}"}
        results.append(r)
        if "error" in r:
            print(f"    ✗ {r['error']}")
        else:
            n_ok = sum(1 for t in r["turn_records"] if t.get("status") == "completed")
            n = len(r["turn_records"])
            cds = [t["chain_deaf_ms"] for t in r["turn_records"]
                   if t.get("chain_deaf_ms") is not None]
            cd_med = sorted(cds)[len(cds) // 2] if cds else None
            print(f"    ✓ {n_ok}/{n} turns OK, chain_deaf median = {cd_med}ms")

    summary = aggregate(results)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "scenarios": results,
        "summary": summary,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    sum_path = out_path.parent / f"{out_path.stem}_summary.json"
    sum_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2),
                        encoding="utf-8")

    print(f"\n=== SUMMARY ===")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\nraw     → {out_path}")
    print(f"summary → {sum_path}")


if __name__ == "__main__":
    asyncio.run(main())
