#!/usr/bin/env node
// check-canon-conformance — file-anchor 게이트의 구멍(자기-작성 계약 통과)을 닫는다.
// file-anchor 는 "파일이 *어떤* 계약에 묶였나"만 본다 → AI 가 제 계약(UC-memory)을 써넣으면 GREEN.
// 이 게이트는 그 UC 가 **정본 canon-scope.json 의 in_scope 에 있나**를 본다. out_of_scope 면 RED.
// = 정본을 "문서"가 아니라 "결정론 게이트"로 승격(drift-thesis). 0 토큰·LLM 없음.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = process.env.CI_PROJECT_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, ".agents/context/module-manifest.json"), "utf8"));
const canon = JSON.parse(readFileSync(join(ROOT, ".agents/context/canon-scope.json"), "utf8"));
const inScope = new Set(canon.in_scope_uc);
const outScope = canon.out_of_scope_uc || {};
const errs = [];
for (const [file, a] of Object.entries(manifest.files || {})) {
  for (const uc of (a.uc || [])) {
    if (uc in outScope) errs.push(`OUT-OF-SCOPE: ${file} → UC '${uc}' = 정본 범위 밖. ${outScope[uc]}`);
    else if (!inScope.has(uc)) errs.push(`UNKNOWN-SCOPE: ${file} → UC '${uc}' 가 canon in_scope 에 없음(미승인).`);
  }
}

// ── transport 정합 (single_transport.canonical) — 골 #1 "스크립트가 계약 외 드리프트 검출". ──
// canon=grpc 인데 os↔agent 활성 transport 가 아직 stdio adapter 면 TRANSPORT-DRIFT(RED). gRPC 이식 완료 시 GREEN.
// (contract-first: 정본을 강제하면 현 stdio 상태가 정직하게 RED 로 표면화 — 이게 내가 못 잡던 드리프트의 앵커.)
const transport = canon.single_transport || {};
if (transport.canonical === "grpc") {
  const STDIO_MARKERS = ["makeStdioIngress", "makeStdioEgress"];
  const scan = ["src/main/composition/index.ts", "scripts/builds/agent-stdio-entry.mjs"];
  for (const rel of scan) {
    let src;
    try { src = readFileSync(join(ROOT, rel), "utf8"); } catch { continue; }
    for (const m of STDIO_MARKERS) {
      if (src.includes(m)) errs.push(`TRANSPORT-DRIFT: ${rel} 가 '${m}'(stdio) 를 활성 transport 로 사용 — canon single_transport=grpc. gRPC adapter 로 교체 필요. (${transport.rule})`);
    }
  }
}

// ── storage 정합 (storage.canonical=naia-adk/naia-settings) — naia-settings-store 가 naia-adk 경로를 읽나. ──
const storage = canon.storage || {};
if (storage.canonical && storage.canonical.includes("naia-settings")) {
  let src;
  try { src = readFileSync(join(ROOT, "src/main/adapters/naia-settings-store.ts"), "utf8"); } catch { src = ""; }
  if (src && !src.includes("naia-settings")) errs.push(`STORAGE-DRIFT: naia-settings-store 가 naia-adk/naia-settings 를 참조하지 않음 — canon storage=${storage.canonical}.`);
}
if (errs.length) {
  console.error(`[canon-conformance] RED — ${errs.length}건 정본 범위 위반(자기-작성 계약이어도 차단):`);
  for (const e of errs) console.error("  ✗ " + e);
  process.exit(1);
}
console.log("[canon-conformance] OK — 모든 파일의 UC 가 정본 in_scope 안.");
process.exit(0);
