#!/usr/bin/env node
// run-tool-selection-bench — UC-015(Issue #82) 도구선택 정확도 계측.
//
// 왜 있나: 2026-07-16~17 의 아키텍처 결정이 N=12(±25pp)·N=2 위에 서 있었고 재현조차 되지 않았다.
// "설명을 고쳤더니 나아졌다" 를 말하려면 **재현 가능한 계측 기반**이 먼저다. 이 러너가 그 기반이다.
//
// 계측 대상 = **프로덕션 실물**:
//   - 도구 스펙: dist 의 `CONTINUE_SPEAKING_TOOL` (복사본 아님 — 복사하면 설명을 고쳐도 계측이 안 따라옴)
//   - provider : dist 의 `makeOllamaProvider` (temperature 0.7 하드코딩 포함 — 실제 확률성 그대로 측정)
//
// 선행: pnpm build  (dist 생성)
// 실행:
//   node benchmark/run-tool-selection-bench.mjs                        # dev split, runs=5
//   TS_SPLIT=holdout TS_RUNS=5 node benchmark/run-tool-selection-bench.mjs
//   TS_DESC_FILE=./desc-b.txt node benchmark/run-tool-selection-bench.mjs   # 설명 A/B (B안)
// env: TS_SPLIT(dev|holdout|all) TS_RUNS TS_MODEL TS_HOST TS_DESC_FILE TS_OUT TS_LABEL
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTINUE_SPEAKING_TOOL } from "../dist/main/app/chat-turn-handler.js";
import { makeOllamaProvider } from "../dist/main/adapters/ollama-provider.js";

const _here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(_here, "corpora", "continue-speaking-ko.corpus.json");

const SPLIT = process.env.TS_SPLIT ?? "dev";
const RUNS = Math.max(1, Number(process.env.TS_RUNS ?? 5) | 0);
const MODEL = process.env.TS_MODEL ?? "dnotitia-dna3.0-9b-q4-16k:latest";
const HOST = process.env.TS_HOST ?? "http://127.0.0.1:11434";
const LABEL = process.env.TS_LABEL ?? (process.env.TS_DESC_FILE ? "variant" : "baseline");

// 설명 A/B: TS_DESC_FILE 이 있으면 그 내용으로 description 만 교체. 나머지(스키마·이름·파라미터)는 프로덕션 그대로.
const descOverride = process.env.TS_DESC_FILE ? readFileSync(resolve(process.env.TS_DESC_FILE), "utf8").trim() : null;
const TOOL = descOverride ? { ...CONTINUE_SPEAKING_TOOL, description: descOverride } : CONTINUE_SPEAKING_TOOL;

const corpus = JSON.parse(readFileSync(CORPUS, "utf8"));
const probes = corpus.probes.filter((p) => SPLIT === "all" || p.split === SPLIT);
if (probes.length === 0) { console.error(`no probes for split=${SPLIT}`); process.exit(1); }

// 홀드아웃 규율: 튜닝 중 열람 금지. 사람이 의도적으로 지정해야만 돈다.
// (codex T4-3 fix: "all" 도 holdout 프로브를 포함하므로 동일하게 잠근다 — 우회로 봉쇄)
if ((SPLIT === "holdout" || SPLIT === "all") && process.env.TS_HOLDOUT_ACK !== "1") {
  console.error("holdout(및 all)은 설명 튜닝이 끝난 뒤 단 한 번만 평가한다. 의도적 실행이면 TS_HOLDOUT_ACK=1 을 붙여라.");
  process.exit(2);
}

const provider = makeOllamaProvider();
const config = { provider: "ollama", model: MODEL, ollamaHost: HOST };

/** 프로브 1회 실행 → 도구를 호출했는지 + 호출했다면 quote. 프로덕션 provider 를 그대로 통과시킨다. */
async function runOnce(utterance) {
  const messages = [{ role: "user", content: utterance }];
  let called = false;
  let quote;
  let text = "";
  for await (const c of provider.chat(config, messages, { tools: [TOOL] })) {
    if (c.kind === "toolUse" && c.name === TOOL.name) {
      called = true;
      const a = c.args && typeof c.args === "object" ? c.args : {};
      quote = typeof a.userRequestQuote === "string" ? a.userRequestQuote : "";
    } else if (c.kind === "text") text += c.text;
  }
  return { called, quote, textLen: text.length };
}

// preflight: endpoint/모델 부재는 skip 이 아니라 **실패**다(계약 108행 정신 — 준비 실패를 조용히 넘기지 않는다).
try {
  const tags = await fetch(`${HOST}/api/tags`).then((r) => r.json());
  const names = (tags.models ?? []).map((m) => m.name);
  if (!names.includes(MODEL)) { console.error(`model not installed: ${MODEL}\ninstalled: ${names.join(", ")}`); process.exit(1); }
} catch (e) {
  console.error(`ollama endpoint unreachable: ${HOST} — ${e.message}`); process.exit(1);
}

console.error(`[${LABEL}] split=${SPLIT} probes=${probes.length} runs=${RUNS} model=${MODEL} desc=${descOverride ? "OVERRIDE" : "production"}`);

const results = [];
for (const p of probes) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try { runs.push(await runOnce(p.utterance)); }
    // codex T4-4 fix: provider 오류를 called:false 로 흡수하면 음성에선 false-call 을 낮추고
    // 양성에선 miss 를 높이는 비대칭 오염 → 오류는 표본에서 제외하고 별도 집계한다.
    catch (e) { runs.push({ error: e.message }); }
  }
  const valid = runs.filter((r) => !r.error);
  const calls = valid.filter((r) => r.called).length;
  const errors = runs.length - valid.length;
  results.push({ id: p.id, label: p.label, category: p.category ?? null, utterance: p.utterance, calls, valid: valid.length, errors, runs: RUNS, quotes: valid.filter((r) => r.called).map((r) => r.quote) });
  console.error(`  ${p.id} ${p.label.padEnd(9)} ${String(calls).padStart(2)}/${valid.length}${errors ? ` (err ${errors})` : ""}  ${p.utterance.slice(0, 34)}`);
}

// 코퍼스 단위 집계(유효 콜 단위) + 프로브 계층 평균(군집 보정 점추정).
const agg = (label) => {
  const rs = results.filter((r) => r.label === label);
  const total = rs.reduce((s, r) => s + r.valid, 0);
  const called = rs.reduce((s, r) => s + r.calls, 0);
  const errors = rs.reduce((s, r) => s + r.errors, 0);
  const perProbe = rs.filter((r) => r.valid > 0).map((r) => r.calls / r.valid);
  const probeMean = perProbe.length ? perProbe.reduce((a, b) => a + b, 0) / perProbe.length : null;
  return { probes: rs.length, calls: total, called, errors, rate: total ? called / total : null, probeMeanRate: probeMean };
};
const neg = agg("negative"), pos = agg("positive"), amb = agg("ambiguous");

// Wilson 95% CI — n 이 작을 때 정규근사(±1.96·SE)는 경계에서 거짓말한다. 수치에 CI 를 붙이는 것이 이 러너의 요점.
const wilson = (k, n) => {
  if (!n) return null;
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
};
const pct = (x) => x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
const ci = (k, n) => { const w = wilson(k, n); return w ? `[${pct(w[0])}, ${pct(w[1])}]` : "n/a"; };

const summary = {
  label: LABEL, split: SPLIT, runs: RUNS, model: MODEL,
  descriptionSource: descOverride ? (process.env.TS_DESC_FILE ?? "override") : "production",
  descriptionSha: null,
  // codex T4-4: 같은 프로브의 반복(temp 0.7)은 독립 Bernoulli 가 아니다(프로브별 난이도 군집).
  // 풀링 Wilson CI 는 실제보다 좁을 수 있음 → 설계 판정은 probeMeanRate(프로브 계층 평균)를 병행 참조.
  statsCaveat: "pooled Wilson CI 는 프로브 군집효과로 과소폭 가능. probeMeanRate 병행 참조. 오류 콜은 표본 제외·별도 집계.",
  falseCallRate: { ...neg, ci95: wilson(neg.called, neg.calls) },
  missRate: { ...pos, missed: pos.calls - pos.called, ci95: wilson(pos.calls - pos.called, pos.calls) },
  ambiguousCallRate: { ...amb, ci95: wilson(amb.called, amb.calls) },
  byCategory: Object.fromEntries(
    [...new Set(results.filter((r) => r.category).map((r) => r.category))].map((cat) => {
      const rs = results.filter((r) => r.category === cat);
      const n = rs.reduce((s, r) => s + r.valid, 0), k = rs.reduce((s, r) => s + r.calls, 0);
      return [cat, { calls: n, called: k, rate: n ? k / n : null }];
    })),
  results,
};

console.error("");
console.error(`  false-call (negative) : ${pct(neg.rate)}  ${ci(neg.called, neg.calls)}  probe-mean=${pct(neg.probeMeanRate)}  n=${neg.calls}${neg.errors ? ` err=${neg.errors}` : ""}`);
console.error(`  miss      (positive) : ${pct(pos.calls ? (pos.calls - pos.called) / pos.calls : null)}  ${ci(pos.calls - pos.called, pos.calls)}  probe-mean=${pct(pos.probeMeanRate === null ? null : 1 - pos.probeMeanRate)}  n=${pos.calls}${pos.errors ? ` err=${pos.errors}` : ""}`);
console.error(`  ambiguous call-rate  : ${pct(amb.rate)}  ${ci(amb.called, amb.calls)}  n=${amb.calls}   (T3 채택 시 3분류 direct/ask/reject 로 전환 예정)`);

const out = process.env.TS_OUT ?? join(_here, "..", ".agents", "reviews", `issue-82-tool-selection-${LABEL}-${SPLIT}.json`);
writeFileSync(out, JSON.stringify(summary, null, 2));
console.error(`\nevidence → ${out}`);
