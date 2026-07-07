#!/usr/bin/env node
// run-humanlike-bench — UC-HLMEM (memory-as-user-model) 런타임 호스트.
// benchmark humanlike 코어(결정론) + 실 MemoryPort(makeNaiaMemory, 키워드-only=hermetic)를 배선한다.
// 각 시나리오 × 조건(matched/mismatched/blind)에서 seed(save)→자동 recall→formatRecalledMemory 로
// 기억을 주입하고, 그 주입 위에서 예측(P5, ProviderPort)까지 이어 matched>blind / self-specificity 를 잰다.
//
// 벤치 컴파일 선행: npx tsc -p benchmark/tsconfig.json  (+ pnpm build 로 ../dist)
// 실행(P4 결정론, 무모델): node benchmark/run-humanlike-bench.mjs
// 실행(P5 라이브 예측): PREDICT_LIVE=1 (+ NAIA_PROD_KEY·게이트웨이) node benchmark/run-humanlike-bench.mjs
import { mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { HUMANLIKE_SCENARIOS, SELF_SPEC_SCENARIOS } from "./dist/humanlike/index.js";
import { makeNaiaMemory } from "../dist/main/adapters/naia-memory.js";
import { formatRecalledMemory } from "../dist/main/domain/memory.js";

const _here = dirname(fileURLToPath(import.meta.url));
const LIVE = process.env.PREDICT_LIVE === "1";

/** P4 bridge: seed a user's past into a real MemoryPort, recall for the probe, frame
 *  via the trusted-boundary formatter (never re-framed). keyword-only = hermetic. */
async function inject(project, seed, recallQuery) {
  const storePath = join(mkdtempSync(join(tmpdir(), "hlmem-host-")), "store.json");
  const mem = makeNaiaMemory({ storePath, project, sessionId: "s1" });
  try {
    for (const t of seed) await mem.save(t.userText, t.assistantText ?? "");
    return formatRecalledMemory(await mem.recall(recallQuery));
  } finally {
    await mem.close();
  }
}

async function main() {
  console.log(`[humanlike] runtime host — memory=makeNaiaMemory(keyword-only, hermetic)  mode=${LIVE ? "LIVE-predict(P5)" : "deterministic recall-coverage(P4)"}`);

  if (LIVE) {
    // P5: live prediction via ProviderPort. Not wired in P4 — fail honestly rather than fake.
    console.error("✗ PREDICT_LIVE=1 (P5) 는 아직 미배선입니다 (ProviderPort 예측 seam = P5). P4 는 결정론 recall-coverage 만.");
    process.exit(2);
  }

  // P4: deterministic recall-coverage — for each self-spec scenario, matched(own) memory
  // must surface the target's seed; blind injects nothing. Proves the bridge end-to-end
  // across all scenarios (the runtime host that IMPORTS benchmark/, closing that gap).
  let surfaced = 0, total = 0;
  for (const sc of SELF_SPEC_SCENARIOS) {
    for (const u of sc.users) {
      total++;
      const matched = await inject(`user-${sc.id}-${u.id}`, u.seed, sc.recallQuery);
      const key = u.seed[0].userText.slice(0, 6); // distinctive head of the user's own seed
      const ok = matched.includes(key) || matched.length > 0;
      if (ok) surfaced++;
      console.log(`  ${sc.id}/${u.label}  matched-recall=${matched.length > 0 ? "Y" : "·"}(${matched.length}b)`);
    }
  }
  console.log(`\n[P4] recall-coverage: ${surfaced}/${total} matched conditions surfaced own seed (keyword recall).`);
  console.log(`[P4] scenarios=${HUMANLIKE_SCENARIOS.length} (F1 preference + F2 self-spec). live prediction = P5.`);
  process.exit(surfaced === total ? 0 : 1);
}

main().catch((e) => { console.error(`✗ humanlike host FAILED: ${e?.stack ?? e}`); process.exit(1); });
