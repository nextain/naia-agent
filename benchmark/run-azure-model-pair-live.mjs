#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const output = value("--output");
if (!output) throw new Error("--output is required");
const outputPath = resolve(output);
if (existsSync(outputPath)) throw new Error("output path already exists");
const key = (process.env.NAIA_API_KEY ?? process.env.NAIA_ANYLLM_API_KEY)?.trim();
if (!key) throw new Error("NAIA_API_KEY or NAIA_ANYLLM_API_KEY is required");
if (!args.includes("--confirm-paid-comparison") || process.env.NAIA_PI_COST_CONFIRM !== "1") {
  throw new Error("paid comparison requires --confirm-paid-comparison and NAIA_PI_COST_CONFIRM=1");
}

const snapshot = JSON.parse(readFileSync(new URL("./orchestration/azure-price-snapshot-2026-08-01.json", import.meta.url), "utf8"));
const rates = {
  "deepseek-v4-flash": snapshot.models["azure:DeepSeek-V4-Flash"],
  "grok-4.3": snapshot.models["azure:grok-4.3"],
};
const task = "Create src/answer.js exporting const answer = 42 and do not modify any other tracked file.";
const stages = [
  ["facing", "Classify the request and restate it in one short sentence."],
  ["moderator", "List the acceptance obligations as compact JSON."],
  ["explorer", "Propose the content of src/answer.js."],
  ["implementer", "What should the complete content of src/answer.js be?"],
  ["tester", "Assess the proposed content `export const answer = 42;`. Assume it is placed at src/answer.js and no other tracked file changes. Reply PASS or FAIL only."],
  ["reviewer", "Review the proposed content `export const answer = 42;`. Assume it is placed at src/answer.js and no other tracked file changes. Reply CLEAN or one defect."],
  ["tester", "Independently reassess the same proposed content under the same assumptions. Reply PASS or FAIL only."],
  ["reviewer", "Perform a second independent review of the same proposed content under the same assumptions. Reply CLEAN or one defect."],
  ["reporter", "Summarize completion in one sentence without adding requirements."],
];
const policies = {
  candidate: Object.fromEntries(stages.map(([role]) => [role, role === "implementer" ? "grok-4.3" : "deepseek-v4-flash"])),
  control: Object.fromEntries(stages.map(([role]) => [role, "grok-4.3"])),
};

const result = { schemaVersion: 1, benchmarkId: "azure-deepseek-grok-paired-v1", executedAt: new Date().toISOString(),
  status: "running", task, priceSnapshot: snapshot, budget: { maximumCalls: 18, maximumAzureBaseUsd: "0.50000000" }, arms: {} };
persist(result, "wx");
let calls = 0;
let totalCost = 0;
try {
  for (const [arm, policy] of Object.entries(policies)) {
    const rows = [];
    for (let index = 0; index < stages.length; index += 1) {
      if (calls >= 18) throw new Error("call budget exhausted");
      const [role, instruction] = stages[index];
      const model = policy[role];
      const started = performance.now();
      const requestId = `azure-bench-${randomUUID()}`;
      const row = { sequence: index + 1, role, model, requestId, status: "in_flight" };
      rows.push(row); calls += 1;
      result.arms[arm] = { status: "running", calls: rows.length, rows };
      result.calls = calls; persist(result);
      const response = await fetch("https://api.nextain.io/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "X-AnyLLM-Key": `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "system", content: "You are assisting with a small JavaScript exercise." },
          { role: "user", content: `${task}\n\nRole: ${role}\n${instruction}` }], max_tokens: 160, temperature: 0,
          stream: false, gateway_request_id: requestId, gateway_attempt: 1 }),
        signal: AbortSignal.timeout(120_000),
      });
      const payload = await response.json();
      if (!response.ok) {
        Object.assign(row, { status: "failed", httpStatus: response.status, payload,
          latencyMs: Math.round(performance.now() - started) });
        throw new Error(`${arm}/${role}/${model} failed: HTTP ${response.status}`);
      }
      if (payload.model !== model) {
        Object.assign(row, { status: "failed", responseId: payload.id, responseModel: payload.model,
          latencyMs: Math.round(performance.now() - started) });
        throw new Error(`${arm}/${role} response model mismatch: requested=${model} response=${payload.model}`);
      }
      const usage = payload.usage ?? {};
      const inputTokens = integer(usage.prompt_tokens, "prompt_tokens");
      const outputTokens = integer(usage.completion_tokens, "completion_tokens");
      const cachedInputTokens = Math.min(inputTokens, optionalInteger(usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens));
      const azureBaseUsd = azureCost(rates[model], inputTokens, cachedInputTokens, outputTokens);
      totalCost += azureBaseUsd;
      Object.assign(row, { status: "settled", responseId: payload.id, responseModel: payload.model,
        inputTokens, cachedInputTokens, outputTokens, latencyMs: Math.round(performance.now() - started),
        azureBaseUsd: Number(azureBaseUsd.toFixed(10)), output: payload.choices?.[0]?.message?.content ?? "" });
      persist(result);
      if (totalCost > 0.5) throw new Error("Azure base cost budget exceeded");
    }
    const implementer = rows.find((row) => row.role === "implementer");
    const normalized = String(implementer?.output ?? "").replace(/^```(?:javascript|js)?\s*/u, "").replace(/\s*```$/u, "").trim();
    const testerPasses = rows.filter((row) => row.role === "tester").map((row) => String(row.output).trim().toUpperCase() === "PASS");
    const reviewerCleans = rows.filter((row) => row.role === "reviewer").map((row) => String(row.output).trim().toUpperCase() === "CLEAN");
    const quality = { exactProposedContent: normalized === "export const answer = 42;", proposedContent: normalized,
      testerPasses, reviewerCleans, allChecksPass: normalized === "export const answer = 42;"
        && testerPasses.length === 2 && testerPasses.every(Boolean) && reviewerCleans.length === 2 && reviewerCleans.every(Boolean) };
    const azureBaseUsd = rows.reduce((sum, settled) => sum + settled.azureBaseUsd, 0);
    result.arms[arm] = { status: quality.allChecksPass ? "completed" : "failed", quality, calls: rows.length,
      inputTokens: rows.reduce((sum, settled) => sum + settled.inputTokens, 0),
      cachedInputTokens: rows.reduce((sum, settled) => sum + settled.cachedInputTokens, 0),
      outputTokens: rows.reduce((sum, settled) => sum + settled.outputTokens, 0),
      latencyMs: rows.reduce((sum, settled) => sum + settled.latencyMs, 0), azureBaseUsd: Number(azureBaseUsd.toFixed(10)), rows };
    persist(result);
  }
  const candidate = result.arms.candidate; const control = result.arms.control;
  result.comparison = { qualityComparable: candidate.status === "completed" && control.status === "completed",
    azureBaseSavingsUsd: Number((control.azureBaseUsd - candidate.azureBaseUsd).toFixed(10)),
    azureBaseSavingsPercent: Number(((1 - candidate.azureBaseUsd / control.azureBaseUsd) * 100).toFixed(4)),
    latencyDeltaPercent: Number(((candidate.latencyMs / control.latencyMs - 1) * 100).toFixed(4)),
    claimAllowed: candidate.status === "completed" && control.status === "completed" && candidate.azureBaseUsd < control.azureBaseUsd };
  result.status = "completed";
  result.calls = calls;
  persist(result);
  process.stdout.write(`${JSON.stringify({ status: "completed", output: outputPath, calls,
    candidate: { status: candidate.status, azureBaseUsd: candidate.azureBaseUsd, latencyMs: candidate.latencyMs },
    control: { status: control.status, azureBaseUsd: control.azureBaseUsd, latencyMs: control.latencyMs }, comparison: result.comparison }, null, 2)}\n`);
} catch (error) {
  result.status = "unavailable";
  result.calls = calls;
  result.failure = { message: error instanceof Error ? error.message : String(error),
    costState: result.arms && Object.values(result.arms).some((arm) => arm.rows?.some((row) => row.status !== "settled")) ? "unknown" : "partially_measured" };
  persist(result);
  throw error;
}

function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function integer(candidate, label) { if (!Number.isSafeInteger(candidate) || candidate < 0) throw new Error(`${label} unavailable`); return candidate; }
function optionalInteger(candidate) { return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0; }
function persist(payload, flag = "w") { writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag }); }
function azureCost(rate, input, cached, outputTokens) {
  const uncached = input - cached;
  return (uncached * Number(rate.input) + cached * Number(rate.cachedInput) + outputTokens * Number(rate.output)) / 1_000_000;
}
