#!/usr/bin/env bash
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="$BENCH_DIR/reports"
DATE="$(date +%Y-%m-%d)"
SUMMARY="$REPORT_DIR/${DATE}-all-fixtures-summary.md"
FAIL_LOG="$REPORT_DIR/${DATE}-all-fixtures-failures.log"

mkdir -p "$REPORT_DIR"

FIXTURES=()
for f in "$BENCH_DIR/src/fixtures/"*.fixture.json; do
	base="$(basename "$f" .fixture.json)"
	FIXTURES+=("$base")
done

TOTAL=${#FIXTURES[@]}
OK=0
FAIL=0

echo "[run-all] $TOTAL fixtures, 5 strategies (pi, hermes, reactive, naia+llm, off)"
echo "[run-all] started at $(date -Iseconds)"

{
	echo "# Full Benchmark Run — $DATE"
	echo ""
	echo "- **Fixtures**: $TOTAL"
	echo "- **Strategies**: pi, hermes, reactive, naia+llm, off"
	echo "- **Config**: keepTail=10, contextCap=16000, targetTokens=1000"
	echo ""
	echo "## Summary Table"
	echo ""
	echo "| Fixture | pi | hermes | reactive | naia+llm | off | Fatal? |"
	echo "|---|---|---|---|---|---|---|"
} > "$SUMMARY"

> "$FAIL_LOG"

for fixture in "${FIXTURES[@]}"; do
	i=$((OK + FAIL + 1))
	echo "[run-all] ($i/$TOTAL) $fixture ..."
	if pnpm exec tsx scripts/mini-bench-judge.ts "$fixture" > /dev/null 2>&1; then
		OK=$((OK + 1))
		ROW="| \`$fixture\` | see report | see report | see report | see report | see report | no |"
	else
		FAIL=$((FAIL + 1))
		echo "[run-all] FAILED: $fixture" >> "$FAIL_LOG"
		ROW="| \`$fixture\` | - | - | - | - | - | **FAIL** |"
	fi
	echo "$ROW" >> "$SUMMARY"
done

{
	echo ""
	echo "## Stats"
	echo ""
	echo "- OK: $OK"
	echo "- FAIL: $FAIL"
	echo "- Total: $TOTAL"
	echo "- Completed: $(date -Iseconds)"
} >> "$SUMMARY"

echo "[run-all] done. OK=$OK FAIL=$FAIL total=$TOTAL"
echo "[run-all] summary → $SUMMARY"
if [ "$FAIL" -gt 0 ]; then
	echo "[run-all] failures → $FAIL_LOG"
fi
