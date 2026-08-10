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
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  HUMANLIKE_FIXTURE_VERSION, HUMANLIKE_SCENARIOS,
  DEFAULT_HUMANLIKE_SEED, assessRunValidity, assignOptions, buildResult,
  containsAnyTargetText, correctOptionIsA, summarize,
} from "./dist/humanlike/index.js";
import { makeNaiaMemory } from "../dist/main/adapters/naia-memory.js";
import { formatRecalledMemory } from "../dist/main/domain/memory.js";
import { makeOpenAICompatProvider } from "../dist/main/adapters/openai-compat-provider.js";

const _here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.PREDICT_LIVE === "1";
const RUNS = Math.max(1, Number(process.env.PREDICT_RUNS ?? 1) | 0);
const GATEWAY = (process.env.NAIA_GATEWAY_URL ?? "https://naia-gateway-181404717065.asia-northeast3.run.app").replace(/\/+$/, "");
const MAIN_MODEL = process.env.HUMANLIKE_MAIN_MODEL ?? "vertexai:gemini-3.6-flash";
const KEY = (process.env.NAIA_PROD_KEY ?? "").trim();
const SEED = process.env.HUMANLIKE_SEED ?? DEFAULT_HUMANLIKE_SEED;
const OUTPUT = (process.env.HUMANLIKE_OUTPUT ?? "").trim();
const requestedTopK = Math.floor(Number(process.env.HUMANLIKE_TOP_K ?? 5));
const TOP_K = Number.isFinite(requestedTopK) ? Math.min(Math.max(1, requestedTopK), 50) : 5;

// Same-store topical competitors: retrieval must surface the user's actual preference,
// not pass merely because some broadly related memory was returned.
const DISTRACTOR_TURNS = [
  "친구가 회식 장소 후보로 새 고기집과 채식 식당을 보내 줬어.",
  "카페 메뉴판 사진을 정리 중인데 커피와 차 종류가 많더라.",
  "달력에 아침 운동과 밤 영화 일정을 둘 다 적어 뒀어.",
  "주말 모임 참석자 명단을 전달받았어.",
  "여행지의 여름과 겨울 평균 기온을 비교해 봤어.",
  "점심 메뉴표에 매운 음식과 순한 음식이 같이 있었어.",
  "새로 산 책과 이어폰 영수증을 정리했어.",
  "다음 주 업무 회의 자료를 폴더에 옮겼어.",
];

const SYS_BASE =
  "너는 사용자를 오래 알고 지낸 친구야. 사용자가 어떤 선택을 할지 '예측'해. " +
  "조언이나 훈수가 아니라 사용자 본인이 실제로 뭘 고를지를 맞혀. " +
  "반드시 첫 줄에 `예측: A` 또는 `예측: B` 형식으로만 답하고, 다음 줄에 한 줄로 이유를 써.";

/** P4 bridge: seed → automatic recall → trusted-boundary formatter (never re-framed). keyword-only. */
async function inject(project, seed, recallQuery) {
  const storePath = join(mkdtempSync(join(tmpdir(), "hlmem-host-")), "store.json");
  const mem = makeNaiaMemory({ storePath, project, sessionId: "s1", topK: TOP_K });
  try {
    for (const userText of DISTRACTOR_TURNS) await mem.save(userText, "알겠어.");
    for (const t of seed) await mem.save(t.userText, t.assistantText ?? "");
    const recalled = await mem.recall(recallQuery);
    return {
      formatted: formatRecalledMemory(recalled),
      targetFound: containsAnyTargetText(
        recalled.episodes.map((episode) => episode.content),
        seed.map((turn) => turn.userText),
      ),
    };
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

async function writeArtifact(artifact) {
  if (!OUTPUT) return;
  const evidenceRoot = resolve(_here, "reports/humanlike");
  const target = resolve(process.cwd(), OUTPUT);
  const rel = relative(evidenceRoot, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`HUMANLIKE_OUTPUT must be a file below ${evidenceRoot}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log(`[artifact] ${target}`);
}

async function runDeterministic() {
  console.log(`[humanlike] runtime host — deterministic target-recall with ${DISTRACTOR_TURNS.length} distractors/store, topK=${TOP_K} (P4)`);
  let injected = 0, surfaced = 0, total = 0;
  const cases = [];
  for (const sc of HUMANLIKE_SCENARIOS) for (const u of sc.users) {
    total++;
    const m = await inject(`user-${sc.id}-${u.id}`, u.seed, sc.recallQuery);
    if (m.formatted.length > 0) injected++;
    if (m.targetFound) surfaced++;
    cases.push({ scenarioId: sc.id, targetUserId: u.id, targetFound: m.targetFound, injectedChars: m.formatted.length });
    console.log(`  ${sc.id}/${u.label}  target=${m.targetFound ? "Y" : "·"} injected=${m.formatted.length > 0 ? "Y" : "·"}(${m.formatted.length}b)`);
  }
  console.log(`\n[P4] target-recall: ${surfaced}/${total}; any-injection: ${injected}/${total}; scenarios=${HUMANLIKE_SCENARIOS.length}.`);
  await writeArtifact({
    schemaVersion: 1,
    benchmark: "UC-HLMEM",
    mode: "deterministic-recall",
    recordedAt: new Date().toISOString(),
    seed: SEED,
    profile: { name: "topical-distractors-v1", distractorsPerStore: DISTRACTOR_TURNS.length, topK: TOP_K },
    coverage: {
      targetSurfaced: surfaced,
      anyInjected: injected,
      total,
      targetRate: total === 0 ? null : surfaced / total,
      injectionRate: total === 0 ? null : injected / total,
      meanInjectedChars: total === 0 ? null : cases.reduce((sum, item) => sum + item.injectedChars, 0) / total,
      maxInjectedChars: cases.reduce((max, item) => Math.max(max, item.injectedChars), 0),
    },
    cases,
  });
  return surfaced === total ? 0 : 1;
}

async function runLive() {
  if (!KEY) { console.error("✗ NAIA_PROD_KEY 미설정 (set -a; . <(tr -d '\\r' < data-private/key/llm-key.env); set +a)"); return 2; }
  const provider = makeOpenAICompatProvider({ baseUrl: `${GATEWAY}/v1`, apiKey: KEY, model: MAIN_MODEL, auth: "bearer" });
  console.log(`[humanlike] LIVE prediction (P5) — gateway=${GATEWAY} model=${MAIN_MODEL} runs=${RUNS} seed=${SEED}`);
  console.log(`  matched=own memory · mismatched=other user's memory · blind=none · option order seeded\n`);

  const results = [];
  const executionErrors = [];
  let correctA = 0;
  let assignments = 0;
  // conditions per family: F1 preference = matched|blind; F2 self-spec = matched|mismatched|blind.
  for (let run = 0; run < RUNS; run++) {
    for (const sc of HUMANLIKE_SCENARIOS) {
      const selfSpec = sc.family === "self-spec";
      const targets = selfSpec ? sc.users : [sc.users[0]];
      for (const self of targets) {
        const other = sc.users.find((u) => u.id !== self.id);
        const trialKey = `${run}/${sc.id}/${self.id}`;
        const correctIsA = correctOptionIsA(SEED, trialKey);
        correctA += correctIsA ? 1 : 0;
        assignments++;
        const { correctLabel, probe } = assignOptions(sc, self.id, correctIsA);
        const conds = selfSpec ? ["matched", "mismatched", "blind"] : ["matched", "blind"];
        for (const condition of conds) {
          const src = condition === "matched" ? self : condition === "mismatched" ? other : null;
          const recalled = src ? await inject(`u-${sc.id}-${src.id}-${run}`, src.seed, sc.recallQuery) : { formatted: "", targetFound: false };
          const sys = recalled.formatted ? `${SYS_BASE}\n\n사용자에 대해 네가 아는 것:\n${recalled.formatted}` : SYS_BASE;
          let resp = "";
          try { resp = await predictOnce(provider, sys, probe); }
          catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            resp = "";
            executionErrors.push({ scenarioId: sc.id, targetUserId: self.id, condition, message });
            console.error(`  (call error ${sc.id}/${self.id}/${condition}: ${message})`);
          }
          const r = buildResult({
            scenarioId: sc.id,
            targetUserId: self.id,
            condition,
            correctLabel,
            responseText: resp,
            recallReturnedTarget: condition === "matched" && recalled.targetFound,
            memoryInjected: recalled.formatted.length > 0,
          });
          results.push(r);
          console.log(`  ${sc.id}/${self.label}/${condition}  정답=${correctLabel} → ${r.trace.predicted ?? "?"} [${r.outcome}]`);
        }
      }
    }
  }

  const s = summarize(results);
  const validity = assessRunValidity(results);
  const pct = (x) => x === null ? "n/a" : `${(x * 100).toFixed(0)}%`;
  console.log(`\n[result] N=${results.length} predictions`);
  console.log(`  matched(own memory)     : ${s.matched.correct}/${s.matched.scored} (${pct(s.matched.accuracy)})  exec-err=${s.matched.execError}`);
  console.log(`  mismatched(other's mem) : ${s.mismatched.scored ? `${s.mismatched.correct}/${s.mismatched.scored} (${pct(s.mismatched.accuracy)})` : "n/a"}`);
  console.log(`  blind(no memory)        : ${s.blind.correct}/${s.blind.scored} (${pct(s.blind.accuracy)})  pickedA=${pct(s.blind.pickedARate)}`);
  console.log(`  → memory lift (matched − blind)      = ${s.memoryLift === null ? "n/a" : `${(s.memoryLift * 100).toFixed(0)}pp`}`);
  console.log(`  → self-specificity (matched − mismatched) = ${s.selfSpecificity === null ? "n/a" : `${(s.selfSpecificity * 100).toFixed(0)}pp`}`);
  console.log(`  → mismatched below blind             = ${s.mismatchedBelowBlind === null ? "n/a" : `${(s.mismatchedBelowBlind * 100).toFixed(0)}pp`}`);
  console.log(`  → run validity = ${validity.status} (scored=${validity.scored}/${validity.total}, exec-err=${validity.execErrors})`);

  const recordedAt = new Date().toISOString();
  await writeArtifact({
    schemaVersion: 1,
    benchmark: "UC-HLMEM",
    mode: "live-prediction",
    recordedAt,
    config: {
      gateway: GATEWAY,
      model: MAIN_MODEL,
      runs: RUNS,
      seed: SEED,
      profile: "topical-distractors-v1",
      distractorsPerStore: DISTRACTOR_TURNS.length,
      topK: TOP_K,
    },
    assignment: { correctA, total: assignments, rate: assignments === 0 ? null : correctA / assignments },
    validity,
    summary: s,
    executionErrors,
    fixture: {
      version: HUMANLIKE_FIXTURE_VERSION,
      recordedAt,
      model: MAIN_MODEL,
      probes: results.map((r) => r.trace),
    },
  });
  console.log(`\n⚠ 예측정확도는 proxy이지 telos 아님(SoT). ${validity.status === "complete" ? "verified-runtime: 실 게이트웨이 e2e." : "runtime-unverified: 결과를 성능 지표로 사용하면 안 됨."}`);
  return validity.status === "complete" ? 0 : 1;
}

(LIVE ? runLive() : runDeterministic())
  .then((exitCode) => { process.exitCode = exitCode; })
  .catch((e) => { console.error(`✗ humanlike host FAILED: ${e?.stack ?? e}`); process.exitCode = 1; });
