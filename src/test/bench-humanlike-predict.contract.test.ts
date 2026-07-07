/** @uc UC-HLMEM (FR-HLMEM-7) 예측 seam(P5) — 라이브 LLM 없이 fake ProviderPort 로 배선 검증.
 *  seed→(P4 주입)→predict via ProviderPort→parsePrediction→buildResult→summarize 파이프라인이
 *  결정론적으로 옳게 도는지. 실 게이트웨이 e2e(matched>blind)는 크레딧 소모 = 별도(사람 확인). */
import { describe, it, expect } from "vitest";
import type { ProviderPort } from "../main/ports/uc1.js";
import type { ChatMessage, ProviderConfig, ProviderChunk } from "../main/domain/chat.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import { buildResult, summarize, parsePrediction } from "../../benchmark/src/humanlike/index.js";
import type { HumanlikeResult } from "../../benchmark/src/humanlike/index.js";

const CFG: ProviderConfig = { provider: "fake", model: "fake" };

/** The P5 prediction seam: predict via ProviderPort (the ONLY sanctioned LLM path —
 *  no raw client), collecting text chunks into a response string. */
async function predictOnce(provider: ProviderPort, systemPrompt: string, probe: string): Promise<string> {
  const messages: ChatMessage[] = [{ role: "user", content: probe }];
  let text = "";
  for await (const ch of provider.chat(CFG, messages, { systemPrompt })) {
    const c = ch as ProviderChunk;
    if (c.kind === "text") text += c.text;
  }
  return text;
}

/** memory-aware fake: replies the correct label IFF the injected memory marker is in the
 *  systemPrompt (simulates "memory improves prediction") — deterministic, no LLM. */
function memoryAwareFake(marker: string, correctLabel: "A" | "B"): ProviderPort {
  const other = correctLabel === "A" ? "B" : "A";
  return {
    async *chat(_c, _m, opts): AsyncIterable<ProviderChunk> {
      const label = (opts.systemPrompt ?? "").includes(marker) ? correctLabel : other;
      yield { kind: "text", text: `예측: ${label}\n이유` };
      yield { kind: "finish" };
    },
  };
}

describe("UC-HLMEM P5 예측 seam (fake ProviderPort, no live LLM)", () => {
  it("provider.chat text 청크를 모아 예측 문자열을 만든다", async () => {
    const r = await predictOnce(makeFakeProvider("예측: A\n채식이라 채소집"), "", "…(A) X (B) Y…");
    expect(parsePrediction(r)).toBe("A");
  });

  it("전체 파이프라인: matched(기억 주입)=correct, blind(무주입)=wrong → memoryLift +1.0", async () => {
    const marker = "MEMORY__PREFERS__A";
    const provider = memoryAwareFake(marker, "A"); // 이 trial 의 정답 라벨 = A
    const probe = "모임 장소? 후보는 (A) 채소집 (B) 고기집. 뭐 고를 것 같아?";

    // matched: 기억 주입(marker 포함) → provider 가 A(정답) 예측
    const mText = await predictOnce(provider, `사용자에 대해: ${marker}`, probe);
    // blind: 무주입 → provider 가 B(오답) 예측
    const bText = await predictOnce(provider, "", probe);

    const results: HumanlikeResult[] = [
      buildResult({ scenarioId: "s", targetUserId: "u", condition: "matched", correctLabel: "A", responseText: mText, recallReturnedTarget: true, memoryInjected: true }),
      buildResult({ scenarioId: "s", targetUserId: "u", condition: "blind", correctLabel: "A", responseText: bText, recallReturnedTarget: false, memoryInjected: false }),
    ];
    expect(results[0]!.outcome).toBe("correct");
    expect(results[1]!.outcome).toBe("wrong");
    const s = summarize(results);
    expect(s.matched.accuracy).toBe(1);
    expect(s.blind.accuracy).toBe(0);
    expect(s.memoryLift).toBe(1);
  });

  it("빈 completion(자격/토큰 실패 모사) → exec-error 로 분리(예측실패 아님)", async () => {
    const empty = makeFakeProvider(""); // 빈 응답
    const r = buildResult({ scenarioId: "s", targetUserId: "u", condition: "matched", correctLabel: "A", responseText: await predictOnce(empty, "", "…"), recallReturnedTarget: true, memoryInjected: true });
    expect(r.outcome).toBe("exec-error");
  });
});
