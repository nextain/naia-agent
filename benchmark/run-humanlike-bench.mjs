#!/usr/bin/env node
// run-humanlike-bench — UC-HLMEM (memory-as-user-model) 런타임 호스트.
// benchmark humanlike 코어(결정론) + 실 MemoryPort(makeNaiaMemory, 키워드-only=hermetic) +
// 실 예측(ProviderPort=게이트웨이, P5)을 배선한다. 각 시나리오×조건(matched/mismatched/blind)에서
// seed(save)→자동 recall→formatRecalledMemory 주입 위에서 예측 → matched>blind / self-specificity 를 잰다.
//
// 벤치 컴파일 선행: npx tsc -p benchmark/tsconfig.json  (+ pnpm build 로 ../dist)
// P4 결정론(무모델): node benchmark/run-humanlike-bench.mjs
// P5 라이브 예측: set -a; . <(tr -d '\r' < data-private/key/llm-key.env); set +a
//                PREDICT_LIVE=1 PREDICT_RUNS=1 node projects/naia-agent/benchmark/run-humanlike-bench.mjs
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { HUMANLIKE_SCENARIOS, PREFERENCE_SCENARIOS, SELF_SPEC_SCENARIOS, assignOptions, buildResult, summarize } from "./dist/humanlike/index.js";
import { makeNaiaMemory } from "../dist/main/adapters/naia-memory.js";
import { formatRecalledMemory } from "../dist/main/domain/memory.js";
import { makeOpenAICompatProvider } from "../dist/main/adapters/openai-compat-provider.js";

const _here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.PREDICT_LIVE === "1";
const RUNS = Math.max(1, Number(process.env.PREDICT_RUNS ?? 1) | 0);
const GATEWAY = (process.env.NAIA_GATEWAY_URL ?? "https://naia-gateway-181404717065.asia-northeast3.run.app").replace(/\/+$/, "");
const MAIN_MODEL = process.env.HUMANLIKE_MAIN_MODEL ?? "vertexai:gemini-3.5-flash";
const KEY = (process.env.NAIA_PROD_KEY ?? "").trim();

const SYS_BASE =
  "너는 사용자를 오래 알고 지낸 친구야. 사용자가 어떤 선택을 할지 '예측'해. " +
  "조언이나 훈수가 아니라 사용자 본인이 실제로 뭘 고를지를 맞혀. " +
  "반드시 첫 줄에 `예측: A` 또는 `예측: B` 형식으로만 답하고, 다음 줄에 한 줄로 이유를 써.";

/** P4 bridge: seed → automatic recall → trusted-boundary formatter (never re-framed). keyword-only. */
async function inject(project, seed, recallQuery) {
  const storePath = join(mkdtempSync(join(tmpdir(), "hlmem-host-")), "store.json");
  const mem = makeNaiaMemory({ storePath, project, sessionId: "s1" });
  try {
    for (const t of seed) await mem.save(t.userText, t.assistantText ?? "");
    return formatRecalledMemory(await mem.recall(recallQuery));
  } finally { await mem.close(); }
}

/** P5 seam: predict via ProviderPort (sole sanctioned LLM path). Collect text chunks. */
async function predictOnce(provider, systemPrompt, probe) {
  let text = "";
  for await (const ch of provider.chat({ provider: "naia-gw", model: MAIN_MODEL }, [{ role: "user", content: probe }], { systemPrompt })) {
    if (ch.kind === "text") text += ch.text;
  }
  return text;
}

async function runDeterministic() {
  console.log(`[humanlike] runtime host — deterministic recall-coverage (P4)`);
  let surfaced = 0, total = 0;
  for (const sc of SELF_SPEC_SCENARIOS) for (const u of sc.users) {
    total++;
    const m = await inject(`user-${sc.id}-${u.id}`, u.seed, sc.recallQuery);
    if (m.length > 0) surfaced++;
    console.log(`  ${sc.id}/${u.label}  matched-recall=${m.length > 0 ? "Y" : "·"}(${m.length}b)`);
  }
  console.log(`\n[P4] recall-coverage: ${surfaced}/${total} surfaced own seed. scenarios=${HUMANLIKE_SCENARIOS.length}.`);
  process.exit(surfaced === total ? 0 : 1);
}

async function runLive() {
  if (!KEY) { console.error("✗ NAIA_PROD_KEY 미설정 (set -a; . <(tr -d '\\r' < data-private/key/llm-key.env); set +a)"); process.exit(2); }
  const provider = makeOpenAICompatProvider({ baseUrl: `${GATEWAY}/v1`, apiKey: KEY, model: MAIN_MODEL, auth: "bearer" });
  console.log(`[humanlike] LIVE prediction (P5) — gateway=${GATEWAY} model=${MAIN_MODEL} runs=${RUNS}`);
  console.log(`  A=memory-injected(matched) · mismatched=other user's memory · blind=none · option order randomized\n`);

  const results = [];
  // conditions per family: F1 preference = matched|blind; F2 self-spec = matched|mismatched|blind.
  for (let run = 0; run < RUNS; run++) {
    for (const sc of HUMANLIKE_SCENARIOS) {
      const selfSpec = sc.family === "self-spec";
      const targets = selfSpec ? sc.users : [sc.users[0]];
      for (const self of targets) {
        const other = sc.users.find((u) => u.id !== self.id);
        const correctIsA = Math.random() < 0.5;
        const { correctLabel, probe } = assignOptions(sc, self.id, correctIsA);
        const conds = selfSpec ? ["matched", "mismatched", "blind"] : ["matched", "blind"];
        for (const condition of conds) {
          const src = condition === "matched" ? self : condition === "mismatched" ? other : null;
          const injected = src ? await inject(`u-${sc.id}-${src.id}-${run}`, src.seed, sc.recallQuery) : "";
          const sys = injected ? `${SYS_BASE}\n\n사용자에 대해 네가 아는 것:\n${injected}` : SYS_BASE;
          let resp = "";
          try { resp = await predictOnce(provider, sys, probe); }
          catch (e) { resp = ""; console.error(`  (call error ${sc.id}/${self.id}/${condition}: ${e?.message ?? e})`); }
          const r = buildResult({ scenarioId: sc.id, targetUserId: self.id, condition, correctLabel, responseText: resp, recallReturnedTarget: injected.length > 0, memoryInjected: injected.length > 0 });
          results.push(r);
          console.log(`  ${sc.id}/${self.label}/${condition}  정답=${correctLabel} → ${r.trace.predicted ?? "?"} [${r.outcome}]`);
        }
      }
    }
  }

  const s = summarize(results);
  const pct = (x) => x === null ? "n/a" : `${(x * 100).toFixed(0)}%`;
  console.log(`\n[result] N=${results.length} predictions`);
  console.log(`  matched(own memory)     : ${s.matched.correct}/${s.matched.scored} (${pct(s.matched.accuracy)})  exec-err=${s.matched.execError}`);
  console.log(`  mismatched(other's mem) : ${s.mismatched.scored ? `${s.mismatched.correct}/${s.mismatched.scored} (${pct(s.mismatched.accuracy)})` : "n/a"}`);
  console.log(`  blind(no memory)        : ${s.blind.correct}/${s.blind.scored} (${pct(s.blind.accuracy)})  pickedA=${pct(s.blind.pickedARate)}`);
  console.log(`  → memory lift (matched − blind)      = ${s.memoryLift === null ? "n/a" : `${(s.memoryLift * 100).toFixed(0)}pp`}`);
  console.log(`  → self-specificity (matched − mismatched) = ${s.selfSpecificity === null ? "n/a" : `${(s.selfSpecificity * 100).toFixed(0)}pp`}`);
  console.log(`  → mismatched below blind             = ${s.mismatchedBelowBlind === null ? "n/a" : `${(s.mismatchedBelowBlind * 100).toFixed(0)}pp`}`);
  console.log(`\n⚠ 예측정확도는 proxy이지 telos 아님(SoT). verified-runtime: 실 게이트웨이 e2e.`);
  process.exit(0);
}

(LIVE ? runLive() : runDeterministic()).catch((e) => { console.error(`✗ humanlike host FAILED: ${e?.stack ?? e}`); process.exit(1); });
