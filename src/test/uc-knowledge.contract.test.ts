/** @spec UC-KNOWLEDGE / FR-KB-1~4 — 워크스페이스 지식 풀 도구(read-only search/ask) 계약. fake backend 결정론. */
import { describe, it, expect } from "vitest";
import { makeKnowledgeSkillsExecutor, type KnowledgeBackend } from "../main/adapters/knowledge-skill.js";
import type { ToolCall } from "../main/domain/chat.js";

const fakeBackend: KnowledgeBackend = {
  async search(_query, k) {
    const hits = [{ title: "전입신고", snippet: "필요서류는 신분증", score: 0.9, sourceUris: ["file:///ws/x.md"] }];
    return hits.slice(0, k ?? 8);
  },
  async ask(query) {
    if (query.includes("우주선")) return { abstained: true, answer: "관련 근거를 찾지 못했습니다.", sources: [] };
    return { abstained: false, answer: "신분증", sources: [{ title: "전입신고", sourceUris: ["file:///ws/x.md"] }] };
  },
};

const call = (name: string, args: unknown): ToolCall => ({ id: "t1", name, args });

describe("makeKnowledgeSkillsExecutor (UC-KNOWLEDGE)", () => {
  it("specs: search/ask 2종 노출(tier 없음=읽기전용 무승인)", () => {
    const ex = makeKnowledgeSkillsExecutor({ backend: fakeBackend });
    const specs = ex.specs();
    const names = specs.map((s) => s.name);
    expect(names).toContain("skill_knowledge_search");
    expect(names).toContain("skill_knowledge_ask");
    expect(specs.every((s) => s.tier === undefined)).toBe(true);
  });

  it("search: JSON hits + sourceUris 보존(근거→원문 키)", async () => {
    const ex = makeKnowledgeSkillsExecutor({ backend: fakeBackend });
    const r = await ex.execute(call("skill_knowledge_search", { query: "필요서류" }), {});
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.output);
    expect(parsed.hits[0].title).toBe("전입신고");
    expect(parsed.hits[0].sourceUris).toContain("file:///ws/x.md");
  });

  it("search: k 인자 반영", async () => {
    const ex = makeKnowledgeSkillsExecutor({ backend: fakeBackend });
    const r = await ex.execute(call("skill_knowledge_search", { query: "x", k: 1 }), {});
    expect(JSON.parse(r.output).hits.length).toBeLessThanOrEqual(1);
  });

  it("ask: JSON answer + sources(출처)", async () => {
    const ex = makeKnowledgeSkillsExecutor({ backend: fakeBackend });
    const r = await ex.execute(call("skill_knowledge_ask", { query: "전입신고 필요서류?" }), {});
    const parsed = JSON.parse(r.output);
    expect(parsed.abstained).toBe(false);
    expect(parsed.answer).toContain("신분증");
    expect(parsed.sources[0].sourceUris).toContain("file:///ws/x.md");
  });

  it("ask: 근거 없으면 기권(JSON abstained=true, 지어내지 않음)", async () => {
    const ex = makeKnowledgeSkillsExecutor({ backend: fakeBackend });
    const r = await ex.execute(call("skill_knowledge_ask", { query: "우주선 발사 비용?" }), {});
    expect(JSON.parse(r.output).abstained).toBe(true);
  });

  it("backend 미주입 → unavailable(isError, no-throw)", async () => {
    const ex = makeKnowledgeSkillsExecutor({});
    const r = await ex.execute(call("skill_knowledge_search", { query: "x" }), {});
    expect(r.isError).toBe(true);
  });

  it("빈/비문자 query·잘못된 args → isError(no-throw)", async () => {
    const ex = makeKnowledgeSkillsExecutor({ backend: fakeBackend });
    expect((await ex.execute(call("skill_knowledge_ask", { query: "  " }), {})).isError).toBe(true);
    expect((await ex.execute(call("skill_knowledge_ask", { query: 123 }), {})).isError).toBe(true);
    expect((await ex.execute(call("skill_knowledge_ask", "nope"), {})).isError).toBe(true);
    expect((await ex.execute(call("skill_knowledge_search", { query: "x", k: -1 }), {})).isError).toBe(true);
  });

  it("unknown tool → isError", async () => {
    const ex = makeKnowledgeSkillsExecutor({ backend: fakeBackend });
    expect((await ex.execute(call("skill_knowledge_nope", { query: "x" }), {})).isError).toBe(true);
  });

  it("abort → reject(no-throw 예외: abort만)", async () => {
    const ex = makeKnowledgeSkillsExecutor({ backend: fakeBackend });
    const ac = new AbortController();
    ac.abort();
    await expect(ex.execute(call("skill_knowledge_ask", { query: "x" }), { signal: ac.signal })).rejects.toThrow();
  });
});
