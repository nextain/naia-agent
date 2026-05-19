// Output hygiene for `<recall>` residue (#41 v2). Cross-review #2 BLOCK
// regressions are encoded as NEGATIVE cases here — they must fail pre-fix
// and pass post-fix. Invariant: strips line-leading small-model marker
// residue from the *answer*; never touches prose / code / quoted protocol.

import { describe, it, expect } from "vitest";
import { stripRecallResidue } from "@nextain/agent-core";

describe("stripRecallResidue — strips line-leading small-model residue", () => {
  it("the exact live malformations (leading), keeps the real answer", () => {
    expect(
      stripRecallResidue(
        "<recalall>name: Luke, favorite beverage: warm barley tea</recalall>\n\n가장 좋아하는 음료는 따뜻한 보리차였어요. 😊",
      ),
    ).toBe("가장 좋아하는 음료는 따뜻한 보리차였어요. 😊");
    expect(
      stripRecallResidue("<recal_루크, 보리차</recal> 가장 좋아하는 음료는 따뜻한 보리차였어요."),
    ).toBe("가장 좋아하는 음료는 따뜻한 보리차였어요.");
    expect(stripRecallResidue("<recal_l>query</recal_l>")).toBe("");
    expect(stripRecallResidue("<recalll>q1</recalll>")).toBe("");
    expect(stripRecallResidue("<recal<사용자가 가장 좋아하는 음료는 따뜻한 보리차다</recal>")).toBe("");
    expect(stripRecallResidue("<recall>좋아하는 음료</recall>\n보리차예요")).toBe("보리차예요");
  });
  it("line-leading stray / unterminated", () => {
    expect(stripRecallResidue("</recall>\n정상 답변")).toBe("정상 답변");
    expect(stripRecallResidue("<recal_query-no-close")).toBe("");
  });
});

describe("stripRecallResidue — NEGATIVE (cross-review #2 BLOCK regressions)", () => {
  it("BLOCK1: <recap>/<recapitulate>/<recital>/<receipt> are NOT stripped", () => {
    for (const s of [
      "<recap>we shipped X</recap> done.",
      "<recapitulate>summary</recapitulate>",
      "Here is a <recap/> of the meeting.",
      "<recital> and <receipt> and <recommend> survive.",
    ]) {
      expect(stripRecallResidue(s)).toBe(s);
    }
  });
  it("BLOCK2: a <recall> quoted in prose / code span is preserved", () => {
    for (const s of [
      "To trigger memory, emit `<recall>query</recall>` on its own line.",
      "In your code, write <recall>q</recall> to ask memory.",
    ]) {
      expect(stripRecallResidue(s)).toBe(s);
    }
  });
  it("BLOCK3: a stray marker cannot bridge real paragraphs", () => {
    const s =
      "Para A has <recall> here.\nPara B is a long real answer about TypeScript generics and variance.\nPara C ends </recall>.";
    expect(stripRecallResidue(s)).toBe(s); // not line-leading → untouched
  });
  it("BLOCK4 / D5: marker-free answer (incl. code + trailing ws/nl) is BYTE-IDENTICAL", () => {
    for (const s of [
      "function f() {\n    return 1;  \n}\n",
      "...the word recapitulation starts with <reca but is harmless",
      "가장 좋아하는 음료는 보리차예요.",
      "recall recall recall — no angle brackets",
      "당신의 이름은 Alpha 입니다.",
      "line with two trailing spaces  \nnext",
    ]) {
      expect(stripRecallResidue(s)).toBe(s);
    }
  });
  it("F6: nullish-safe", () => {
    expect(stripRecallResidue(undefined as unknown as string)).toBe("");
    expect(stripRecallResidue("" as string)).toBe("");
    expect(stripRecallResidue(null as unknown as string)).toBe("");
  });
});
