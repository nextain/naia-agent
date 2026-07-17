#!/usr/bin/env node
// v3 경첩 실측 — awayEvidence 자기보고 규율 (계약 v3.1 재작성 전 go/no-go)
// 측정: P(evidence 채움 | positive) ↑여야, P(채움 | ①-only) ↓여야, false-call 시 채움율, 인용 충실도.
// 프로덕션 provider(dist) + v3 후보 스키마(스키마는 아직 미구현이라 여기 정의 — 채택 시 이것이 프로덕션 스펙이 됨).
// 실행: node benchmark/v3-evidence-probe.mjs (naia-agent 루트에서, pnpm build 선행 필수 — dist 정본)
// 2026-07-17 실측 결과: .agents/reviews/issue-82-v3-evidence-hinge-2026-07-17.json
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const { makeOllamaProvider } = await import(pathToFileURL(resolve(ROOT, "dist/main/adapters/ollama-provider.js")).href);

const CORPUS = JSON.parse(readFileSync(resolve(ROOT, "benchmark/corpora/continue-speaking-ko.corpus.json"), "utf8"));
const MODEL = process.env.TS_MODEL || "dnotitia-dna3.0-9b-q4-16k:latest";
const HOST = process.env.TS_HOST || "http://127.0.0.1:11434";
const RUNS = Number(process.env.TS_RUNS || 6);
const OUT = process.env.TS_OUT || resolve(ROOT, ".agents/work/v3-evidence-out.json");

const V3_TOOL = {
  name: "continue_speaking",
  description: "사용자가 끝을 정하지 않고 계속 말해 달라고 요청한 경우에만 호출합니다(라디오처럼 여러 이야기를 이어 말하기). 일반 질문·단발 이야기 요청·직전 답변을 이어가라는 요청에는 절대 호출하지 마세요. userRequestQuote 에는 계속 말해 달라는 요청 부분의 사용자 원문을 정확히 복사하세요. 사용자가 자리를 비우거나 다른 일을 하며 듣기만 하겠다는 신호(예: '나 씻고 올게', '누워서 들을게', '청소하는 동안')가 있을 때만 awayEvidence 에 그 부분의 원문을 정확히 복사하세요. 그런 신호가 사용자 메시지에 없으면 awayEvidence 를 절대 채우지 마세요 — 비워 두면 앱이 사용자에게 계속할지 확인 질문을 합니다. 활성화되면 같은 응답 스트림에서 짧은 후속 이야기를 스스로 이어갑니다.",
  parameters: {
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
  },
};

// 대상: 전 dev positive(16) + ①-only ambiguous(3) + 관측 false-call 음성(8) + 부재만(3)
const IDS = new Set([
  ...CORPUS.probes.filter((p) => p.label === "positive" && p.split === "dev").map((p) => p.id),
  "P-AMB-004", "P-AMB-005", "P-AMB-006",
  "P-NEG-001", "P-NEG-007", "P-NEG-009", "P-NEG-011", "P-NEG-013", "P-NEG-021", "P-NEG-027", "P-NEG-029",
  "P-NEG-030", "P-NEG-031", "P-NEG-032",
]);
const probes = CORPUS.probes.filter((p) => IDS.has(p.id));

const provider = makeOllamaProvider();
const config = { provider: "ollama", model: MODEL, ollamaHost: HOST };
const norm = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim();

async function runOnce(utterance) {
  let called = false, quote, evidence;
  for await (const c of provider.chat(config, [{ role: "user", content: utterance }], { tools: [V3_TOOL] })) {
    if (c.kind === "toolUse" && c.name === "continue_speaking") {
      called = true;
      const a = c.args && typeof c.args === "object" ? c.args : {};
      quote = typeof a.userRequestQuote === "string" ? a.userRequestQuote : "";
      evidence = typeof a.awayEvidence === "string" ? a.awayEvidence : (a.awayEvidence === undefined ? undefined : JSON.stringify(a.awayEvidence));
    }
  }
  return { called, quote, evidence };
}

const results = [];
for (const p of probes) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try { runs.push(await runOnce(p.utterance)); } catch (e) { runs.push({ error: e.message }); }
  }
  const valid = runs.filter((r) => !r.error);
  const calls = valid.filter((r) => r.called);
  const filled = calls.filter((r) => norm(r.evidence) !== "");
  const faithful = filled.filter((r) => norm(p.utterance).includes(norm(r.evidence)));
  results.push({
    id: p.id, label: p.label, utterance: p.utterance,
    valid: valid.length, called: calls.length, evidenceFilled: filled.length, evidenceFaithful: faithful.length,
    samples: calls.slice(0, 3).map((r) => ({ quote: r.quote, evidence: r.evidence ?? null })),
  });
  console.error(`${p.id} ${p.label.padEnd(9)} call ${calls.length}/${valid.length} evid ${filled.length}/${calls.length} faith ${faithful.length}/${filled.length}  ${p.utterance.slice(0, 30)}`);
}

const grp = (f) => {
  const rs = results.filter(f);
  const c = rs.reduce((s, r) => s + r.called, 0), v = rs.reduce((s, r) => s + r.valid, 0);
  const e = rs.reduce((s, r) => s + r.evidenceFilled, 0), fa = rs.reduce((s, r) => s + r.evidenceFaithful, 0);
  return { probes: rs.length, valid: v, called: c, evidenceFilled: e, evidenceFaithful: fa };
};
const summary = {
  model: MODEL, runs: RUNS, schema: "v3-candidate (awayEvidence optional)",
  positive: grp((r) => r.label === "positive"),
  oneOnly: grp((r) => ["P-AMB-004", "P-AMB-005", "P-AMB-006"].includes(r.id)),
  negativeFalseCallers: grp((r) => r.label === "negative" && !["P-NEG-030", "P-NEG-031", "P-NEG-032"].includes(r.id)),
  awayOnly: grp((r) => ["P-NEG-030", "P-NEG-031", "P-NEG-032"].includes(r.id)),
  results,
};
console.error("\n== HINGE ==");
console.error(`positive: call ${summary.positive.called}/${summary.positive.valid}, evidence filled ${summary.positive.evidenceFilled}/${summary.positive.called} (↑목표), faithful ${summary.positive.evidenceFaithful}/${summary.positive.evidenceFilled}`);
console.error(`①-only  : call ${summary.oneOnly.called}/${summary.oneOnly.valid}, evidence filled ${summary.oneOnly.evidenceFilled}/${summary.oneOnly.called} (↓목표 — 채우면 하이브리드 붕괴)`);
console.error(`neg-FC  : call ${summary.negativeFalseCallers.called}/${summary.negativeFalseCallers.valid}, evidence filled ${summary.negativeFalseCallers.evidenceFilled}/${summary.negativeFalseCallers.called}`);
console.error(`②-only  : call ${summary.awayOnly.called}/${summary.awayOnly.valid} (0 목표)`);
writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.error(`evidence → ${OUT}`);
