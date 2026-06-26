#!/usr/bin/env node
// run-recall-bench — Stage 1b 벤치 하네스를 **실 naia-memory(LocalAdapter, 키워드-only)** SUT 로 구동.
// benchmark/fixtures/*.fixture.json(LongMemEval식 장기대화 + recall/task probe)을 fixture 당 독립 store 로
// 재생→회상→채점(factRecall/taskAccuracy/drift, Stage-1a 결정론 메트릭) + fixture 당 wall-clock 지연.
// 실행: node benchmark/run-recall-bench.mjs   (벤치 컴파일: npx tsc -p benchmark/tsconfig.json 선행)
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runFixture, formatReport } from "./dist/index.js";
import { makeNaiaMemory } from "../dist/main/adapters/naia-memory.js";
import { formatRecalledMemory } from "../dist/main/domain/memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "fixtures");

// 선택적 실 LLM judge(task-accuracy probe) — 가용 로컬 LLM(ollama)로 회상 컨텍스트가 기준을 만족하는지
//   PASS/FAIL 판정(temperature 0). 실패/미설정 = taskPass 미정 → runner fail-closed. proxy 보다 의미있으나
//   judge 모델 한계(qwen3.5:4b)는 정직 라벨. NAIA_BENCH_NO_JUDGE=1 = 끔(proxy). 강 judge = 모델/URL 환경변수.
const JUDGE_URL = process.env.NAIA_BENCH_JUDGE_URL || "http://127.0.0.1:11434/v1";
const JUDGE_MODEL = process.env.NAIA_BENCH_JUDGE_MODEL || "qwen3.5:4b";
const JUDGE_ENABLED = process.env.NAIA_BENCH_NO_JUDGE !== "1";
async function llmJudge(criterion, recalled) {
  const prompt = `너는 엄격한 채점관이다. 오직 아래 '회상된 정보'만 근거로 '기준' 만족 여부를 판정하라.\n기준: ${criterion}\n\n회상된 정보:\n${recalled || "(없음)"}\n\n만족하면 정확히 PASS, 아니면 정확히 FAIL — 한 단어만 출력.`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(`${JUDGE_URL}/chat/completions`, {
      method: "POST", signal: ac.signal,
      headers: { "content-type": "application/json", ...(process.env.NAIA_BENCH_JUDGE_KEY ? { Authorization: `Bearer ${process.env.NAIA_BENCH_JUDGE_KEY}` } : {}) },
      // ⚠️ max_tokens 충분히(1024) — thinking 모델(gemini-2.5-flash·qwen3.5)은 추론에 토큰을 쓴 뒤 마지막에
      //    PASS/FAIL 을 낸다. 8 로 잘리면 verdict 가 안 나와 undefined→거짓 fail(이 버그가 'task 0%' 의 원인이었음).
      body: JSON.stringify({ model: JUDGE_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 1024, stream: false }),
    });
    if (!r.ok) return undefined;
    const j = await r.json();
    const out = String(j.choices?.[0]?.message?.content || "").toUpperCase();
    // 추론 뒤 **마지막** 판정 단어 채택(추론 중 'FAIL할수도'처럼 둘 다 등장해도 결론 우선).
    const lastPass = out.lastIndexOf("PASS");
    const lastFail = out.lastIndexOf("FAIL");
    if (lastPass === -1 && lastFail === -1) return undefined;
    return lastPass > lastFail;
  } catch { return undefined; } finally { clearTimeout(t); }
}

// ── SUT 모드: recall(기본, 결정론·LLM無) | full-agent(memory 사전적재 + 실 agent recall→LLM→답변 생성) ──
const SUT_MODE = process.env.NAIA_BENCH_SUT || "recall";
const AGENT_PROVIDER = process.env.NAIA_BENCH_AGENT_PROVIDER || "ollama";
const AGENT_MODEL = process.env.NAIA_BENCH_AGENT_MODEL || "qwen3.5:4b";
const AGENT_KEY = process.env.NAIA_BENCH_AGENT_KEY; // 외부 provider(gemini/anthropic) 키 — ollama=불요

function newMemory() {
  const storeDir = mkdtempSync(join(tmpdir(), "naia-bench-"));
  return makeNaiaMemory({ storePath: join(storeDir, "store.json"), project: `bench-${randomUUID()}`, sessionId: `s-${randomUUID()}` });
}
// fixture turns → memory.save(user,assistant) 페어 사전적재(마지막 user flush·tool/system skip = HIGH#1 정합).
async function preloadMemory(memory, turns) {
  let pendingUser = null;
  for (const t of turns) {
    if (t.role === "user") { if (pendingUser !== null) await memory.save(pendingUser, ""); pendingUser = t.content; }
    else if (t.role === "assistant") { await memory.save(pendingUser ?? "", t.content); pendingUser = null; }
  }
  if (pendingUser !== null) await memory.save(pendingUser, "");
}

// full-agent SUT(적대리뷰 후속): 대화를 memory 에 사전적재 → probe 질문을 **실 agent(wireAgentUC1: 턴전 recall→
//   systemPrompt 주입→LLM 생성)**에 보내 답변을 생성하고 그 답변을 채점한다. recall-only 와 달리 raw 회상이 아니라
//   *추론된 답변* 을 judge/키워드로 평가 → 진짜 task-accuracy. agent provider = ollama(기본·$0) 또는 gemini/anthropic.
async function makeFullAgentSut() {
  const { makeProviderResolver } = await import("../dist/main/adapters/provider-resolver.js");
  const { wireAgentUC1, makeInMemoryCredentials } = await import("../dist/main/composition/index.js");
  const memory = newMemory();
  const resolver = makeProviderResolver();
  const credentials = makeInMemoryCredentials();
  const config = { provider: AGENT_PROVIDER, model: AGENT_MODEL };
  if (AGENT_KEY) credentials.update(AGENT_PROVIDER, { apiKey: AGENT_KEY });
  let routeCb = null;
  let pending = null;
  const ingress = { onRequest: (cb) => { routeCb = cb; return () => {}; } };
  const egress = { emit: (rid, e) => {
    if (!pending || rid !== pending.requestId) return;
    if (e.kind === "text") pending.acc += e.text;
    else if (e.kind === "finish") { const { resolve, acc } = pending; pending = null; resolve(acc); }
    else if (e.kind === "error") { const { resolve } = pending; pending = null; resolve(`[ERROR] ${e.message}`); }
  } };
  const wired = wireAgentUC1({ ingress, egress, resolver, credentials, memory, compaction: memory, defaultConfig: config });
  wired.start?.();
  const ask = (question) => new Promise((resolve) => {
    const requestId = randomUUID();
    pending = { requestId, acc: "", resolve };
    routeCb({ kind: "chat", requestId, messages: [{ role: "user", content: question }] });
  });
  const run = async (input) => {
    await preloadMemory(memory, input.turns);
    const answerCache = new Map();
    const askCached = async (q) => { if (!answerCache.has(q)) answerCache.set(q, await ask(q)); return answerCache.get(q); };
    // task-accuracy probe 는 question 이 없을 수 있다 → 같은 afterTurn 의 fact-recall question 사용(criterion=채점기준).
    const qFor = (probe) => probe.question || input.probes.find((p) => p.question && p.afterTurn === probe.afterTurn)?.question || probe.criterion;
    const responses = [];
    for (let i = 0; i < input.probes.length; i++) {
      const probe = input.probes[i];
      const answer = await askCached(qFor(probe));
      if (probe.type === "fact-recall") responses.push({ probeIndex: i, answer });
      else if (probe.type === "task-accuracy") {
        const taskPass = JUDGE_ENABLED ? await llmJudge(probe.criterion, answer) : answer.trim().length > 0;
        if (process.env.NAIA_BENCH_DEBUG === "1") process.stderr.write(`  [task probe ${i}] verdict=${taskPass}\n   답변: ${String(answer).replace(/\s+/g, " ").slice(0, 300)}\n   기준: ${String(probe.criterion).slice(0, 160)}\n`);
        responses.push({ probeIndex: i, answer, ...(taskPass !== undefined ? { taskPass } : {}) });
      } else responses.push({ probeIndex: i, answer, baselineAnswer: answer });
    }
    return responses;
  };
  return { sut: { run }, close: async () => { try { if (wired.drain) await wired.drain(); } catch { /* best-effort */ } await memory.close(); } };
}

// fixture 당 신선한 naia-memory(독립 store/project) — 회상이 fixture 간 누설되지 않게.
async function makeSut() {
  const storeDir = mkdtempSync(join(tmpdir(), "naia-bench-"));
  const memory = makeNaiaMemory({
    storePath: join(storeDir, "store.json"),
    project: `bench-${randomUUID()}`,
    sessionId: `s-${randomUUID()}`,
  });
  let pendingUser = null; // user→assistant 페어로 memory.save(user, assistant) 호출
  const flushPending = async () => { if (pendingUser !== null) { await memory.save(pendingUser, ""); pendingUser = null; } };
  const save = async (turn) => {
    if (turn.role === "user") {
      await flushPending();            // 연속 user → 직전 user 단독 저장
      pendingUser = turn.content;
    } else if (turn.role === "assistant") {
      await memory.save(pendingUser ?? "", turn.content);
      pendingUser = null;
    }
    // ⚠️ tool/system 역할은 저장 안 함 — memory.save(x,"") 는 무조건 user 로 encode 라 tool/system 출력이
    //    "사용자가 말함" provenance 로 오염된다(적대리뷰 bench HIGH#1). user/assistant 쌍만 재생.
  };
  const recall = async (query) => {
    await flushPending();              // ⚠️ 마지막 unpaired user 턴(probe 직전) 누락 방지(적대리뷰 bench HIGH#1)
    return formatRecalledMemory(await memory.recall(query));
  };
  // task-accuracy = 실 LLM judge(가용 시) — createRecallSut 의 'non-empty' proxy 대신 judge 주입(적대리뷰 bench HIGH#2).
  const run = async (input) => {
    for (const turn of input.turns) await save({ role: turn.role, content: turn.content });
    const responses = [];
    for (let i = 0; i < input.probes.length; i++) {
      const probe = input.probes[i];
      if (probe.type === "fact-recall") {
        responses.push({ probeIndex: i, answer: await recall(probe.question) });
      } else if (probe.type === "task-accuracy") {
        const recalled = await recall(probe.criterion);
        const taskPass = JUDGE_ENABLED ? await llmJudge(probe.criterion, recalled) : recalled.trim().length > 0;
        responses.push({ probeIndex: i, answer: recalled, ...(taskPass !== undefined ? { taskPass } : {}) });
      } else {
        const a = await recall(probe.question);
        responses.push({ probeIndex: i, answer: a, baselineAnswer: a }); // drift baseline 미주입 = 1.0(현 fixture drift probe 0)
      }
    }
    return responses;
  };
  return { sut: { run }, close: () => memory.close() };
}

const allFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".fixture.json")).sort();
const LIMIT = Number(process.env.NAIA_BENCH_LIMIT) || allFiles.length;
const files = allFiles.slice(0, LIMIT);
const results = [];
const timings = [];
for (const f of files) {
  const fixture = JSON.parse(readFileSync(join(fixturesDir, f), "utf8"));
  let r, ms;
  process.stderr.write(`[bench] ${f} 시작 (SUT=${SUT_MODE})...\n`);
  try {
    const { sut, close } = SUT_MODE === "full-agent" ? await makeFullAgentSut() : await makeSut();
    const t0 = process.hrtime.bigint();
    r = await runFixture(fixture, sut);
    ms = Number(process.hrtime.bigint() - t0) / 1e6;
    await close();
    process.stderr.write(`[bench] ${f} 완료 ${ms.toFixed(0)}ms pass=${r.pass}\n`);
  } catch (e) {
    r = { fixtureId: fixture.id ?? f, scores: { factRecall: 0, taskAccuracy: 0, driftScore: 0 }, pass: false, details: [], errors: [`driver/validate error: ${e instanceof Error ? e.message : String(e)}`] };
    ms = 0;
  }
  results.push(r);
  timings.push({ id: r.fixtureId, ms });
}

console.log(formatReport(results));

// ── 정직 요약 (적대리뷰 bench HIGH#2) ──
// factRecall = 유효 신호(결정론 키워드 생존). taskAccuracy = "회상 비어있지않음" proxy(LLM judge 부재)라 항상
//   ~1.0 → 신호 아님. 특히 abstention/knowledge-update 처럼 *비-회상/구분이 정답*인 케이스를 거꾸로 PASS
//   시키므로 게이트·평균에서 **제외하고 '미측정'으로 표기**. 진짜 task judge = LLM 연동 후속(ollama/claude-code-cli 가용).
const hasFact = (r) => r.details.some((d) => d.type === "fact-recall");
const factFix = results.filter(hasFact);
const taskOnly = results.filter((r) => !hasFact(r));
const factPass = factFix.filter((r) => r.scores.factRecall >= 1.0).length;
const avgFR = factFix.length ? factFix.reduce((a, r) => a + r.scores.factRecall, 0) / factFix.length : 0;
const sutLabel = SUT_MODE === "full-agent" ? `full-agent(${AGENT_PROVIDER}/${AGENT_MODEL}) — memory 사전적재 → recall→LLM→답변` : "recall-only(naia-memory LocalAdapter · 키워드)";
console.log(`\n## 요약 (SUT = ${sutLabel})`);
console.log("### factRecall — 유효 신호(생성 답변의 키워드 생존)");
console.log(`- fact-recall fixture: ${factFix.length} · 완전회상(=1.0): ${factPass} · 부분/실패: ${factFix.length - factPass}`);
console.log(`- 평균 factRecall: ${(avgFR * 100).toFixed(1)}%  (${SUT_MODE === "full-agent" ? "생성 답변 기준 — 회상 못 한 사실은 LLM 도 진술 못 함(메모리 회상이 병목)" : "키워드-only 바닥값 — 실패는 주로 숫자/식별자/고유명사 = 임베딩·LLM recap 영역"})`);
if (JUDGE_ENABLED) {
  const taskFix = results.filter((r) => r.details.some((d) => d.type === "task-accuracy"));
  const taskPass = taskFix.filter((r) => r.scores.taskAccuracy >= 1.0).length;
  const avgTA = taskFix.length ? taskFix.reduce((a, r) => a + r.scores.taskAccuracy, 0) / taskFix.length : 0;
  console.log(`### taskAccuracy — 측정 (LLM judge=${JUDGE_MODEL} @ ${JUDGE_URL}, temp 0)`);
  console.log(`- task-accuracy fixture: ${taskFix.length} · 전부통과(=1.0): ${taskPass} · 평균: ${(avgTA * 100).toFixed(1)}%`);
  if (SUT_MODE === "full-agent") {
    console.log(`  (full-agent: memory 사전적재 → 실 agent recall→LLM 생성 답변을 judge 채점 = 진짜 답변 품질. 답변 품질의 상한은 메모리 회상.)`);
  } else {
    console.log(`  ⚠️ 이 SUT 는 recall-only(LLM 생성 없음) — raw 회상을 답으로 judge 에 넘김. 답변품질 criteria 는 추론 답변을 요구하므로`);
    console.log(`     0%대가 구조적으로 정상(qwen·gemini judge 동일 0%). 진짜 task-accuracy = NAIA_BENCH_SUT=full-agent.`);
  }
} else {
  console.log("### taskAccuracy — ⚠️ 미측정 (proxy 'recall 비어있지않음', 게이트 제외)");
  console.log(`- task-accuracy-only fixture(유효 판정 불가): ${taskOnly.length}${taskOnly.length ? " — " + taskOnly.map((r) => r.fixtureId).join(", ") : ""}`);
}
console.log("- 지연(fixture 재생+회상, wall-clock):");
const lat = timings.map((t) => t.ms).filter((m) => m > 0).sort((a, b) => a - b);
if (lat.length) {
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
  console.log(`  p50=${pct(50).toFixed(1)}ms · p95=${pct(95).toFixed(1)}ms · max=${lat[lat.length - 1].toFixed(1)}ms`);
}
for (const t of timings) console.log(`  ${t.id}: ${t.ms.toFixed(1)}ms`);
