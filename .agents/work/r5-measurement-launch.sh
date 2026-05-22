#!/bin/bash
# Launch R5 measurement after R4 finishes
rm -f /tmp/phase13-r5-log.txt
set -a && source /home/luke/alpha-adk/data-private/llm-keys/llm.env && set +a
for f in F-KR-IE-01-information-extraction F-KR-MS-01-multi-session F-KR-TR-01-temporal-reasoning F-KR-KU-01-knowledge-update F-KR-AB-01-abstention F-EN-TH-01-tool-heavy; do
  echo "=== $f ===" >> /tmp/phase13-r5-log.txt
  timeout 900 pnpm --filter @nextain/agent-benchmarks exec tsx scripts/mini-bench-judge.ts "$f" >> /tmp/phase13-r5-log.txt 2>&1
done
echo "ALL_DONE_R5" >> /tmp/phase13-r5-log.txt
