// github-skills 계약 테스트 — mock fetch(실 API/토큰 0).
import { describe, it, expect } from "vitest";
import { makeGithubSkillsExecutor } from "../main/adapters/github-skills.js";
import type { ToolCall } from "../main/domain/chat.js";

const CALL = (name: string, args: unknown): ToolCall => ({ id: "c", name, args });
function mk(resp: { ok?: boolean; status?: number; body?: unknown }) {
  let url = ""; let hdr: Record<string, string> = {};
  const fetch = async (u: string, init: { headers: Record<string, string> }) => { url = u; hdr = init.headers; return { ok: resp.ok ?? true, status: resp.status ?? 200, json: async () => resp.body }; };
  return { fetch: fetch as never, urlOf: () => url, hdrOf: () => hdr };
}
const ex = (m: ReturnType<typeof mk>, token = "tok") => makeGithubSkillsExecutor({ token, fetch: m.fetch });

describe("makeGithubSkillsExecutor (S23)", () => {
  it("list_issues → 포맷 + auth 헤더 + URL", async () => {
    const m = mk({ body: [{ number: 1, title: "Bug", state: "open" }, { number: 2, title: "Feat", state: "open" }] });
    const r = await ex(m).execute(CALL("github_list_issues", { owner: "nextain", repo: "naia-os" }), {});
    expect(r.output).toBe("#1 Bug (open)\n#2 Feat (open)");
    expect(m.urlOf()).toContain("/repos/nextain/naia-os/issues?state=open");
    expect(m.hdrOf().Authorization).toBe("Bearer tok");
  });
  it("PR 제외(github /issues 가 PR 포함)", async () => {
    const m = mk({ body: [{ number: 1, title: "issue", state: "open" }, { number: 2, title: "a PR", state: "open", pull_request: { url: "x" } }] });
    expect((await ex(m).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), {})).output).toBe("#1 issue (open)");
  });
  it("pull_request 손상값(null 등) → malformed error(silent drop 금지)", async () => {
    const m = mk({ body: [{ number: 1, title: "issue", state: "open", pull_request: null }] });
    expect((await ex(m).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), {})).isError).toBe(true);
  });
  it("get_issue → 제목+본문", async () => {
    const r = await ex(mk({ body: { number: 5, title: "T", body: "B", state: "closed" } })).execute(CALL("github_get_issue", { owner: "o", repo: "r", number: 5 }), {});
    expect(r.output).toContain("#5 T (closed)");
    expect(r.output).toContain("B");
  });
  it("get_issue 가 PR 번호 조회 → not-an-issue error(/issues/{n} 는 PR 도 반환)", async () => {
    const m = mk({ body: { number: 7, title: "a PR", state: "open", pull_request: { url: "x" } } });
    expect((await ex(m).execute(CALL("github_get_issue", { owner: "o", repo: "r", number: 7 }), {})).isError).toBe(true);
  });
  it("token/fetch 미주입 → unavailable", async () => {
    expect((await makeGithubSkillsExecutor({}).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), {})).output).toMatch(/unavailable/);
  });
  it("owner/repo 인젝션 문자 → invalid(no fetch)", async () => {
    const m = mk({ body: [] });
    expect((await ex(m).execute(CALL("github_list_issues", { owner: "../etc", repo: "r" }), {})).isError).toBe(true);
    expect((await ex(m).execute(CALL("github_list_issues", { owner: "o", repo: "a/b" }), {})).isError).toBe(true);
  });
  it("state 오값 / number 비정수 → isError", async () => {
    const m = mk({ body: [] });
    expect((await ex(m).execute(CALL("github_list_issues", { owner: "o", repo: "r", state: "weird" }), {})).isError).toBe(true);
    expect((await ex(m).execute(CALL("github_get_issue", { owner: "o", repo: "r", number: 1.5 }), {})).isError).toBe(true);
  });
  it("HTTP !ok → isError / malformed(배열 아님) → isError", async () => {
    expect((await ex(mk({ ok: false, status: 404 })).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), {})).output).toMatch(/404/);
    expect((await ex(mk({ body: { not: "array" } })).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), {})).isError).toBe(true);
    // 배열 항목 손상(number/title 누락) → isError(silent drop 금지)
    expect((await ex(mk({ body: [{ number: 1, title: "ok", state: "open" }, { state: "open" }] })).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), {})).isError).toBe(true);
    // 비-객체 항목 → isError
    expect((await ex(mk({ body: ["str", 1] })).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), {})).isError).toBe(true);
  });
  it("이미 aborted → reject / await 후 abort → reject", async () => {
    const ac = new AbortController(); ac.abort();
    await expect(ex(mk({ body: [] })).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), { signal: ac.signal })).rejects.toThrow();
    const ac2 = new AbortController();
    const mAbort = { fetch: (async () => { ac2.abort(); return { ok: true, status: 200, json: async () => [] }; }) as never, urlOf: () => "", hdrOf: () => ({}) };
    await expect(ex(mAbort).execute(CALL("github_list_issues", { owner: "o", repo: "r" }), { signal: ac2.signal })).rejects.toThrow();
  });
  it("tier none(읽기 전용)", () => {
    for (const s of makeGithubSkillsExecutor({}).specs()) expect(s.tier).toBeUndefined();
  });
});
