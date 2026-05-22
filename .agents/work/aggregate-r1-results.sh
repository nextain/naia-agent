#!/bin/bash
REPORTS=/var/home/luke/alpha-adk/projects/naia-agent-worktrees/slice-compact-v2/packages/benchmarks/reports
DATE=$(date +%Y-%m-%d)

echo "## R1 results — 5 fixtures × 5 strategies × 1 probe × 4 judges"
echo ""
echo "| Fixture | reactive | reactive-vercel | realtime | anthropic-native | off |"
echo "|---|---:|---:|---:|---:|---:|"

extract_rate() {
  local report="$1"
  local strategy="$2"
  if [ ! -f "$report" ]; then echo "—"; return; fi
  grep -E "^\| \`$strategy\` \|" "$report" | head -1 | awk -F'|' '{gsub(/^ +| +$/, "", $3); print $3}'
}

for fx in F-KR-IE-01-information-extraction F-KR-MS-01-multi-session F-KR-TR-01-temporal-reasoning F-KR-KU-01-knowledge-update F-KR-AB-01-abstention F-EN-TH-01-tool-heavy; do
  report="$REPORTS/${DATE}-mini-bench-judge-${fx}.md"
  r=$(extract_rate "$report" "reactive")
  rv=$(extract_rate "$report" "reactive-vercel")
  rt=$(extract_rate "$report" "realtime")
  an=$(extract_rate "$report" "anthropic-native")
  off=$(extract_rate "$report" "off")
  echo "| $fx | ${r:-—} | ${rv:-—} | ${rt:-—} | ${an:-—} | ${off:-—} |"
done
