#!/usr/bin/env python3
"""
R7 Phase B — fixture 정비:
1. 기존 task-accuracy probe 에 factTurns 추가 (honest 분류용)
2. recap-only stress probe 추가 (strategy quality 측정용)
3. F-EN-TH-01 의 tail-trivial probe 정리

각 fixture 의 fact 위치는 코드 read 후 수동 분석한 결과 기반.
"""
import json
import os

FIXTURES_DIR = "/var/home/luke/alpha-adk/projects/naia-agent-worktrees/slice-compact-v2/packages/benchmarks/src/fixtures"

# 각 fixture 에 (a) 기존 task probe 의 factTurns (b) 추가 probe 정의
UPDATES = {
    "F-KR-IE-01-information-extraction": {
        # compactionPoint=16, keepTail=2 → tail start at 14
        # 기존 probe: afterTurn 32, "모든 알레르기 + 알레르기 아닌 항목"
        # 알레르기 mention: turn 3, 4, 18, 19, 20, 24, 26, 28 — 대부분 tail
        # 씨앗 OK: turn 20, 22 — tail
        # → tail-trivial (factTurns 에 18+ 포함)
        "existing_task_probes_factTurns": {
            32: [3, 4, 18, 19, 20, 22, 24, 26, 28],
        },
        # 추가 recap-only probe: 가족력 (turn 13) — 명백히 recap range
        "new_probes": [
            {
                "afterTurn": 32,
                "type": "task-accuracy",
                "question": "사용자의 가족력 중 식단과 관련된 건강 위험 요소는 무엇인가요?",
                "criterion": "응답이 '아빠가 당뇨' (또는 동등한 '부친 당뇨', '가족력 당뇨') 를 명확히 언급해야 한다. 단순 '없음' 또는 '모름' 응답 = fail.",
                "factTurns": [13],
            },
            {
                "afterTurn": 32,
                "type": "task-accuracy",
                "question": "사용자의 체중과 키, BMI 는 얼마인가요?",
                "criterion": "응답이 체중 73kg + 키 174cm + BMI ~24 (또는 등가 숫자) 를 모두 포함해야 한다.",
                "factTurns": [15, 16],
            },
        ],
    },
    "F-KR-MS-01-multi-session": {
        # compactionPoint=18, keepTail=2 → tail start at 16
        # 기존 probe: 1일 평균 예산 = 100만원 / 5일
        # "100만원" = turn 12, 14 (BOTH recap range)
        # "1일 11만원" = turn 13, 15 (recap range)
        # "5일" = turn 19 (tail)
        # → mixed: 답 만들려면 recap fact 필요 (100만원) AND tail fact (5일)
        # 답이 tail 에 일부 있어도 strategy stress 됨 (recap fact 손실 시 답 못 함)
        # factTurns = recap+tail 둘 다. classify = tail-trivial 이지만 실제는 partial.
        "existing_task_probes_factTurns": {
            30: [12, 13, 14, 15, 19, 29],
        },
        "new_probes": [
            # recap-only: 항공/숙소 비율 — turn 7 에서 정해짐
            {
                "afterTurn": 30,
                "type": "task-accuracy",
                "question": "사용자가 처음 상담 시 알려준 총 예산은 얼마인가요?",
                "criterion": "응답이 '500만원' (또는 동등) 를 포함해야 한다.",
                "factTurns": [7],
            },
        ],
    },
    "F-KR-TR-01-temporal-reasoning": {
        # compactionPoint=14, keepTail=2 → tail start at 12
        # 기존 probe: 4월 14일 화요일 = 신제품 발표 회의
        # "4월 14일 신제품 회의" = turn 6, 7 (recap range, well before compactionPoint)
        # → recap-only ✅
        "existing_task_probes_factTurns": {
            26: [6, 7],
        },
        "new_probes": [],
    },
    "F-KR-KU-01-knowledge-update": {
        # compactionPoint=16, keepTail=2 → tail start at 14
        # 기존 probe: 현재 직장 = 네이버 (이전 카카오 → 네이버 이직)
        # "네이버" = turn 9, 13, 16-17, 21-22, 25-27 (compactionPoint 까지 turn 9-17, tail 14+)
        # 답 "네이버" 는 tail (turn 21+, "네이버 합격") 에 명확히
        # → tail-trivial
        "existing_task_probes_factTurns": {
            28: [9, 13, 16, 17, 21, 22, 25, 26, 27],
        },
        "new_probes": [
            # recap-only: 사용자가 처음 이직 고민 시작 시 다니던 회사 + 연차
            {
                "afterTurn": 28,
                "type": "task-accuracy",
                "question": "사용자가 처음 이직 고민을 시작했을 때 어느 회사에서 몇 년차였나요?",
                "criterion": "응답이 '카카오' + '3년차' 를 모두 포함해야 한다. 단순 '카카오' 만 또는 '3년' 만 = fail.",
                "factTurns": [5],
            },
        ],
    },
    "F-KR-AB-01-abstention": {
        # compactionPoint=16, keepTail=2 → tail start at 14
        # 기존 probe: 사용자의 생일 = 알 수 없음 (abstention)
        # "다음주 생일" mention = turn 27 (tail), but exact date 미공개
        # abstention 측정 — fact 가 NOT 있는 게 정답.
        # factTurns = [] (이건 unclassified — abstention 의 본질)
        "existing_task_probes_factTurns": {
            30: [],
        },
        "new_probes": [
            # recap-only stress: turn 4-6 의 명확 fact (예: 사용자가 처음 말한 정보)
            # AB fixture content 확인 후 추가
        ],
    },
    "F-EN-TH-01-tool-heavy": {
        # compactionPoint=10, keepTail=2 → tail start at 8
        # 기존 probe 1 (afterTurn=19): "complete trip summary" with LCH-id + RES-J-id
        # LCH = turn 11, 12 (tail) — tail-trivial
        # RES-J = turn 17, 18 (tail) — tail-trivial
        # 기존 probe 2 (afterTurn=19): Saturday weather
        # weather = turn 3 (tool), 4 (assistant) — recap range ✅ recap-only
        "existing_task_probes_factTurns": {
            # 19, first task probe — trip summary
            # 19, second task probe — weather
            # Python dict can't have duplicate keys; we'll handle in loop differently.
        },
        # We handle via different mechanism: iterate probes, match by question.
        "new_probes": [],
    },
}

# F-EN-TH-01 specific handling (multiple task probes at same afterTurn)
F_EN_TH_PROBE_TAGS = {
    "Summarize the user's complete weekend Busan trip": [11, 12, 13, 14, 17, 18],
    "What was the Saturday weather forecast": [3, 4],
}


def update_fixture(fxid: str, spec: dict) -> None:
    path = os.path.join(FIXTURES_DIR, f"{fxid}.fixture.json")
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    changed = 0

    # Update existing task-accuracy probes with factTurns
    probes = data.get("probes", [])
    if fxid == "F-EN-TH-01-tool-heavy":
        # Match by question substring (multiple task probes at same afterTurn)
        for probe in probes:
            if probe.get("type") != "task-accuracy":
                continue
            for tag, turns in F_EN_TH_PROBE_TAGS.items():
                if tag in probe.get("question", ""):
                    if probe.get("factTurns") != turns:
                        probe["factTurns"] = turns
                        changed += 1
                    break
    else:
        # Match by afterTurn
        ft_map = spec.get("existing_task_probes_factTurns", {})
        for probe in probes:
            if probe.get("type") != "task-accuracy":
                continue
            target = ft_map.get(probe.get("afterTurn"))
            if target is not None:
                if probe.get("factTurns") != target:
                    probe["factTurns"] = target
                    changed += 1

    # Add new probes
    for new_probe in spec.get("new_probes", []):
        # Check not already added (idempotent: match by question)
        if any(p.get("question") == new_probe["question"] for p in probes):
            continue
        probes.append(new_probe)
        changed += 1

    data["probes"] = probes

    if changed > 0:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"{fxid}: {changed} changes")
    else:
        print(f"{fxid}: no changes")


if __name__ == "__main__":
    for fxid, spec in UPDATES.items():
        update_fixture(fxid, spec)
