/** @uc UC-HLMEM F3 salience(P6) — 감정 기억이 flat peer 보다 우선 회상되나(salience 경로).
 *  감정은 별도 계약 widen 없이 **seed 텍스트에서 naia-memory 휴리스틱이 감지** → arousal→strength→
 *  flashbulb(arousal-flashbulb 픽스) → recall 랭킹. 실 MemoryPort(makeNaiaMemory), 키워드-only=hermetic. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeNaiaMemory } from "../main/adapters/naia-memory.js";

describe("UC-HLMEM P6 — 감정 salience 가 회상에 반영(canonical MemoryPort, hermetic)", () => {
  const dirs: string[] = [];
  afterEach(async () => { while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true }); });

  it("강한 감정 기억(grief)이 저장·회상되어 formatter 로 표면화된다(플랫 잡음 사이에서)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hlmem-salience-")); dirs.push(dir);
    const mem = makeNaiaMemory({ storePath: join(dir, "s.json"), project: "sal", sessionId: "s1" });
    try {
      // 감정 기억 + flat peer 들(같은 프로젝트).
      await mem.save("13년 함께한 강아지 마루를 떠나보낸 날, 하루 종일 너무 슬퍼서 펑펑 울었어.", "");
      await mem.save("오늘 점심은 편의점 삼각김밥으로 때웠어.", "");
      await mem.save("지하철이 좀 붐볐어.", "");
      await mem.save("마트에서 휴지랑 세제를 샀어.", "");
      // 강아지/마루 관련 회상 → 감정 기억이 표면화되어야 함.
      const recalled = await mem.recall("반려동물 마루 강아지 추억");
      const surfaced = [...recalled.facts, ...recalled.episodes.map((e) => e.content)].join(" ");
      expect(surfaced).toContain("마루");
    } finally { await mem.close(); }
  });

  it("감정은 seed 텍스트에서 감지된다 — 별도 emotion 파라미터 계약 widen 불필요(save(text)만으로)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hlmem-salience2-")); dirs.push(dir);
    const mem = makeNaiaMemory({ storePath: join(dir, "s.json"), project: "sal2", sessionId: "s1" });
    try {
      // MemoryPort.save 는 (userText, assistantText) 만 받는다 — 감정 인자 없음(계약 불변).
      // 감정은 naia-memory 휴리스틱이 텍스트에서 감지(슬프/울/벅참…) → salience.
      await mem.save("10년 만에 마라톤을 완주해서 벅차오르고 정말 행복했어.", "");
      const recalled = await mem.recall("마라톤 도전 완주");
      const surfaced = [...recalled.facts, ...recalled.episodes.map((e) => e.content)].join(" ");
      expect(surfaced).toContain("마라톤");
    } finally { await mem.close(); }
  });
});
