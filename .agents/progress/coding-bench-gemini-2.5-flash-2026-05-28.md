# Coding Bench — 2026-05-28 14:27:22

**Model:** `gemini:gemini-2.5-flash`  
**Date:** 2026-05-28  

## Overall Score

| Suite | Score | / Max | % | vs prev |
|-------|-------|-------|---|---------|
| C — Code Gen  | 49 | 49 | **100%** | (=) |
| R — Reasoning | 8 | 14 | **57%** | (-36) |
| **Total** | **57** | **63** | **90%** | (+1) |

## Per-task Results

| ID | Suite | Diff | Name | Score | Raw/Max | Turns | Tools | In tok | Out tok | Time(s) |
|----|-------|------|------|-------|---------|-------|-------|--------|---------|--------|
| C-01 | C | L1 | sumArray | 100% | 4/4 | 1 | 0 | 201 | 83 | 1.2 |
| C-02 | C | L1 | reverseWords | 100% | 4/4 | 1 | 0 | 207 | 246 | 2.1 |
| C-03 | C | L2 | isPrime | 100% | 8/8 | 1 | 0 | 204 | 635 | 3.7 |
| C-04 | C | L2 | twoSum | 100% | 3/3 | 1 | 0 | 222 | 467 | 3.0 |
| C-05 | C | L3 | isValidParens | 100% | 7/7 | 1 | 0 | 208 | 424 | 2.5 |
| C-06 | C | L3 | maxSubarraySum | 100% | 4/4 | 1 | 0 | 210 | 893 | 4.5 |
| C-07 | C | L3 | longestCommonPrefix | 100% | 5/5 | 1 | 0 | 204 | 351 | 2.6 |
| C-08 | C | L4 | mergeIntervals | 100% | 4/4 | 1 | 0 | 206 | 1,034 | 5.3 |
| C-09 | C | L4 | climbStairs | 100% | 5/5 | 1 | 0 | 216 | 663 | 4.0 |
| C-10 | C | L5 | LFU Cache | 100% | 5/5 | 1 | 0 | 249 | 6,583 | 30.6 |
| R-01 | R | L2 | 런타임 오류 원인 설명 | 50% | 1/2 | 1 | 0 | 191 | 212 | 2.0 |
| R-02 | R | L2 | Big-O 분석 | 100% | 2/2 | 1 | 0 | 231 | 399 | 2.6 |
| R-03 | R | L3 | 코드 출력 예측 | 100% | 1/1 | 1 | 0 | 235 | 283 | 2.2 |
| R-04 | R | L3 | 버그 찾기 | 0% | 0/2 | 1 | 0 | 262 | 1,923 | 39.5 |
| R-05 | R | L4 | 설계 트레이드오프 분석 | 0% | 0/3 | 1 | 0 | 187 | 1,933 | 10.8 |
| R-06 | R | L5 | 시스템 설계 (메모리 시스템) | 100% | 4/4 | 1 | 0 | 203 | 219 | 2.1 |

## Cost & Performance

| Metric | Value |
|--------|-------|
| Total duration | 118.7s |
| Input tokens   | 3,436 |
| Output tokens  | 16,348 |
| Pricing        | $0.075/M in, $0.3/M out |
| Estimated cost | $0.00516 USD |
