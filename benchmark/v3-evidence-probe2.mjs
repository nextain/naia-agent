#!/usr/bin/env node
// v3 경첩 실측 2차 — ②-only 방어 + 모델 패널 교차 (Issue #82)
//
// 1차(v3-evidence-probe.mjs) 대비 바뀐 것:
//  (1) 모델 패널 교차 — 사용자 결정 2026-07-17 "특정 모델에 의존하지 않는다".
//      1차는 데모용 8G 모델 1개(dnotitia-dna3.0-9b) 산 수치였고, v3 하이브리드의 핵심 주장이
//      "설계의 성질"인지 "그 모델의 습성"인지 단일 모델로는 원리적으로 구분 불가.
//  (2) 도구 설명 A/B — A=1차와 동일(회귀 비교 가능), B=②-only 금지 문구 강화.
//  (3) 후보 규칙 사후 평가 — 같은 콜을 R0/R1 두 규칙으로 채점(추가 추론 0).
//      R0 = v3 원안 : called ∧ evidence 비어있지 않음 ∧ evidence 충실(원문 부분문자열)
//      R1 = R0 ∧ quote 비어있지 않음 ∧ quote 충실 ∧ 두 quote 비포함·비중첩 별도 span
//           ← v3.1 production 구조 검사와 동일(②-only 위조와 whole-utterance evidence 포함을 함께 차단)
//      둘 다 내용 무해석(키워드·정규식 금지 준수) — 모델 자기보고의 구조 검사일 뿐.
//  (4) ★ tools 미지원 탐지 — provider 는 400 "does not support tools" 시 tools 빼고 1회 재시도한다
//      (ollama-provider.ts §H.2 H-I3). 그러면 toolUse 가 영영 안 나와 called:false 로 흡수되고,
//      패널 채점에서 "오호출 0% = 완벽한 모델"로 뒤집혀 보인다. 프리플라이트로 먼저 배제한다.
//  (5) ★ thinking 을 통제 변수로 명시 (TS_THINK, 기본 1) — 2026-07-17 발견:
//      DNA3.0 계열은 think=ON 이어야 도구를 부른다(OFF 면 도구 없이 곧장 답해버림 = called:false 로 흡수).
//      provider 는 config.enableThinking 이 undefined 면 `think` 를 아예 안 보내 **모델 기본값**에 맡긴다
//      → 모델마다 다른 조건으로 재는 셈 = 패널 비교 무효. 전 모델에 동일 값을 명시한다.
//
// 실행: node benchmark/v3-evidence-probe2.mjs   (naia-agent 루트, pnpm build 선행 — dist 정본 import)
// env : TS_MODELS(쉼표구분) TS_RUNS TS_HOST TS_OUT TS_DESCS(a|b|ab) TS_THINK(1|0)
//       TS_CALL_TIMEOUT_MS(호출별 상한, 기본 120000)
//
// ⚠️ ollama 버전 = 통제 변수. 0.24.0 은 `qwen35moe`(DNA3.0-35B-A3B)를 qwen3next 로더로 잘못 매핑해
//    로드 자체가 실패한다("layer 40 missing attn_qkv/attn_gate" — 40번은 MTP/nextn 레이어).
//    0.32.1 에는 qwen35moe 내장 렌더러가 있어 템플릿 없이 tools+thinking 이 잡힌다.
//    → 패널 전체를 동일 버전에서 잴 것. 증적에 host/version 을 남긴다.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { makeOllamaProvider } = await import(pathToFileURL(resolve(ROOT, "dist/main/adapters/ollama-provider.js")).href);

const CORPUS = JSON.parse(readFileSync(resolve(ROOT, "benchmark/corpora/continue-speaking-ko.corpus.json"), "utf8"));
const HOST = process.env.TS_HOST || "http://127.0.0.1:11434";
const RUNS = Number(process.env.TS_RUNS || 3);
const OUT = process.env.TS_OUT || resolve(ROOT, ".agents/work/v3-evidence2-out.json");
const DESCS = (process.env.TS_DESCS || "ab").toLowerCase();
const MODELS = (process.env.TS_MODELS || "qwen3.6:27b").split(",").map((s) => s.trim()).filter(Boolean);
const THINK = (process.env.TS_THINK ?? "1") !== "0"; // 통제 변수 — 전 모델 동일값 명시(위 (5) 참조)
const CALL_TIMEOUT_MS = Number(process.env.TS_CALL_TIMEOUT_MS || 120_000);

// ── 도구 설명 A/B (변수 하나씩 — parameters 스키마는 동일, description 만 다름) ────────────
const DESC_A = // 1차와 바이트 동일 — 회귀 비교의 기준선
  "사용자가 끝을 정하지 않고 계속 말해 달라고 요청한 경우에만 호출합니다(라디오처럼 여러 이야기를 이어 말하기). 일반 질문·단발 이야기 요청·직전 답변을 이어가라는 요청에는 절대 호출하지 마세요. userRequestQuote 에는 계속 말해 달라는 요청 부분의 사용자 원문을 정확히 복사하세요. 사용자가 자리를 비우거나 다른 일을 하며 듣기만 하겠다는 신호(예: '나 씻고 올게', '누워서 들을게', '청소하는 동안')가 있을 때만 awayEvidence 에 그 부분의 원문을 정확히 복사하세요. 그런 신호가 사용자 메시지에 없으면 awayEvidence 를 절대 채우지 마세요 — 비워 두면 앱이 사용자에게 계속할지 확인 질문을 합니다. 활성화되면 같은 응답 스트림에서 짧은 후속 이야기를 스스로 이어갑니다.";

const DESC_B = // A + ②-only 금지 명시(1차가 연 구멍: '나 씻고 올게' 단독 61% 호출)
  "사용자가 끝을 정하지 않고 계속 말해 달라고 요청한 경우에만 호출합니다(라디오처럼 여러 이야기를 이어 말하기). " +
  "★ 계속 말해 달라는 요청 자체가 없으면 절대 호출하지 마세요. 자리를 비운다는 인사('나 씻고 올게', '자러 갈게', '나갔다 올게')만 있고 " +
  "계속 말해 달라는 요청이 없으면 호출 대상이 아닙니다 — 그냥 평범하게 인사에 답하세요. " +
  "일반 질문·단발 이야기 요청·직전 답변을 이어가라는 요청에도 절대 호출하지 마세요. " +
  "userRequestQuote 에는 계속 말해 달라는 요청 부분의 사용자 원문을 정확히 복사하세요. " +
  "awayEvidence 는 그와 별개로 사용자가 자리를 비우거나 다른 일을 하며 듣기만 하겠다는 신호가 있을 때만, 그 신호 부분의 원문을 정확히 복사하세요. " +
  "userRequestQuote 와 awayEvidence 는 사용자 말의 서로 다른 부분을 가리켜야 합니다 — 같은 문장을 두 필드에 넣지 마세요. " +
  "그런 신호가 없으면 awayEvidence 를 절대 채우지 마세요 — 비워 두면 앱이 사용자에게 계속할지 확인 질문을 합니다. " +
  "활성화되면 같은 응답 스트림에서 짧은 후속 이야기를 스스로 이어갑니다.";

const PARAMS = {
  type: "object",
  properties: {
    userRequestQuote: { type: "string", description: "계속 말해 달라는 요청 부분의 사용자 원문 그대로의 인용" },
    awayEvidence: { type: "string", description: "사용자가 자리를 비우거나 듣기만 한다는 신호 부분의 원문 인용. 그런 신호가 없으면 이 필드를 넣지 마세요" },
    topic: { type: "string", description: "이어 말할 선택 주제" },
    durationMinutes: { type: "number", minimum: 1, maximum: 30, default: 10 },
    pauseSeconds: { type: "number", minimum: 0, maximum: 30, default: 3 },
  },
  required: ["userRequestQuote"],
  additionalProperties: false,
};
const tool = (description) => ({ name: "continue_speaking", description, parameters: PARAMS });
const VARIANTS = [];
if (DESCS.includes("a")) VARIANTS.push({ key: "desc-a", tool: tool(DESC_A) });
if (DESCS.includes("b")) VARIANTS.push({ key: "desc-b", tool: tool(DESC_B) });

// ── 프로브: positive dev 16 + ①-only 3 + ②-only 3 + 관측 false-caller 8 ────────────────
const ONE_ONLY = ["P-AMB-004", "P-AMB-005", "P-AMB-006"];
const AWAY_ONLY = ["P-NEG-030", "P-NEG-031", "P-NEG-032"];
const FALSE_CALLERS = ["P-NEG-001", "P-NEG-007", "P-NEG-009", "P-NEG-011", "P-NEG-013", "P-NEG-021", "P-NEG-027", "P-NEG-029"];
const IDS = new Set([
  ...CORPUS.probes.filter((p) => p.label === "positive" && p.split === "dev").map((p) => p.id),
  ...ONE_ONLY, ...AWAY_ONLY, ...FALSE_CALLERS,
]);
const probes = CORPUS.probes.filter((p) => IDS.has(p.id));
const groupOf = (id) => (ONE_ONLY.includes(id) ? "oneOnly" : AWAY_ONLY.includes(id) ? "awayOnly" : FALSE_CALLERS.includes(id) ? "negFalseCaller" : "positive");

const provider = makeOllamaProvider();
const norm = (s) => String(s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

function hasDisjointSpans(user, quote, evidence) {
  for (let qi = user.indexOf(quote); qi >= 0; qi = user.indexOf(quote, qi + 1)) {
    for (let ei = user.indexOf(evidence); ei >= 0; ei = user.indexOf(evidence, ei + 1)) {
      if (qi + quote.length <= ei || ei + evidence.length <= qi) return true;
    }
  }
  return false;
}

// ── ★ 프리플라이트: tools 지원 여부 (provider 의 조용한 degrade 를 우회해 raw 로 직접 확인) ──
async function toolsSupported(model) {
  try {
    const r = await fetch(`${HOST}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model, stream: false, think: THINK, messages: [{ role: "user", content: "안녕" }],
        tools: [{ type: "function", function: { name: "continue_speaking", description: DESC_A, parameters: PARAMS } }],
      }),
    });
    if (r.ok) return { ok: true };
    const t = await r.text();
    return { ok: !/does not support tools/i.test(t), reason: t.slice(0, 160) };
  } catch (e) { return { ok: false, reason: `preflight failed: ${e.message}` }; }
}
async function unload(model) { // 다음 모델 로드 전 VRAM 반납(24GB 에 20GB 급 모델 = 동시 상주 불가)
  try { await fetch(`${HOST}/api/chat`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [], keep_alive: 0 }) }); } catch { /* best-effort */ }
}

async function runOnce(model, toolSpec, utterance) {
  let called = false, quote, evidence;
  const config = { provider: "ollama", model, ollamaHost: HOST, enableThinking: THINK };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`call timeout >${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS);
  try {
    for await (const c of provider.chat(config, [{ role: "user", content: utterance }], { tools: [toolSpec], signal: controller.signal })) {
      if (c.kind === "toolUse" && c.name === "continue_speaking") {
        called = true;
        const a = c.args && typeof c.args === "object" ? c.args : {};
        quote = typeof a.userRequestQuote === "string" ? a.userRequestQuote : "";
        evidence = typeof a.awayEvidence === "string" ? a.awayEvidence : (a.awayEvidence === undefined ? undefined : JSON.stringify(a.awayEvidence));
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { called, quote, evidence };
}

// R0 = v3 원안 / R1 = v3.1 production 구조 검사. 둘 다 사후 평가(같은 콜 재사용).
function judge(utterance, r) {
  if (!r.called) return { r0: "none", r1: "none" };
  const q = norm(r.quote), e = norm(r.evidence), u = norm(utterance);
  const faithful = e !== "" && u.includes(e);
  const r0 = faithful ? "activate" : "clarify";                       // evidence 없거나 불충실 → 확인질문 강등
  const separated =
    faithful &&
    q !== "" &&
    u.includes(q) &&
    q !== e &&
    !q.includes(e) &&
    !e.includes(q) &&
    hasDisjointSpans(u, q, e);
  const r1 = separated ? "activate" : "clarify";
  return { r0, r1 };
}

const runResults = [];
for (const model of MODELS) {
  const pf = await toolsSupported(model);
  if (!pf.ok) { // 채점에서 배제 — 안 그러면 "오호출 0%" 로 뒤집혀 보인다
    console.error(`\n### ${model} — ⛔ tools 미지원 → 패널 제외 (${pf.reason})`);
    runResults.push({ model, excluded: true, reason: pf.reason });
    continue;
  }
  for (const v of VARIANTS) {
    console.error(`\n### ${model} / ${v.key}`);
    for (const p of probes) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        try { runs.push(await runOnce(model, v.tool, p.utterance)); }
        catch (e) { runs.push({ error: e.message }); }
      }
      const errors = runs.filter((r) => r.error);
      const valid = runs.filter((r) => !r.error);
      const verdicts = valid.map((r) => judge(p.utterance, r));
      const rec = {
        model, variant: v.key, id: p.id, group: groupOf(p.id), label: p.label,
        category: p.category, utterance: p.utterance,
        valid: valid.length, errors: errors.length,          // ★ 오류를 called:false 로 흡수하지 않고 별도 집계
        called: valid.filter((r) => r.called).length,
        r0Activate: verdicts.filter((x) => x.r0 === "activate").length,
        r0Clarify: verdicts.filter((x) => x.r0 === "clarify").length,
        r1Activate: verdicts.filter((x) => x.r1 === "activate").length,
        r1Clarify: verdicts.filter((x) => x.r1 === "clarify").length,
        samples: valid.filter((r) => r.called).slice(0, 2).map((r) => ({ quote: r.quote, evidence: r.evidence ?? null })),
      };
      runResults.push(rec);
      console.error(`  ${p.id} ${rec.group.padEnd(14)} call ${rec.called}/${rec.valid} R0-act ${rec.r0Activate} R1-act ${rec.r1Activate}${rec.errors ? ` err ${rec.errors}` : ""}  ${p.utterance.slice(0, 26)}`);
    }
  }
  await unload(model);
}

// ── 집계 (Wilson 95% CI — CI 없는 단일 수치로 의사결정 금지: 이 이슈가 이미 그걸로 반려됨) ──
function wilson(k, n) {
  if (!n) return [0, 0];
  const p = k / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}
const pct = (k, n) => { const [lo, hi] = wilson(k, n); return `${n ? (100 * k / n).toFixed(1) : "-"}% [${(100 * lo).toFixed(1)}–${(100 * hi).toFixed(1)}] (${k}/${n})`; };
const agg = (rs, f) => rs.filter(f).reduce((s, r) => ({
  valid: s.valid + r.valid, errors: s.errors + r.errors, called: s.called + r.called,
  r0: s.r0 + r0k(r), r1: s.r1 + r1k(r),
}), { valid: 0, errors: 0, called: 0, r0: 0, r1: 0 });
const r0k = (r) => r.r0Activate, r1k = (r) => r.r1Activate;

const scored = runResults.filter((r) => !r.excluded);
const ollamaVersion = await fetch(`${HOST}/api/version`).then((r) => r.json()).then((j) => j.version).catch(() => "unknown");
const summary = { schema: "v3-candidate (awayEvidence optional)", host: HOST, ollamaVersion, thinking: THINK, runs: RUNS,
  callTimeoutMs: CALL_TIMEOUT_MS,
  models: MODELS, excluded: runResults.filter((r) => r.excluded), byModelVariant: [], results: runResults };

console.error("\n\n════ 요약 (즉시활성률 = R0/R1 규칙 적용 후) ════");
for (const model of MODELS) {
  for (const v of VARIANTS) {
    const sel = (g) => (r) => r.model === model && r.variant === v.key && r.group === g;
    if (!scored.some((r) => r.model === model && r.variant === v.key)) continue;
    const row = { model, variant: v.key };
    for (const g of ["positive", "oneOnly", "awayOnly", "negFalseCaller"]) row[g] = agg(scored, sel(g));
    summary.byModelVariant.push(row);
    console.error(`\n── ${model} / ${v.key}`);
    console.error(`   positive  (켜져야) call ${pct(row.positive.called, row.positive.valid)} → R0 ${pct(row.positive.r0, row.positive.valid)}  R1 ${pct(row.positive.r1, row.positive.valid)}`);
    console.error(`   ①-only    (물어야) call ${pct(row.oneOnly.called, row.oneOnly.valid)} → R0 ${pct(row.oneOnly.r0, row.oneOnly.valid)}  R1 ${pct(row.oneOnly.r1, row.oneOnly.valid)}`);
    console.error(`   ②-only    (0 목표) call ${pct(row.awayOnly.called, row.awayOnly.valid)} → R0 ${pct(row.awayOnly.r0, row.awayOnly.valid)}  R1 ${pct(row.awayOnly.r1, row.awayOnly.valid)}`);
    console.error(`   neg-FC    (0 목표) call ${pct(row.negFalseCaller.called, row.negFalseCaller.valid)} → R0 ${pct(row.negFalseCaller.r0, row.negFalseCaller.valid)}  R1 ${pct(row.negFalseCaller.r1, row.negFalseCaller.valid)}`);
    const errs = ["positive", "oneOnly", "awayOnly", "negFalseCaller"].reduce((s, g) => s + row[g].errors, 0);
    if (errs) console.error(`   ⚠ provider 오류 ${errs}건 — called:false 로 흡수하지 않고 별도 집계함`);
  }
}
writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.error(`\nevidence → ${OUT}`);
