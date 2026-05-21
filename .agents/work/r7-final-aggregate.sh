#!/bin/bash
REPORTS=/var/home/luke/alpha-adk/projects/naia-agent-worktrees/slice-compact-v2/packages/benchmarks/reports
DATE=$(date +%Y-%m-%d)

echo "## R7 Final results — 9 fixtures × 4 strategies"
echo ""
echo "| Fixture | reactive (recap/tail/uncl) | reactive-vercel | realtime | off |"
echo "|---|---|---|---|---|"

extract_row() {
  local report="$1"
  local strategy="$2"
  grep -E "^\| \`$strategy\` \|" "$report" 2>/dev/null | head -1 | awk -F'|' '{
    gsub(/^ +| +$/, "", $3); gsub(/^ +| +$/, "", $4); gsub(/^ +| +$/, "", $5)
    print $3 " / " $4 " / " $5
  }'
}

for fx in F-KR-IE-01-information-extraction F-KR-MS-01-multi-session F-KR-TR-01-temporal-reasoning F-KR-KU-01-knowledge-update F-KR-AB-01-abstention F-EN-TH-01-tool-heavy F-LME-test-001 F-LME-test-002 F-LME-test-003; do
  report="$REPORTS/${DATE}-mini-bench-judge-${fx}.md"
  if [ ! -f "$report" ]; then
    echo "| $fx | MISSING | MISSING | MISSING | MISSING |"
    continue
  fi
  r=$(extract_row "$report" "reactive")
  rv=$(extract_row "$report" "reactive-vercel")
  rt=$(extract_row "$report" "realtime")
  off=$(extract_row "$report" "off")
  echo "| $fx | ${r:-—} | ${rv:-—} | ${rt:-—} | ${off:-—} |"
done
