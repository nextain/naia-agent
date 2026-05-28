# Coding Bench — 2026-05-28 16:26:59

**Model:** `gemini:gemini-3.1-flash-lite`  
**Date:** 2026-05-28  

## Overall Score

| Suite | Score | / Max | % | vs prev |
|-------|-------|-------|---|---------|
| C — Code Gen  | 49 | 49 | **100%** | (=) |
| R — Reasoning | 13 | 14 | **93%** | (+14) |
| **Total** | **62** | **63** | **98%** | (+3) |

## Per-task Results

| ID | Suite | Diff | Name | Score | Raw/Max | Turns | Tools | In tok | Out tok | Time(s) |
|----|-------|------|------|-------|---------|-------|-------|--------|---------|--------|
| C-01 | C | L1 | sumArray | 100% | 4/4 | 1 | 0 | 205 | 33 | 0.9 |
| C-02 | C | L1 | reverseWords | 100% | 4/4 | 1 | 0 | 211 | 31 | 0.6 |
| C-03 | C | L2 | isPrime | 100% | 8/8 | 1 | 0 | 208 | 122 | 0.7 |
| C-04 | C | L2 | twoSum | 100% | 3/3 | 1 | 0 | 226 | 95 | 1.1 |
| C-05 | C | L3 | isValidParens | 100% | 7/7 | 1 | 0 | 212 | 153 | 0.9 |
| C-06 | C | L3 | maxSubarraySum | 100% | 4/4 | 1 | 0 | 214 | 97 | 0.9 |
| C-07 | C | L3 | longestCommonPrefix | 100% | 5/5 | 1 | 0 | 208 | 124 | 0.9 |
| C-08 | C | L4 | mergeIntervals | 100% | 4/4 | 1 | 0 | 210 | 212 | 1.0 |
| C-09 | C | L4 | climbStairs | 100% | 5/5 | 1 | 0 | 220 | 97 | 0.8 |
| C-10 | C | L5 | LFU Cache | 100% | 5/5 | 1 | 0 | 253 | 561 | 1.9 |
| R-01 | R | L2 | 런타임 오류 원인 설명 | 100% | 2/2 | 1 | 0 | 195 | 46 | 0.7 |
| R-02 | R | L2 | Big-O 분석 | 100% | 2/2 | 1 | 0 | 235 | 61 | 0.6 |
| R-03 | R | L3 | 코드 출력 예측 | 100% | 1/1 | 1 | 0 | 239 | 2 | 0.5 |
| R-04 | R | L3 | 버그 찾기 | 100% | 2/2 | 1 | 0 | 266 | 517 | 2.2 |
| R-05 | R | L4 | 설계 트레이드오프 분석 | 67% | 2/3 | 1 | 0 | 191 | 894 | 3.7 |
| R-06 | R | L5 | 시스템 설계 (메모리 시스템) | 100% | 4/4 | 1 | 0 | 207 | 1,090 | 4.9 |

## Cost & Performance

| Metric | Value |
|--------|-------|
| Total duration | 22.5s |
| Input tokens   | 3,500 |
| Output tokens  | 4,135 |
| Pricing        | $0.25/M in, $1.5/M out |
| Estimated cost | $0.00708 USD |
