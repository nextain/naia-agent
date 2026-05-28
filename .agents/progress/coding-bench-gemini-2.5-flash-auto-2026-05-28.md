# Coding Bench — 2026-05-28 16:26:22

**Model:** `gemini:gemini-2.5-flash`  
**Date:** 2026-05-28  

## Overall Score

| Suite | Score | / Max | % | vs prev |
|-------|-------|-------|---|---------|
| C — Code Gen  | 49 | 49 | **100%** | (=) |
| R — Reasoning | 11 | 14 | **79%** | (-14) |
| **Total** | **60** | **63** | **95%** | (+12) |

## Per-task Results

| ID | Suite | Diff | Name | Score | Raw/Max | Turns | Tools | In tok | Out tok | Time(s) |
|----|-------|------|------|-------|---------|-------|-------|--------|---------|--------|
| C-01 | C | L1 | sumArray | 100% | 4/4 | 1 | 0 | 201 | 91 | 5.5 |
| C-02 | C | L1 | reverseWords | 100% | 4/4 | 1 | 0 | 207 | 169 | 1.9 |
| C-03 | C | L2 | isPrime | 100% | 8/8 | 1 | 0 | 204 | 486 | 3.1 |
| C-04 | C | L2 | twoSum | 100% | 3/3 | 1 | 0 | 222 | 662 | 3.9 |
| C-05 | C | L3 | isValidParens | 100% | 7/7 | 1 | 0 | 208 | 682 | 3.9 |
| C-06 | C | L3 | maxSubarraySum | 100% | 4/4 | 1 | 0 | 210 | 1,224 | 6.0 |
| C-07 | C | L3 | longestCommonPrefix | 100% | 5/5 | 1 | 0 | 204 | 502 | 3.2 |
| C-08 | C | L4 | mergeIntervals | 100% | 4/4 | 1 | 0 | 206 | 839 | 4.4 |
| C-09 | C | L4 | climbStairs | 100% | 5/5 | 1 | 0 | 216 | 2,431 | 11.4 |
| C-10 | C | L5 | LFU Cache | 100% | 5/5 | 1 | 0 | 249 | 6,185 | 26.8 |
| R-01 | R | L2 | 런타임 오류 원인 설명 | 100% | 2/2 | 1 | 0 | 191 | 197 | 2.0 |
| R-02 | R | L2 | Big-O 분석 | 100% | 2/2 | 1 | 0 | 231 | 329 | 2.6 |
| R-03 | R | L3 | 코드 출력 예측 | 100% | 1/1 | 1 | 0 | 235 | 394 | 2.7 |
| R-04 | R | L3 | 버그 찾기 | 50% | 1/2 | 1 | 0 | 262 | 1,702 | 8.1 |
| R-05 | R | L4 | 설계 트레이드오프 분석 | 33% | 1/3 | 1 | 0 | 187 | 2,006 | 10.4 |
| R-06 | R | L5 | 시스템 설계 (메모리 시스템) | 100% | 4/4 | 1 | 0 | 203 | 2,556 | 14.8 |

## Cost & Performance

| Metric | Value |
|--------|-------|
| Total duration | 110.6s |
| Input tokens   | 3,436 |
| Output tokens  | 20,455 |
| Pricing        | $0.3/M in, $2.5/M out |
| Estimated cost | $0.05217 USD |
