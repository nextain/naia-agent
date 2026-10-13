#!/usr/bin/env node
// Issue #82 — Ollama 0.32.1 + thinking=ON 모델별 원자료를 단일 추적 증적으로 합친다.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE_NAMES = [
  "v3p-dna35b.json",
  "v3p-qwen27b.json",
  "v3p-gemma31b.json",
  "v3p-gemma-e4b.json",
  "v3p-qwen8b-abl.json",
  "v3p-qwen8b-jos.json",
];
const SOURCE_DIR = resolve(ROOT, process.env.TS_SOURCE_DIR || ".agents/work");
const OUT = resolve(
  ROOT,
  process.env.TS_OUT || ".agents/reviews/issue-82-v3-panel-ollama032-thinking-on-2026-07-18.json",
);

const sources = SOURCE_NAMES.map((name) => {
  const path = resolve(SOURCE_DIR, name);
  const raw = readFileSync(path);
  const data = JSON.parse(raw);
  if (data.ollamaVersion !== "0.32.1" || data.thinking !== true) {
    throw new Error(`${name}: 통제 변수 불일치(version=${data.ollamaVersion}, thinking=${data.thinking})`);
  }
  return {
    name,
    sha256: createHash("sha256").update(raw).digest("hex"),
    data,
  };
});

const rows = sources.flatMap(({ data }) => data.byModelVariant);
const rawResults = sources.flatMap(({ data }) => data.results);
const sum = (selected, field) => selected.reduce((n, row) => n + row[field], 0);
const aggregate = (variant, group, excludeIds = []) => {
  const selected = rawResults.filter(
    (row) =>
      !row.excluded &&
      row.variant === variant &&
      row.group === group &&
      !excludeIds.includes(row.id),
  );
  return {
    valid: sum(selected, "valid"),
    called: sum(selected, "called"),
    r0Activate: sum(selected, "r0Activate"),
    r1Activate: sum(selected, "r1Activate"),
    errors: sum(selected, "errors"),
  };
};
const modelTier = (model) =>
  /dna3\.0-35b|qwen3\.6:27b|gemma4:31b/.test(model) ? "24G" : "lower-tier-reference";

const evidence = {
  measurement: "Issue #82 v3.1 activation hinge — six-model panel",
  generatedAt: new Date().toISOString(),
  environment: {
    host: "bazzite development PC, GPU1",
    ollamaVersion: "0.32.1",
    thinking: true,
    runsPerProbe: 3,
    note: "All six models used the same Ollama version and explicit thinking=true.",
  },
  decision: {
    selectedDescription: "desc-b",
    selectedRule: "R1",
    rule:
      "called ∧ faithful non-empty awayEvidence ∧ faithful non-empty userRequestQuote ∧ neither normalized quote contains the other ∧ disjoint source spans",
    labelCorrection:
      "P-AMB-006('잠들 때까지 얘기해줘') contains a passive-listening/away duration signal and is not one-only; corrected one-only metrics exclude it.",
  },
  pooled: {
    allModels: {
      positive: aggregate("desc-b", "positive"),
      oneOnlyRaw: aggregate("desc-b", "oneOnly"),
      oneOnlyLabelCorrected: aggregate("desc-b", "oneOnly", ["P-AMB-006"]),
      awayOnly: aggregate("desc-b", "awayOnly"),
      negativeFalseCallers: aggregate("desc-b", "negFalseCaller"),
    },
    tier24G: Object.fromEntries(
      ["positive", "oneOnly", "awayOnly", "negFalseCaller"].map((group) => {
        const tierRows = rawResults.filter(
          (row) =>
            row.variant === "desc-b" &&
            row.group === group &&
            modelTier(row.model) === "24G" &&
            !(group === "oneOnly" && row.id === "P-AMB-006"),
        );
        return [
          group,
          {
            valid: sum(tierRows, "valid"),
            called: sum(tierRows, "called"),
            r0Activate: sum(tierRows, "r0Activate"),
            r1Activate: sum(tierRows, "r1Activate"),
            errors: sum(tierRows, "errors"),
          },
        ];
      }),
    ),
  },
  byModelVariant: rows.map((row) => ({ ...row, tier: modelTier(row.model) })),
  sources: sources.map(({ name, sha256 }) => ({ name, sha256 })),
  rawResults,
};

writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(OUT);
