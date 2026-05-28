// agent-bench — naia-agent 에이전트 성능 바로미터.
//
// ▌목적
//   1. 미션 유형별 모델 강점 비교 (어느 모델이 어떤 미션에 강한지)
//   2. 코드 변경 후 성능 회귀/개선 측정 (baseline.json 비교)
//   3. 에이전트 전체 점수 추적
//
// ▌미션 구성  (총 ~60점 만점, suite별 세분화)
//   Suite C — Code Generation  (HumanEval-style, 실제 실행 검증)
//   Suite R — Reasoning        (로직·분석·수학 추론)
//   Suite A — Agent / Tool use (파일·codegraph 도구 사용)
//
// ▌난이도  1(trivial) → 5(expert)
//   각 suite 내에서 난이도를 고르게 분포.
//
// ▌평가 방식
//   Suite C : LLM이 생성한 코드를 Node Function()으로 실행, test case 통과 수
//   Suite R : 패턴 매칭 + (선택) LLM judge
//   Suite A : 도구 호출 수 + 답변 패턴
//
// ▌보고서
//   실행 후 자동으로 .agents/progress/coding-bench-YYYY-MM-DD.md 와
//   .agents/progress/coding-bench-latest.json 에 저장.
//   previous run(coding-bench-latest.json)이 있으면 delta 자동 계산.
//
// ─── 실행 ──────────────────────────────────────────────────────────────────
// # 24g naia-coding (내부 개발 기준):
//   CODING_BENCH_LIVE=1 OPENAI_API_KEY=naia \
//   OPENAI_BASE_URL=http://100.91.187.24:8000/v1 OPENAI_MODEL=naia-coding \
//   pnpm --filter @nextain/agent-runtime exec vitest run coding-bench
//
// # Gemini 2.5 Flash:
//   CODING_BENCH_LIVE=1 GEMINI_API_KEY=<key> [GEMINI_MODEL=gemini-2.5-flash] \
//   pnpm --filter @nextain/agent-runtime exec vitest run coding-bench
//
// # GLM 4.7 / 5.x Flash:
//   CODING_BENCH_LIVE=1 GLM_API_KEY=<key> GLM_MODEL=glm-4.7-flash \
//   pnpm --filter @nextain/agent-runtime exec vitest run coding-bench
//
// # 비용 단가 직접 지정 (USD/1M tok):
//   BENCH_PRICE_IN=0.075 BENCH_PRICE_OUT=0.30 CODING_BENCH_LIVE=1 ...

import { describe, it, expect, afterAll } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  InMemoryToolExecutor,
  createListFilesSkill,
  createReadFileSkill,
  createTimeSkill,
} from "../index.js";
import type {
  ToolExecutor,
} from "@nextain/agent-types";

// ─── Types ────────────────────────────────────────────────────────────────

type Suite = "C" | "R" | "A";
type Difficulty = 1 | 2 | 3 | 4 | 5;

interface TestCase { args: unknown[]; expected: unknown }

interface BenchTask {
  id: string;
  suite: Suite;
  difficulty: Difficulty;
  name: string;
  prompt: string;
  /** Suite C: function name + test cases for execution eval */
  funcName?: string;
  testCases?: TestCase[];
  /** Suite R/A: regex patterns */
  patterns?: Array<{ re: RegExp; label: string }>;
  /** Suite A: expected minimum tool calls */
  minToolCalls?: number;
}

interface TaskResult {
  taskId: string;
  suite: Suite;
  difficulty: Difficulty;
  name: string;
  score: number;       // 0.0 – 1.0
  rawScore: number;    // passed test cases or matched patterns
  maxScore: number;    // total test cases or patterns
  llmTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  execError?: string;  // code execution error (Suite C)
}

interface BenchRunReport {
  model: string;
  date: string;
  totalScore: number;      // 0.0–1.0
  suiteScores: Record<Suite, number>;
  tasks: TaskResult[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  estimatedCostUSD: number;
}

// ─── Code execution (Suite C) ─────────────────────────────────────────────

/** Very lightweight TypeScript → JS stripper for Function() eval. */
function stripTS(code: string): string {
  return code
    // remove interface / type alias blocks
    .replace(/^(export\s+)?(interface|type)\s+\w[\s\S]*?(?=\n\n|\nfunction|\nclass|\nconst|\nlet|\nvar|$)/gm, "")
    // remove inline type annotations  :Type, : Type[], : Record<…>
    .replace(/\s*:\s*[A-Za-z_$][A-Za-z_$0-9<>\[\]|&,\s?!.{}()'"`]*(?=[,);={}\n])/g, "")
    // remove generic calls  fn<T>(  → fn(
    .replace(/<[A-Za-z_$][A-Za-z_$0-9<>\[\]|&,\s?!.{}()'"`]*>\s*\(/g, "(")
    // remove export / declare
    .replace(/^export\s+(default\s+)?/gm, "")
    .replace(/^declare\s+.+/gm, "");
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function extractCode(response: string): string {
  const m = response.match(/```(?:typescript|ts|javascript|js|)\n?([\s\S]*?)```/);
  return m ? m[1]!.trim() : response.trim();
}

function runCodeTest(code: string, funcName: string, tc: TestCase): { pass: boolean; error?: string } {
  const argsJson = tc.args.map((a) => JSON.stringify(a)).join(", ");
  const tryRun = (src: string): { pass: boolean; error?: string } => {
    try {
      // eslint-disable-next-line no-new-func
      const result = new Function(`${src}\n; return ${funcName}(${argsJson});`)();
      return { pass: deepEq(result, tc.expected) };
    } catch (e) {
      const msg = String(e).split("\n")[0];
      return { pass: false, ...(msg !== undefined ? { error: msg } : {}) };
    }
  };
  // 1. Try raw (model asked for JS, this should usually work)
  const raw = tryRun(code);
  if (raw.pass || !raw.error?.includes("SyntaxError")) return raw;
  // 2. Fallback: strip TypeScript annotations
  const stripped = tryRun(stripTS(code));
  return stripped.pass ? stripped : raw; // report original error if both fail
}

// ─── Pricing ──────────────────────────────────────────────────────────────

// USD per 1M tokens. Sources:
//   - Gemini:  https://ai.google.dev/gemini-api/docs/pricing  (Google AI Studio)
//   - GLM:     https://docs.z.ai/guides/overview/pricing       (pay-as-you-go)
//
// GLM via the z.ai coding plan (subscription, default endpoint of GLM_BASE_URL)
// is FLAT-RATE — per-token cost is $0 marginal up to the plan's monthly cap.
// The figures below are the standalone pay-as-you-go reference so the report
// still produces a comparable per-1M-tok cost when no subscription is in play.
// Use BENCH_PRICE_IN / BENCH_PRICE_OUT env to override on a per-run basis.
const PRICE_TABLE: Record<string, { in: number; out: number }> = {
  // Anthropic Claude (subscription via Pro/Max — flat-rate, marginal $0 up to plan cap).
  // The figures below are the pay-as-you-go API reference per Anthropic's pricing page.
  "claude-sonnet-4.5":       { in: 3.00, out: 15.00 },
  "claude-haiku-4.5":        { in: 0.80, out: 4.00 },
  "claude-opus-4.5":         { in: 15.00, out: 75.00 },
  "claude-sonnet-4":         { in: 3.00, out: 15.00 },
  "claude-haiku-4":          { in: 0.25, out: 1.25 },
  "sonnet":                  { in: 3.00, out: 15.00 },
  "haiku":                   { in: 0.80, out: 4.00 },
  "opus":                    { in: 15.00, out: 75.00 },
  // Gemini Flash family
  "gemini-3.5-flash":        { in: 1.50, out: 9.00 },
  "gemini-3-flash-preview":  { in: 0.50, out: 3.00 },
  "gemini-3.1-flash-lite":   { in: 0.25, out: 1.50 },
  "gemini-2.5-flash":        { in: 0.30, out: 2.50 },
  "gemini-2.0-flash":        { in: 0.10, out: 0.40 },
  "gemini-1.5-flash":        { in: 0.075, out: 0.30 },
  "gemini-flash-lite":       { in: 0.019, out: 0.075 }, // legacy fallback key
  // GLM family (Z.AI pay-as-you-go; coding plan = flat-rate, $0 marginal)
  "glm-5.1":                 { in: 1.40, out: 4.40 },
  "glm-5-turbo":             { in: 1.20, out: 4.00 },
  "glm-5":                   { in: 1.00, out: 3.20 },
  "glm-4.7":                 { in: 0.60, out: 2.20 },
  "glm-4.6":                 { in: 0.60, out: 2.20 },
  "glm-4.5-air":             { in: 0.20, out: 1.10 },
  "glm-4.5":                 { in: 0.60, out: 2.20 },
};

function getPrice(model: string) {
  const envIn  = parseFloat(process.env["BENCH_PRICE_IN"]  ?? "");
  const envOut = parseFloat(process.env["BENCH_PRICE_OUT"] ?? "");
  if (!isNaN(envIn) && !isNaN(envOut)) return { in: envIn, out: envOut };
  for (const [key, val] of Object.entries(PRICE_TABLE)) {
    if (model.toLowerCase().includes(key)) return val;
  }
  return { in: 0, out: 0 }; // local / unknown
}

function calcCost(inTok: number, outTok: number, price: { in: number; out: number }) {
  return (inTok / 1e6) * price.in + (outTok / 1e6) * price.out;
}

// ─── Task definitions ──────────────────────────────────────────────────────
//
// Suite C — Code Generation (HumanEval-adapted, executable)
// Suite R — Reasoning
// Suite A — Agent tool use
// ──────────────────────────────────────────────────────────────────────────

const TASKS: BenchTask[] = [

  // ────────────────────────────────────────────────────────────────────────
  // Suite C  L1 — trivial
  // ────────────────────────────────────────────────────────────────────────
  {
    id: "C-01",
    suite: "C",
    difficulty: 1,
    name: "sumArray",
    prompt:
      "Write a JavaScript/TypeScript function `sumArray(nums: number[]): number` " +
      "that returns the sum of all elements in the array.",
    funcName: "sumArray",
    testCases: [
      { args: [[1, 2, 3]],        expected: 6 },
      { args: [[0, -1, 5]],       expected: 4 },
      { args: [[]],               expected: 0 },
      { args: [[100]],            expected: 100 },
    ],
  },
  {
    id: "C-02",
    suite: "C",
    difficulty: 1,
    name: "reverseWords",
    prompt:
      "Write `reverseWords(s: string): string` that reverses the order of words " +
      "in a space-separated string. Extra spaces between words should be collapsed to one.",
    funcName: "reverseWords",
    testCases: [
      { args: ["hello world"],        expected: "world hello" },
      { args: ["the sky is blue"],    expected: "blue is sky the" },
      { args: ["  hello   world  "],  expected: "world hello" },
      { args: ["a"],                  expected: "a" },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // Suite C  L2 — easy
  // ────────────────────────────────────────────────────────────────────────
  {
    id: "C-03",
    suite: "C",
    difficulty: 2,
    name: "isPrime",
    prompt:
      "Write `isPrime(n: number): boolean` that returns true if n is a prime number. " +
      "Handle edge cases: n < 2 returns false.",
    funcName: "isPrime",
    testCases: [
      { args: [2],   expected: true  },
      { args: [3],   expected: true  },
      { args: [4],   expected: false },
      { args: [17],  expected: true  },
      { args: [1],   expected: false },
      { args: [0],   expected: false },
      { args: [97],  expected: true  },
      { args: [100], expected: false },
    ],
  },
  {
    id: "C-04",
    suite: "C",
    difficulty: 2,
    name: "twoSum",
    prompt:
      "Write `twoSum(nums: number[], target: number): [number, number]` " +
      "that returns the indices of the two numbers that add up to target. " +
      "Exactly one solution exists. Result must be `[smallerIndex, largerIndex]`.",
    funcName: "twoSum",
    testCases: [
      { args: [[2, 7, 11, 15], 9],    expected: [0, 1] },
      { args: [[3, 2, 4], 6],         expected: [1, 2] },
      { args: [[3, 3], 6],            expected: [0, 1] },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // Suite C  L3 — medium (LeetCode medium level)
  // ────────────────────────────────────────────────────────────────────────
  {
    id: "C-05",
    suite: "C",
    difficulty: 3,
    name: "isValidParens",
    prompt:
      "Write `isValidParens(s: string): boolean` that returns true if the string " +
      "of brackets `()[]{}` is valid (properly opened and closed in order).",
    funcName: "isValidParens",
    testCases: [
      { args: ["()"],     expected: true  },
      { args: ["()[]{}"], expected: true  },
      { args: ["(]"],     expected: false },
      { args: ["([)]"],   expected: false },
      { args: ["{[]}"],   expected: true  },
      { args: [""],       expected: true  },
      { args: ["]"],      expected: false },
    ],
  },
  {
    id: "C-06",
    suite: "C",
    difficulty: 3,
    name: "maxSubarraySum",
    prompt:
      "Write `maxSubarraySum(nums: number[]): number` that returns the maximum sum " +
      "of a contiguous subarray (Kadane's algorithm). Array has at least one element.",
    funcName: "maxSubarraySum",
    testCases: [
      { args: [[-2, 1, -3, 4, -1, 2, 1, -5, 4]],  expected: 6 },
      { args: [[1]],                                expected: 1 },
      { args: [[5, 4, -1, 7, 8]],                  expected: 23 },
      { args: [[-1, -2, -3]],                       expected: -1 },
    ],
  },
  {
    id: "C-07",
    suite: "C",
    difficulty: 3,
    name: "longestCommonPrefix",
    prompt:
      "Write `longestCommonPrefix(strs: string[]): string` that returns the longest " +
      "common prefix string among an array of strings. Returns '' if none.",
    funcName: "longestCommonPrefix",
    testCases: [
      { args: [["flower", "flow", "flight"]],  expected: "fl" },
      { args: [["dog", "racecar", "car"]],     expected: "" },
      { args: [["interview", "intercom"]],     expected: "inter" },
      { args: [["a"]],                         expected: "a" },
      { args: [[" ", " "]],                    expected: " " },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // Suite C  L4 — hard
  // ────────────────────────────────────────────────────────────────────────
  {
    id: "C-08",
    suite: "C",
    difficulty: 4,
    name: "mergeIntervals",
    prompt:
      "Write `mergeIntervals(intervals: [number,number][]): [number,number][]` " +
      "that merges all overlapping intervals and returns the result sorted by start.",
    funcName: "mergeIntervals",
    testCases: [
      { args: [[[1,3],[2,6],[8,10],[15,18]]],  expected: [[1,6],[8,10],[15,18]] },
      { args: [[[1,4],[4,5]]],                 expected: [[1,5]] },
      { args: [[[1,4],[2,3]]],                 expected: [[1,4]] },
      { args: [[[1,2]]],                       expected: [[1,2]] },
    ],
  },
  {
    id: "C-09",
    suite: "C",
    difficulty: 4,
    name: "climbStairs",
    prompt:
      "Write `climbStairs(n: number): number` — you can climb 1 or 2 steps at a time. " +
      "How many distinct ways to reach step n? (Dynamic programming or memoization.)",
    funcName: "climbStairs",
    testCases: [
      { args: [1],  expected: 1 },
      { args: [2],  expected: 2 },
      { args: [3],  expected: 3 },
      { args: [5],  expected: 8 },
      { args: [10], expected: 89 },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // Suite C  L5 — expert
  // ────────────────────────────────────────────────────────────────────────
  {
    id: "C-10",
    suite: "C",
    difficulty: 5,
    name: "LFU Cache",
    prompt:
      "Implement `LFUCache` class in TypeScript:\n" +
      "  constructor(capacity: number)\n" +
      "  get(key: number): number           // -1 if not found\n" +
      "  put(key: number, value: number): void  // evict LFU (ties → LRU) on overflow\n\n" +
      "O(1) get and put required. capacity > 0.",
    funcName: "LFUCache",
    testCases: [
      {
        args: [["new", 2, ["put",1,1],["put",2,2],["get",1],["put",3,3],["get",2],["get",3],["get",1]]],
        expected: "init:ok,put:ok,put:ok,get:1,put:ok,get:-1,get:3,get:1",
      },
    ],
    // Custom runner — override via special convention
  },

  // ────────────────────────────────────────────────────────────────────────
  // Suite R — Reasoning
  // ────────────────────────────────────────────────────────────────────────
  {
    id: "R-01",
    suite: "R",
    difficulty: 2,
    name: "런타임 오류 원인 설명",
    prompt:
      "다음 TypeScript 코드를 실행하면 무슨 에러가 발생하고 왜인지 한 문장으로 설명해줘:\n" +
      "```typescript\n" +
      "const obj: Record<string, number> = {};\n" +
      "console.log(obj.foo.toFixed(2));\n" +
      "```",
    patterns: [
      { re: /undefined|null|TypeError/i,    label: "TypeError 언급" },
      { re: /undefined.*toFixed|toFixed.*undefined|property.*undefined/i, label: "undefined에 toFixed 호출" },
    ],
  },
  {
    id: "R-02",
    suite: "R",
    difficulty: 2,
    name: "Big-O 분석",
    prompt:
      "다음 함수의 시간복잡도를 Big-O로 표기하고 이유를 한 줄로 설명해줘:\n" +
      "```typescript\n" +
      "function findDuplicate(arr: number[]): number | null {\n" +
      "  const seen = new Set<number>();\n" +
      "  for (const n of arr) {\n" +
      "    if (seen.has(n)) return n;\n" +
      "    seen.add(n);\n" +
      "  }\n" +
      "  return null;\n" +
      "}\n" +
      "```",
    patterns: [
      { re: /O\s*\(\s*n\s*\)/i,              label: "O(n) 명시" },
      { re: /linear|선형|한\s*번|once|single pass/i, label: "선형 순회 이유 설명" },
    ],
  },
  {
    id: "R-03",
    suite: "R",
    difficulty: 3,
    name: "코드 출력 예측",
    prompt:
      "아래 코드가 출력하는 값을 정확히 예측해줘 (숫자만):\n" +
      "```typescript\n" +
      "const arr = [1, 2, 3, 4, 5];\n" +
      "const result = arr\n" +
      "  .filter(n => n % 2 === 0)\n" +
      "  .map(n => n * n)\n" +
      "  .reduce((acc, n) => acc + n, 0);\n" +
      "console.log(result);\n" +
      "```",
    patterns: [
      { re: /\b20\b/, label: "정답 20" },
    ],
  },
  {
    id: "R-04",
    suite: "R",
    difficulty: 3,
    name: "버그 찾기",
    prompt:
      "아래 함수에서 버그를 찾아 수정된 코드를 제시해줘:\n" +
      "```typescript\n" +
      "function binarySearch(arr: number[], target: number): number {\n" +
      "  let left = 0, right = arr.length;\n" +
      "  while (left < right) {\n" +
      "    const mid = Math.floor((left + right) / 2);\n" +
      "    if (arr[mid] === target) return mid;\n" +
      "    if (arr[mid] < target) left = mid;\n" +
      "    else right = mid;\n" +
      "  }\n" +
      "  return -1;\n" +
      "}\n" +
      "```",
    patterns: [
      { re: /left\s*=\s*mid\s*\+\s*1|mid\s*\+\s*1.*left/i, label: "left = mid + 1 수정" },
      { re: /right.*length.*-.*1|arr\.length\s*-\s*1/i,     label: "right = arr.length - 1 수정" },
    ],
  },
  {
    id: "R-05",
    suite: "R",
    difficulty: 4,
    name: "설계 트레이드오프 분석",
    prompt:
      "naia-agent에서 tool executor를 CompositeToolExecutor로 합성하는 방식 vs " +
      "단일 InMemoryToolExecutor에 모든 tool을 직접 등록하는 방식의 " +
      "트레이드오프를 기술적 관점에서 3가지 이상 비교해줘.",
    patterns: [
      { re: /namespace|이름.*충돌|name.*collision|격리|isolation/i, label: "네임스페이스/격리" },
      { re: /dynamic|동적|런타임|hot.?swap|plug/i,                  label: "동적 등록" },
      { re: /라우팅|routing|dispatch|overhead/i,                    label: "라우팅 오버헤드" },
    ],
  },
  {
    id: "R-06",
    suite: "R",
    difficulty: 5,
    name: "시스템 설계 (메모리 시스템)",
    prompt:
      "LLM 에이전트의 장기 메모리를 위한 벡터 DB + 요약 기반 계층형 메모리 시스템을 설계해줘. " +
      "저장/검색 흐름, 망각 정책, 신선도(staleness) 관리 방법을 포함해야 해. " +
      "naia-memory 같은 실 구현 관점에서 작성.",
    patterns: [
      { re: /embed|vector|벡터/i,                           label: "벡터 검색 언급" },
      { re: /summary|요약|compress/i,                       label: "요약/압축 언급" },
      { re: /ttl|expire|stale|fresh|망각|forgetting/i,      label: "망각/TTL 정책" },
      { re: /tier|계층|hot.*cold|warm|short.*long|episodic/i, label: "계층형 구조" },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // Suite A — Agent / Tool use
  // ────────────────────────────────────────────────────────────────────────
  {
    id: "A-01",
    suite: "A",
    difficulty: 3,
    name: "파일 구조 탐색",
    prompt:
      "naia-agent 런타임 패키지의 src/skills/ 디렉토리에 있는 파일 목록을 모두 나열하고, " +
      "각 파일이 어떤 역할을 하는지 한 줄로 설명해줘. " +
      "반드시 실제 파일을 읽어서 답해.",
    patterns: [
      { re: /codegraph|bash|time|file/i, label: "실제 skill 이름 등장" },
      { re: /index\.ts|index\.js/i,      label: "index 파일 언급" },
    ],
    minToolCalls: 1,
  },
  {
    id: "A-02",
    suite: "A",
    difficulty: 3,
    name: "함수 정의 위치 찾기",
    prompt:
      "naia-agent 소스에서 `createHost` 함수가 어느 파일의 몇 번째 줄에 정의되어 있는지 찾아줘. " +
      "파일을 직접 읽어서 확인해.",
    patterns: [
      { re: /create-host|createHost/i,                    label: "파일명/함수명 정확" },
      { re: /\d{1,4}(?:\s*번째?\s*줄|:\d{1,4}|line\s*\d)/i, label: "줄 번호 포함" },
    ],
    minToolCalls: 1,
  },
  {
    id: "A-03",
    suite: "A",
    difficulty: 4,
    name: "다중 파일 추적",
    prompt:
      "naia-agent CLI (`bin/naia-agent.ts`)에서 `--enable-codegraph` 플래그가 파싱되면 " +
      "codegraph MCP 서버가 연결되기까지의 코드 흐름을 " +
      "파일명과 함수명을 포함해 단계별로 설명해줘. 코드를 직접 읽어서 확인해.",
    patterns: [
      { re: /bin.*naia-agent|naia-agent\.ts/i,   label: "bin 파일 언급" },
      { re: /createCodeGraphExecutor/i,           label: "createCodeGraphExecutor 언급" },
      { re: /MCPClient|mcp.*client/i,             label: "MCPClient 언급" },
    ],
    minToolCalls: 2,
  },
  {
    id: "A-04",
    suite: "A",
    difficulty: 4,
    name: "변경 영향 분석",
    prompt:
      "CompositeToolExecutor의 list() 메서드 시그니처를 변경한다면 " +
      "어떤 파일들이 영향을 받는지 소스를 직접 읽어서 분석해줘. " +
      "최소 3개 파일과 각 파일에서의 변경 포인트를 구체적으로 알려줘.",
    patterns: [
      { re: /composite.?tool.?executor/i,   label: "CompositeToolExecutor 파일" },
      { re: /test|spec/i,                   label: "테스트 파일 영향 언급" },
      { re: /interface|type.*ToolExecutor/i, label: "인터페이스 변경 언급" },
    ],
    minToolCalls: 2,
  },
  {
    id: "A-05",
    suite: "A",
    difficulty: 5,
    name: "신규 기능 구현 계획",
    prompt:
      "naia-agent에 `--enable-memory-export <path>` 플래그를 추가하려 해. " +
      "에이전트 종료 시 대화 메모리를 JSON 파일로 내보내는 기능이야. " +
      "소스를 읽어서 수정이 필요한 파일, 수정 위치, 구현 방법을 단계별로 계획해줘.",
    patterns: [
      { re: /bin.*naia-agent|naia-agent\.ts/i,   label: "bin 파일 수정 언급" },
      { re: /memory|MemoryProvider/i,            label: "메모리 관련 코드 언급" },
      { re: /json|writeFile|fs\.|export/i,       label: "파일 출력 방법 언급" },
    ],
    minToolCalls: 2,
  },
];

// ─── Scoring ───────────────────────────────────────────────────────────────

/** Suite C: execute all test cases. LFU cache handled separately. */
function scoreSuiteC(task: BenchTask, response: string): { raw: number; max: number; execError?: string } {
  if (!task.testCases || !task.funcName) return { raw: 0, max: 0 };

  // Special case: LFU Cache — pattern-based fallback
  if (task.id === "C-10") {
    const code = extractCode(response);
    const patterns = [
      /class\s+LFUCache/i,
      /get\s*\(/i,
      /put\s*\(/i,
      /frequency|freq|count/i,
      /Map|min.*freq|lru/i,
    ];
    const matched = patterns.filter((p) => p.test(code)).length;
    return { raw: matched, max: patterns.length };
  }

  const code = extractCode(response);
  let passed = 0;
  let lastError: string | undefined;
  for (const tc of task.testCases) {
    const { pass, error } = runCodeTest(code, task.funcName, tc);
    if (pass) passed++;
    else if (error) lastError = error;
  }
  return { raw: passed, max: task.testCases.length, ...(lastError !== undefined ? { execError: lastError } : {}) };
}

function scoreSuiteR(task: BenchTask, response: string): { raw: number; max: number } {
  if (!task.patterns) return { raw: 0, max: 0 };
  const matched = task.patterns.filter(({ re }) => re.test(response)).length;
  return { raw: matched, max: task.patterns.length };
}

function scoreSuiteA(
  task: BenchTask,
  response: string,
  toolCalls: number,
): { raw: number; max: number } {
  const patternScore = task.patterns
    ? task.patterns.filter(({ re }) => re.test(response)).length
    : 0;
  const patternMax  = task.patterns?.length ?? 0;
  const toolBonus   = task.minToolCalls && toolCalls >= task.minToolCalls ? 1 : 0;
  const toolMax     = task.minToolCalls ? 1 : 0;
  return { raw: patternScore + toolBonus, max: patternMax + toolMax };
}

// ─── Section A: evaluator unit tests (CI, no LLM) ─────────────────────────

describe("Section A — bench evaluator (CI)", () => {
  it("BM-A1: task list well-formed", () => {
    const suiteC = TASKS.filter((t) => t.suite === "C");
    const suiteR = TASKS.filter((t) => t.suite === "R");
    const suiteA = TASKS.filter((t) => t.suite === "A");
    expect(suiteC.length).toBeGreaterThanOrEqual(8);
    expect(suiteR.length).toBeGreaterThanOrEqual(4);
    expect(suiteA.length).toBeGreaterThanOrEqual(4);
    for (const t of TASKS) {
      expect(t.id).toBeTruthy();
      expect(t.prompt.length).toBeGreaterThan(20);
    }
  });

  it("BM-A2: stripTS removes type annotations", () => {
    const ts = "function add(a: number, b: number): number { return a + b; }";
    const js = stripTS(ts);
    // eslint-disable-next-line no-new-func
    expect(() => new Function(`${js}\n; return add(1,2);`)()).not.toThrow();
  });

  it("BM-A3: runCodeTest executes generated code", () => {
    const code = "function sumArray(nums) { return nums.reduce((a,b)=>a+b,0); }";
    const { pass } = runCodeTest(code, "sumArray", { args: [[1, 2, 3]], expected: 6 });
    expect(pass).toBe(true);
    const { pass: p2 } = runCodeTest(code, "sumArray", { args: [[]], expected: 0 });
    expect(p2).toBe(true);
  });

  it("BM-A4: deepEq handles nested structures", () => {
    expect(deepEq([[1,3],[2,4]], [[1,3],[2,4]])).toBe(true);
    expect(deepEq([[1,3]], [[1,4]])).toBe(false);
    expect(deepEq(null, null)).toBe(true);
    expect(deepEq({a:1}, {a:1})).toBe(true);
  });

  it("BM-A5: difficulty distribution", () => {
    const diffs = TASKS.map((t) => t.difficulty);
    expect(diffs.filter((d) => d <= 2).length).toBeGreaterThanOrEqual(3);
    expect(diffs.filter((d) => d >= 4).length).toBeGreaterThanOrEqual(4);
  });
});

// ─── Section B: LIVE LLM benchmark ────────────────────────────────────────

const LIVE = process.env["CODING_BENCH_LIVE"] === "1";
const NAIA_AGENT_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const PROGRESS_DIR    = join(NAIA_AGENT_ROOT, ".agents", "progress");

// Module-level result accumulator — populated across both test cases, flushed in afterAll
const _allResults: TaskResult[] = [];
let _modelName = "unknown";

describe.skipIf(!LIVE)(
  "Section B — LIVE agent benchmark (CODING_BENCH_LIVE=1)",
  { timeout: 900_000 },
  () => {
    async function buildLLM(opts: {
      toolChoice?: "auto" | "none" | "required";
      temperature?: number;
    } = {}): Promise<{ llm: import("@nextain/agent-types").LLMClient; model: string }> {
      const { VercelClient } = await import("@nextain/agent-providers");
      const env = process.env;
      const isLocal24g = !!env["OPENAI_BASE_URL"]?.includes("100.91.187.24");

      // Claude Code (Pro/Max subscription, no API key — OAuth via local `claude` CLI).
      // Opt-in via NAIA_AGENT_CLAUDECODE_LIVE=1 to protect subscription credit.
      if (env["NAIA_AGENT_CLAUDECODE_LIVE"] === "1" || env["CLAUDE_CODE_LIVE"] === "1") {
        const { createClaudeCode } = await import("ai-sdk-provider-claude-code");
        const model = env["CLAUDE_CODE_MODEL"] ?? "sonnet";
        const cc = createClaudeCode();
        console.log(`[bench] Claude Code subscription model=${model}`);
        return { llm: new VercelClient(cc(model), {
          ...(opts.toolChoice   !== undefined ? { defaultToolChoice:   opts.toolChoice   } : {}),
          ...(opts.temperature  !== undefined ? { defaultTemperature:  opts.temperature  } : {}),
        }), model: `claude-code:${model}` };
      }
      if (env["GEMINI_API_KEY"]) {
        const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
        const model = env["GEMINI_MODEL"] ?? "gemini-2.5-flash";
        const g = createGoogleGenerativeAI({ apiKey: env["GEMINI_API_KEY"] });
        console.log(`[bench] Gemini model=${model}`);
        return { llm: new VercelClient(g(model), {
          ...(opts.toolChoice   !== undefined ? { defaultToolChoice:   opts.toolChoice   } : {}),
          ...(opts.temperature  !== undefined ? { defaultTemperature:  opts.temperature  } : {}),
        }), model: `gemini:${model}` };
      }
      if (env["GLM_API_KEY"]) {
        const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
        const model = env["GLM_MODEL"] ?? "glm-4.7";
        const p = createOpenAICompatible({
          name: "glm",
          // z.ai coding plan endpoint (paid plan, separate from BIGMODEL pay-as-you-go).
          baseURL: env["GLM_BASE_URL"] ?? "https://api.z.ai/api/coding/paas/v4",
          apiKey: env["GLM_API_KEY"],
        });
        console.log(`[bench] GLM model=${model}`);
        return { llm: new VercelClient(p.chatModel(model), {
          ...(opts.toolChoice   !== undefined ? { defaultToolChoice:   opts.toolChoice   } : {}),
          ...(opts.temperature  !== undefined ? { defaultTemperature:  opts.temperature  } : {}),
        }), model: `glm:${model}` };
      }
      if (env["OPENAI_API_KEY"] && env["OPENAI_BASE_URL"]) {
        const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
        const model = env["OPENAI_MODEL"] ?? "local-model";
        const p = createOpenAICompatible({
          name: "local",
          baseURL: env["OPENAI_BASE_URL"],
          apiKey: env["OPENAI_API_KEY"],
        });
        console.log(`[bench] vLLM model=${model} base=${env["OPENAI_BASE_URL"]}`);
        return {
          llm: new VercelClient(p.chatModel(model), {
            ...(isLocal24g        ? { defaultMaxTokens:   2048             } : {}),
            ...(opts.toolChoice   !== undefined ? { defaultToolChoice:   opts.toolChoice   } : {}),
            ...(opts.temperature  !== undefined ? { defaultTemperature:  opts.temperature  } : {}),
          }),
          model: `vllm:${model}`,
        };
      }
      throw new Error("provider 미설정: GEMINI_API_KEY / GLM_API_KEY / OPENAI_API_KEY+OPENAI_BASE_URL 필요");
    }

    async function runTask(
      task: BenchTask,
      llm: import("@nextain/agent-types").LLMClient,
      toolExecutor?: ToolExecutor,
      _attempt = 0,
      agentOpts: { forceTextOnLastHop?: boolean } = {},
    ): Promise<TaskResult> {
      const { Agent }      = await import("@nextain/agent-core");
      const { createHost } = await import("../host/create-host.js");

      const noOpTools = new InMemoryToolExecutor([createTimeSkill()]);
      const tools     = toolExecutor ?? noOpTools;
      const host      = createHost({ logLevel: "warn", llm, tools });

      const systemPrompt =
        task.suite === "C"
          // Ask for plain JS — avoids TypeScript type-stripping fragility in eval
          ? "You are an expert programmer. Write the solution as plain JavaScript (ES2022, no TypeScript types). " +
            "Output ONLY the function(s) inside a ```javascript code block. No imports, no exports, no explanation before the code."
          : task.suite === "A"
          ? "You are a code navigation assistant. " +
            "You MUST use the provided tools to inspect the codebase. Do not answer from memory.\n" +
            "Always start by calling list_files to explore directories, then read_file to read specific files.\n" +
            "Example: to find a function, first call list_files({\"path\":\"src\"}), then read_file({\"path\":\"src/foo.ts\"}).\n" +
            "Never answer without first calling at least one tool."
          : "You are a precise technical analyst. Think step by step and be concise.";

      // appendDefaultSystemPrompt=false: Trust/Work 룰 제외 → 4096 토큰 절약
      // CODING_BENCH_MAX_HOPS env override (default 30 for local reasoning models)
      const agent = new Agent({
        host,
        tierForTool: () => "T0",
        systemPrompt,
        appendDefaultSystemPrompt: false,
        maxToolHops: Number(process.env.CODING_BENCH_MAX_HOPS ?? 30),
        ...agentOpts,
      });

      let llmTurns = 0, toolCalls = 0, inputTokens = 0, outputTokens = 0;
      let answer = "";
      const t0 = performance.now();

      try {
        for await (const ev of agent.sendStream(task.prompt)) {
          if (ev.type === "turn.started")  llmTurns++;
          if (ev.type === "tool.started")  toolCalls++;
          if (ev.type === "usage") {
            inputTokens  += ev.usage.inputTokens  ?? 0;
            outputTokens += ev.usage.outputTokens ?? 0;
          }
          if (ev.type === "turn.ended")    answer = ev.assistantText;
        }
      } catch (err: unknown) {
        // vLLM sometimes drops the connection mid-stream; retry once with 3s delay
        agent.close();
        if (_attempt < 1 && String(err).includes("other side closed")) {
          console.warn(`  [retry] ${task.id} connection dropped, retrying...`);
          await new Promise((r) => setTimeout(r, 3000));
          return runTask(task, llm, toolExecutor, _attempt + 1);
        }
        throw err;
      }

      agent.close();
      const durationMs = performance.now() - t0;

      let raw = 0, max = 0, execError: string | undefined;
      if (task.suite === "C") {
        const r = scoreSuiteC(task, answer);
        raw = r.raw; max = r.max; execError = r.execError;
      } else if (task.suite === "R") {
        ({ raw, max } = scoreSuiteR(task, answer));
      } else {
        ({ raw, max } = scoreSuiteA(task, answer, toolCalls));
      }

      const result: TaskResult = {
        taskId: task.id,
        suite: task.suite,
        difficulty: task.difficulty,
        name: task.name,
        score: max > 0 ? raw / max : 0,
        rawScore: raw,
        maxScore: max,
        llmTurns,
        toolCalls,
        inputTokens,
        outputTokens,
        durationMs,
        ...(execError !== undefined ? { execError } : {}),
      };
      _allResults.push(result);
      return result;
    }

    // ── B1: Suite C + R (pure generation) ──────────────────────────────
    it("BM-B1: Suite C (code gen) + Suite R (reasoning) — no tools", async () => {
      const { llm, model } = await buildLLM();
      _modelName = model;

      const tasks = TASKS.filter((t) => t.suite === "C" || t.suite === "R");
      console.log(`\n## Suite C + R  [${model}]`);
      console.log("| ID | Diff | Name | Score | Raw | Time(s) |");
      console.log("|----|------|------|-------|-----|---------|");

      for (const task of tasks) {
        const r = await runTask(task, llm);
        const pct = Math.round(r.score * 100);
        const mark = pct === 100 ? "✓" : pct >= 50 ? "~" : "✗";
        console.log(
          `| ${r.taskId} | L${r.difficulty} | ${r.name.padEnd(30)} ` +
          `| ${mark} ${pct}% | ${r.rawScore}/${r.maxScore} | ${(r.durationMs/1000).toFixed(1)} |`,
        );
        if (r.execError) console.log(`  ⚠ exec: ${r.execError}`);
      }

      expect(_allResults.length).toBeGreaterThan(0);
    });

    // ── B2: Suite A (agent + tools) ────────────────────────────────────
    it("BM-B2: Suite A (agent + tool use)", async () => {
      // tool_choice=auto: real-world fair baseline (자율 tool 선택 능력 측정).
      // Prior "required" was a workaround for Gemma 4 4-bit AWQ's low spontaneous
      // tool-call rate; current lineup (Qwen3.6-27B etc.) doesn't need that crutch,
      // and "required" wasn't translating into Gemini's tool_config anyway, leaving
      // every Gemini Suite A run at 0 tasks. auto is what production traffic sees.
      // temperature=0.1 retained for instruction-following determinism.
      const { llm, model } = await buildLLM({ toolChoice: "auto", temperature: 0.1 });
      _modelName = model;

      // list_files + read_file 2개만 사용
      const readOnlyOps = new InMemoryToolExecutor([
        createListFilesSkill({ workspaceRoot: NAIA_AGENT_ROOT }),
        createReadFileSkill({ workspaceRoot: NAIA_AGENT_ROOT }),
      ]);

      const tasks = TASKS.filter((t) => t.suite === "A");
      console.log(`\n## Suite A — Agent Tool Use  [${model}]`);
      console.log("| ID | Diff | Name | Score | Tools | Turns | Time(s) |");
      console.log("|----|------|------|-------|-------|-------|---------|");

      for (const task of tasks) {
        const r = await runTask(task, llm, readOnlyOps, 0, { forceTextOnLastHop: true });
        const pct = Math.round(r.score * 100);
        const mark = pct === 100 ? "✓" : pct >= 50 ? "~" : "✗";
        console.log(
          `| ${r.taskId} | L${r.difficulty} | ${r.name.padEnd(30)} ` +
          `| ${mark} ${pct}% | ${r.toolCalls} | ${r.llmTurns} | ${(r.durationMs/1000).toFixed(1)} |`,
        );
      }

      expect(tasks.length).toBeGreaterThan(0);
    });

    // ── afterAll: write report ──────────────────────────────────────────
    afterAll(() => {
      if (_allResults.length === 0) return;

      const price = getPrice(_modelName);
      const totalIn  = _allResults.reduce((s, r) => s + r.inputTokens,  0);
      const totalOut = _allResults.reduce((s, r) => s + r.outputTokens, 0);
      const totalMs  = _allResults.reduce((s, r) => s + r.durationMs,   0);
      const costUSD  = calcCost(totalIn, totalOut, price);

      const suiteScore = (s: Suite) => {
        const rows = _allResults.filter((r) => r.suite === s);
        if (!rows.length) return null;
        const raw = rows.reduce((a, r) => a + r.rawScore,  0);
        const max = rows.reduce((a, r) => a + r.maxScore,  0);
        return { raw, max, pct: max > 0 ? Math.round(raw/max*100) : 0 };
      };

      const sc = suiteScore("C"), sr = suiteScore("R"), sa = suiteScore("A");
      const totalRaw = _allResults.reduce((a, r) => a + r.rawScore,  0);
      const totalMax = _allResults.reduce((a, r) => a + r.maxScore,  0);
      const totalPct = totalMax > 0 ? Math.round(totalRaw/totalMax*100) : 0;

      // ── Load previous run for delta ────────────────────────────────
      const latestPath = join(PROGRESS_DIR, "coding-bench-latest.json");
      let prevReport: BenchRunReport | null = null;
      if (existsSync(latestPath)) {
        try { prevReport = JSON.parse(readFileSync(latestPath, "utf8")); } catch { /* ignore */ }
      }
      const deltaStr = (cur: number, prev: number | undefined) => {
        if (prev === undefined) return "";
        const d = cur - prev;
        return d > 0 ? ` (+${d})` : d < 0 ? ` (${d})` : " (=)";
      };

      // ── Build Markdown report ──────────────────────────────────────
      const date = new Date().toISOString().slice(0, 10);
      const ts   = new Date().toISOString().replace("T", " ").slice(0, 19);

      let md = `# Coding Bench — ${ts}\n\n`;
      md += `**Model:** \`${_modelName}\`  \n`;
      md += `**Date:** ${date}  \n\n`;

      // Suite summary
      md += `## Overall Score\n\n`;
      md += `| Suite | Score | / Max | % |${prevReport ? " vs prev |" : ""}\n`;
      md += `|-------|-------|-------|---|${prevReport ? "---------|" : ""}\n`;
      if (sc) {
        const prev = prevReport?.suiteScores?.["C"];
        md += `| C — Code Gen  | ${sc.raw} | ${sc.max} | **${sc.pct}%** |${prevReport ? `${deltaStr(sc.pct, prev ? Math.round(prev*100) : undefined)} |` : ""}\n`;
      }
      if (sr) {
        const prev = prevReport?.suiteScores?.["R"];
        md += `| R — Reasoning | ${sr.raw} | ${sr.max} | **${sr.pct}%** |${prevReport ? `${deltaStr(sr.pct, prev ? Math.round(prev*100) : undefined)} |` : ""}\n`;
      }
      if (sa) {
        const prev = prevReport?.suiteScores?.["A"];
        md += `| A — Agent     | ${sa.raw} | ${sa.max} | **${sa.pct}%** |${prevReport ? `${deltaStr(sa.pct, prev ? Math.round(prev*100) : undefined)} |` : ""}\n`;
      }
      md += `| **Total** | **${totalRaw}** | **${totalMax}** | **${totalPct}%** |${prevReport ? `${deltaStr(totalPct, Math.round(prevReport.totalScore*100))} |` : ""}\n\n`;

      // Per-task table
      md += `## Per-task Results\n\n`;
      md += `| ID | Suite | Diff | Name | Score | Raw/Max | Turns | Tools | In tok | Out tok | Time(s) |\n`;
      md += `|----|-------|------|------|-------|---------|-------|-------|--------|---------|--------|\n`;
      for (const r of _allResults) {
        const pct = Math.round(r.score * 100);
        md += `| ${r.taskId} | ${r.suite} | L${r.difficulty} | ${r.name} ` +
              `| ${pct}% | ${r.rawScore}/${r.maxScore} ` +
              `| ${r.llmTurns} | ${r.toolCalls} ` +
              `| ${r.inputTokens.toLocaleString()} | ${r.outputTokens.toLocaleString()} ` +
              `| ${(r.durationMs/1000).toFixed(1)} |\n`;
      }

      // Cost summary
      md += `\n## Cost & Performance\n\n`;
      md += `| Metric | Value |\n|--------|-------|\n`;
      md += `| Total duration | ${(totalMs/1000).toFixed(1)}s |\n`;
      md += `| Input tokens   | ${totalIn.toLocaleString()} |\n`;
      md += `| Output tokens  | ${totalOut.toLocaleString()} |\n`;
      md += `| Pricing        | $${price.in}/M in, $${price.out}/M out |\n`;
      md += `| Estimated cost | $${costUSD.toFixed(5)} USD |\n`;

      // ── Write files ────────────────────────────────────────────────
      if (!existsSync(PROGRESS_DIR)) mkdirSync(PROGRESS_DIR, { recursive: true });

      const mdPath   = join(PROGRESS_DIR, `coding-bench-${date}.md`);
      writeFileSync(mdPath, md, "utf8");

      const report: BenchRunReport = {
        model: _modelName,
        date: ts,
        totalScore: totalMax > 0 ? totalRaw / totalMax : 0,
        suiteScores: {
          C: sc ? sc.raw / sc.max : 0,
          R: sr ? sr.raw / sr.max : 0,
          A: sa ? sa.raw / sa.max : 0,
        },
        tasks: _allResults,
        totalInputTokens: totalIn,
        totalOutputTokens: totalOut,
        totalDurationMs: totalMs,
        estimatedCostUSD: costUSD,
      };
      writeFileSync(latestPath, JSON.stringify(report, null, 2), "utf8");

      console.log(`\n✅ Report saved → ${mdPath}`);
      console.log(
        `   Total: ${totalRaw}/${totalMax} (${totalPct}%)` +
        (prevReport ? `  prev: ${Math.round(prevReport.totalScore*100)}%` : "") +
        `  cost: $${costUSD.toFixed(5)}`
      );
    });
  },
);
