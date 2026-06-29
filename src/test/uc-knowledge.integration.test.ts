/** @spec UC-KNOWLEDGE 통합(K1a-2) — compose-agent-deps 가 실 naia-kb-compiler(openWorkspaceKnowledge)를 backend 로
 *  배선하고, toolExecutor 가 skill_knowledge_search/ask 를 노출하며 **실 KB(워크스페이스 kb.json) 근거 답변**을 낸다.
 *  cross-repo in-process 관통(naia-agent → @naia/kb-compiler → KnowledgeService(BM25) → 워크스페이스 정본). fake 아님. */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — .mjs 호스트 조립기(타입 선언 없음). 통합 경계라 의도적.
import { composeAgentRuntimeDeps } from "../../scripts/builds/compose-agent-deps.mjs";

// 실 kb-compiler 정본 envelope({version:1, kb}) — WorkspaceStoreAdapter.save 산출 형식.
const KB = {
  version: 1,
  kb: {
    cards: [
      { id: "c1", title: "전입신고", fields: { content: "전입신고 필요서류는 신분증과 임대차계약서. 담당은 주민센터." }, sourceUris: ["file:///ws/jeonipsingo.md"], confidence: 1, status: "accepted" },
      { id: "c2", title: "여권 발급", fields: { content: "여권 발급 수수료는 53000원. 담당은 민원여권과." }, sourceUris: ["file:///ws/passport.md"], confidence: 1, status: "accepted" },
    ],
    entities: [{ id: "e1", type: "Service", name: "전입신고" }],
    relations: [],
  },
};

const baseEnv = (adk: string) => ({ NAIA_ADK_PATH: adk, NAIA_AGENT_MEMORY: "off", NAIA_AGENT_TRANSCRIPT: "off", AGENT_PROVIDER: "fake" });

describe("UC-KNOWLEDGE 통합 — compose 가 실 kb-compiler backend 배선(K1a-2)", () => {
  const dirs: string[] = [];
  const seededAdk = async (withKb = true): Promise<string> => {
    const adk = await mkdtemp(join(tmpdir(), "kb-int-"));
    dirs.push(adk);
    if (withKb) {
      await mkdir(join(adk, "knowledge", "default"), { recursive: true });
      await writeFile(join(adk, "knowledge", "default", "kb.json"), JSON.stringify(KB), "utf8");
    }
    return adk;
  };
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop() as string, { recursive: true, force: true });
  });

  it("toolExecutor 에 skill_knowledge_search/ask 노출 + 실 KB 근거 답변(출처 보존)", async () => {
    const adk = await seededAdk();
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    const names = deps.toolExecutor.specs().map((s: { name: string }) => s.name);
    expect(names).toContain("skill_knowledge_search");
    expect(names).toContain("skill_knowledge_ask");

    const r = await deps.toolExecutor.execute({ id: "t1", name: "skill_knowledge_ask", args: { query: "전입신고 필요서류?" } }, {});
    expect(r.isError).toBeFalsy();
    const parsed = JSON.parse(r.output);
    expect(parsed.abstained).toBe(false);
    expect(parsed.answer).toContain("신분증");
    expect(parsed.sources.flatMap((s: { sourceUris: string[] }) => s.sourceUris)).toContain("file:///ws/jeonipsingo.md");
  });

  it("search: 실 KB 검색 hits + sourceUris(근거→원문 키)", async () => {
    const adk = await seededAdk();
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    const r = await deps.toolExecutor.execute({ id: "t2", name: "skill_knowledge_search", args: { query: "수수료" } }, {});
    const parsed = JSON.parse(r.output);
    expect(parsed.hits[0].title).toBe("여권 발급");
    expect(parsed.hits[0].sourceUris).toContain("file:///ws/passport.md");
  });

  it("근거 없으면 기권(지어내지 않음)", async () => {
    const adk = await seededAdk();
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    const r = await deps.toolExecutor.execute({ id: "t3", name: "skill_knowledge_ask", args: { query: "우주선 발사 비용?" } }, {});
    expect(JSON.parse(r.output).abstained).toBe(true);
  });

  it("skill_knowledge_graph(K3): 실 kb-compiler toGraphData → nodes(엔티티)·communityCount", async () => {
    const adk = await seededAdk();
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    expect(deps.toolExecutor.specs().map((s: { name: string }) => s.name)).toContain("skill_knowledge_graph");
    const r = await deps.toolExecutor.execute({ id: "tg", name: "skill_knowledge_graph", args: {} }, {});
    expect(r.isError).toBeFalsy();
    const g = JSON.parse(r.output);
    expect(Array.isArray(g.nodes)).toBe(true);
    expect(g.nodes.some((n: { label: string }) => n.label === "전입신고")).toBe(true);
    expect(typeof g.communityCount).toBe("number");
  });

  it("KB 파일 부재(미컴파일) → 빈 KB 로 열림(cards=0) + ask 기권(채팅 무영향)", async () => {
    const adk = await seededAdk(false); // knowledge/default/kb.json 없음
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    const names = deps.toolExecutor.specs().map((s: { name: string }) => s.name);
    expect(names).toContain("skill_knowledge_ask"); // 도구는 노출(빈 KB)
    const r = await deps.toolExecutor.execute({ id: "t4", name: "skill_knowledge_ask", args: { query: "아무거나" } }, {});
    expect(JSON.parse(r.output).abstained).toBe(true);
  });

  it("NAIA_KNOWLEDGE=off → 지식 도구 미노출(격리)", async () => {
    const adk = await seededAdk();
    const deps = await composeAgentRuntimeDeps({ env: { ...baseEnv(adk), NAIA_KNOWLEDGE: "off" } });
    const names = deps.toolExecutor.specs().map((s: { name: string }) => s.name);
    expect(names).not.toContain("skill_knowledge_ask");
  });
});
