// adk-skill-loader 계약 — naia-adk SKILL.md → ToolExecutorPort(동적 스킬). 성격 구분: 정의=naia-adk / 실행=agent.
// 리뷰 회귀: folded scalar description / disable-model-invocation / CRLF / 깨진 YAML.
import { describe, it, expect } from "vitest";
import { parseSkillMd, makeAdkSkillExecutor, toolNameFor } from "../main/adapters/adk-skill-loader.js";

describe("parseSkillMd (js-yaml frontmatter + 본문)", () => {
  it("inline name/description/tier + body (비표준 T2는 바깥 경계에서 ask로 수렴)", () => {
    const md = `---\nname: copyright-reg\ndescription: "저작권 등록 서류 생성"\ntier: T2\n---\n# 절차\n1. 자료 수집`;
    const s = parseSkillMd(md);
    expect(s).not.toBeNull();
    expect(s!.name).toBe("copyright-reg");
    expect(s!.description).toBe("저작권 등록 서류 생성");
    expect(s!.tier).toBe("ask");
    expect(s!.body).toContain("# 절차");
    expect(s!.modelInvocable).toBe(true);
  });
  it("folded scalar description(>) 멀티라인 — '>' 가 아닌 합쳐진 설명, tier: T1 -> ask 수렴 (리뷰 HIGH1 + P3)", () => {
    const md = `---\nname: review-pass\ndescription: >\n  여러 줄에 걸친\n  설명입니다\ntier: T1\n---\n# 본문`;
    const s = parseSkillMd(md);
    expect(s).not.toBeNull();
    expect(s!.description).toContain("여러 줄에 걸친");
    expect(s!.description).toContain("설명입니다");
    expect(s!.description).not.toBe(">");
    expect(s!.tier).toBe("ask");
  });
  it("명시적 tier: none / tier: 0 은 none 유지, 미지정·비표준(T1/T2)은 ask 수렴", () => {
    expect(parseSkillMd(`---\nname: safe-read\ndescription: "안전 조회"\ntier: none\n---\n# 본문`)!.tier).toBe("none");
    expect(parseSkillMd(`---\nname: safe-zero\ndescription: "안전 T0"\ntier: 0\n---\n# 본문`)!.tier).toBe("none");
    expect(parseSkillMd(`---\nname: ask-t1\ndescription: "T1 절차"\ntier: T1\n---\n# 본문`)!.tier).toBe("ask");
    expect(parseSkillMd(`---\nname: ask-t2\ndescription: "T2 절차"\ntier: T2\n---\n# 본문`)!.tier).toBe("ask");
  });
  it("disable-model-invocation: true → modelInvocable=false (리뷰 HIGH2)", () => {
    const md = `---\nname: merge-worktree\ndescription: "파괴적 git 워크플로우"\ndisable-model-invocation: true\n---\n# 위험 절차`;
    const s = parseSkillMd(md);
    expect(s!.modelInvocable).toBe(false);
  });
  it("필수(name/description) 누락 = null(스킵)", () => {
    expect(parseSkillMd("# no frontmatter")).toBeNull();
    expect(parseSkillMd(`---\ntier: T1\n---\nbody`)).toBeNull();
  });
  it("깨진 YAML frontmatter = null(정직 스킵)", () => {
    expect(parseSkillMd(`---\nname: x\n: : : bad yaml\n---\nbody`)).toBeNull();
  });
  it("tier 미지정 = ask, CRLF 정규화", () => {
    const s = parseSkillMd(`---\r\nname: x\r\ndescription: y\r\n---\r\nbody line`);
    expect(s!.tier).toBe("ask");
    expect(s!.body).not.toContain("\r");
  });
});

describe("makeAdkSkillExecutor (프롬프트 주입형 — 본문 절차 fencing)", () => {
  const skills = [{ name: "copyright-reg", description: "저작권 등록", tier: "T2", body: "절차: 1. 자료 수집", modelInvocable: true }];

  it("specs() = skill_<name>(description 보존, 비표준 tier T2는 ask로 정규화)", () => {
    const sp = makeAdkSkillExecutor(skills).specs();
    expect(sp).toHaveLength(1);
    expect(sp[0].name).toBe("skill_copyright-reg");
    expect(sp[0].description).toBe("저작권 등록");
    expect(sp[0].tier).toBe("ask");
  });
  it("execute = 본문 절차 output + fencing(시스템 지시 우선 안 함)", async () => {
    const r = await makeAdkSkillExecutor(skills).execute({ name: "skill_copyright-reg", args: {}, id: "t1" }, {});
    expect(r.isError).toBeFalsy();
    expect(r.output).toContain("절차: 1. 자료 수집");
    expect(r.output).toContain("시스템 지시보다 우선하지 않");
  });
  it("disable-model-invocation(modelInvocable=false) → 도구 미노출 (리뷰 HIGH2)", () => {
    const ex = makeAdkSkillExecutor([{ name: "merge-worktree", description: "파괴적", tier: "ask", body: "위험 git", modelInvocable: false }]);
    expect(ex.specs()).toHaveLength(0);
  });
  it("unknown skill = isError(no-throw 계약)", async () => {
    const r = await makeAdkSkillExecutor(skills).execute({ name: "skill_nope", args: {}, id: "t2" }, {});
    expect(r.isError).toBe(true);
  });
  it("중복 name = 첫 등록 우선(composite 규약)", () => {
    const sp = makeAdkSkillExecutor([
      { name: "a", description: "first", tier: "ask", body: "b1", modelInvocable: true },
      { name: "a", description: "second", tier: "ask", body: "b2", modelInvocable: true },
    ]).specs();
    expect(sp).toHaveLength(1);
    expect(sp[0].description).toBe("first");
  });
  it("toolNameFor — 안전 도구명", () => {
    expect(toolNameFor("copyright-reg")).toBe("skill_copyright-reg");
    expect(toolNameFor("my skill!")).toBe("skill_my_skill_");
  });
});
