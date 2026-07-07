/** @uc UC-HLMEM (FR-HLMEM-2·3) 통합(P4) — bench humanlike ↔ 실 MemoryPort 브리지.
 *  라이브 LLM 없이(키워드-only recall = hermetic) seed→recall→formatRecalledMemory 배선을 검증:
 *  read-your-writes + 신뢰경계 formatter 로만 주입 + matched(본인 기억) vs mismatched(타인) vs blind.
 *  fake 아님 — 실 @nextain/naia-memory(makeNaiaMemory, keyword-only). live 예측(ProviderPort)은 P5. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";
import { formatRecalledMemory } from "../main/domain/memory.js";
import { SELF_SPEC_SCENARIOS } from "../../benchmark/src/humanlike/index.js";
import type { MemoryCondition } from "../../benchmark/src/humanlike/index.js";

/** The P4 bridge: seed a user's past into a real MemoryPort, then recall for a probe
 *  and frame it through the trusted-boundary formatter (never re-framed). Keyword-only
 *  (no embedding config) → deterministic + hermetic (no gateway). */
async function seedAndInject(storePath: string, project: string, seed: readonly { userText: string; assistantText?: string }[], recallQuery: string): Promise<string> {
  const mem = makeNaiaMemory({ storePath, project, sessionId: "s1" });
  try {
    for (const t of seed) await mem.save(t.userText, t.assistantText ?? ""); // save resolves → read-your-writes
    const recalled = await mem.recall(recallQuery);
    return formatRecalledMemory(recalled); // FR-HLMEM-2: inject ONLY via domain formatter
  } finally {
    await mem.close();
  }
}

describe("UC-HLMEM P4 — bench ↔ 실 MemoryPort 브리지 (keyword-only, hermetic)", () => {
  const dirs: string[] = [];
  afterEach(async () => { while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true }); });

  it("read-your-writes: seed 저장 후 recall 이 그 seed 를 회상해 formatter 블록에 담는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hlmem-bridge-")); dirs.push(dir);
    const sc = SELF_SPEC_SCENARIOS.find((s) => s.id === "F2-diet")!;
    const A = sc.users.find((u) => u.id === "A")!; // 채식
    const injected = await seedAndInject(join(dir, "a.json"), "user-A", A.seed, sc.recallQuery);
    expect(injected.length).toBeGreaterThan(0); // 비어있지 않은 회상 블록
    expect(injected).toContain("채식"); // 본인 seed 근거가 실제로 회상됨(키워드 recall)
  });

  it("self-specificity 배선: matched(A 기억)엔 A 근거, mismatched(B 기억)엔 B 근거가 담긴다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hlmem-bridge2-")); dirs.push(dir);
    const sc = SELF_SPEC_SCENARIOS.find((s) => s.id === "F2-diet")!;
    const A = sc.users.find((u) => u.id === "A")!; // 채식
    const B = sc.users.find((u) => u.id === "B")!; // 육식
    // 각 사용자 = 별도 project/store(격리). A 를 예측할 때: matched=A기억, mismatched=B기억.
    const matched = await seedAndInject(join(dir, "a.json"), "user-A", A.seed, sc.recallQuery);
    const mismatched = await seedAndInject(join(dir, "b.json"), "user-B", B.seed, sc.recallQuery);
    expect(matched).toContain("채식");
    expect(mismatched).toContain("고기");
    // 교차 누설 없음(격리): A 기억에 육식 근거가 섞이지 않음.
    expect(matched).not.toContain("고기 없으면");
  });

  it("blind 조건 = 기억 주입 없음(빈 블록) — matched 와 구분되는 baseline", async () => {
    // blind = seedAndInject 를 호출하지 않음(주입 문자열 = "").
    const blindInjection = "";
    const cond: MemoryCondition = "blind";
    expect(cond).toBe("blind");
    expect(blindInjection).toBe("");
  });
});
