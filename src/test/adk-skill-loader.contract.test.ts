// adk-skill-loader 계약 — naia-adk SKILL.md → ToolExecutorPort(동적 스킬). 성격 구분: 정의=naia-adk / 실행=agent.
import { describe, it, expect } from "vitest";
import { parseSkillMd, makeAdkSkillExecutor, toolNameFor } from "../main/adapters/adk-skill-loader.js";

describe("parseSkillMd (SKILL.md frontmatter + 본문)", () => {
  it("name/description/tier + body 파싱", () => {
    const md = `---\nname: copyright-reg\ndescription: "저작권 등록 서류 생성"\ntier: T2\n---\n# 절차\n1. 자료 수집`;
    const s = parseSkillMd(md);
    expect(s).not.toBeNull();
    expect(s!.name).toBe("copyright-reg");
    expect(s!.description).toBe("저작권 등록 서류 생성");
    expect(s!.tier).toBe("T2");
    expect(s!.body).toContain("# 절차");
  });
  it("필수(name/description) 누락 = null(스킵)", () => {
    expect(parseSkillMd("# no frontmatter")).toBeNull();
    expect(parseSkillMd(`---\ntier: T1\n---\nbody`)).toBeNull();
  });
  it("tier 미지정 = 기본 ask(외부 절차 승인)", () => {
    const s = parseSkillMd(`---\nname: x\ndescription: y\n---\nbody`);
    expect(s!.tier).toBe("ask");
  });
});

describe("makeAdkSkillExecutor (프롬프트 주입형 — 본문 절차 제공)", () => {
  const skills = [{ name: "copyright-reg", description: "저작권 등록", tier: "T2", body: "절차: 1. 자료 수집" }];

  it("specs() = skill_<name> 도구(description/tier 보존)", () => {
    const sp = makeAdkSkillExecutor(skills).specs();
    expect(sp).toHaveLength(1);
    expect(sp[0].name).toBe("skill_copyright-reg");
    expect(sp[0].description).toBe("저작권 등록");
    expect(sp[0].tier).toBe("T2");
  });
  it("execute = 본문(절차)을 output 으로 반환", async () => {
    const r = await makeAdkSkillExecutor(skills).execute({ name: "skill_copyright-reg", args: {}, id: "t1" }, {});
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("절차: 1. 자료 수집");
    expect(r.output).toContain("copyright-reg");
  });
  it("unknown skill = isError(no-throw 계약)", async () => {
    const r = await makeAdkSkillExecutor(skills).execute({ name: "skill_nope", args: {}, id: "t2" }, {});
    expect(r.isError).toBe(true);
  });
  it("중복 name = 첫 등록 우선(composite 규약)", () => {
    const sp = makeAdkSkillExecutor([
      { name: "a", description: "first", tier: "ask", body: "b1" },
      { name: "a", description: "second", tier: "ask", body: "b2" },
    ]).specs();
    expect(sp).toHaveLength(1);
    expect(sp[0].description).toBe("first");
  });
  it("toolNameFor — 안전 도구명(영숫자/_/- 외 치환)", () => {
    expect(toolNameFor("copyright-reg")).toBe("skill_copyright-reg");
    expect(toolNameFor("my skill!")).toBe("skill_my_skill_");
  });
});
