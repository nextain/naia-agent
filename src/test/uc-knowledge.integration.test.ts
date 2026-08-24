/** @spec UC-KNOWLEDGE 통합(K1a-2) — compose-agent-deps 가 실 naia-kb-compiler(openWorkspaceKnowledge)를 backend 로
 *  배선하고, toolExecutor 가 skill_knowledge_search/ask 를 노출하며 **실 KB(워크스페이스 kb.json) 근거 답변**을 낸다.
 *  cross-repo in-process 관통(naia-agent → @naia/kb-compiler → KnowledgeService(BM25) → 워크스페이스 정본). fake 아님. */
import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
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

const baseEnv = (adk: string) => ({
  NAIA_ADK_PATH: adk,
  NAIA_AGENT_MEMORY: "off",
  NAIA_AGENT_TRANSCRIPT: "off",
  AGENT_PROVIDER: "fake",
  NAIA_KNOWLEDGE_DIR: join(adk, "outside-settings", "knowledge"),
});

describe("UC-KNOWLEDGE 통합 — compose 가 실 kb-compiler backend 배선(K1a-2)", () => {
  const dirs: string[] = [];
  const seededAdk = async (withKb = true): Promise<string> => {
    const adk = await mkdtemp(join(tmpdir(), "kb-int-"));
    dirs.push(adk);
    if (withKb) {
      await mkdir(join(adk, "naia-settings", "knowledge", "default"), { recursive: true });
      await writeFile(join(adk, "naia-settings", "knowledge", "default", "kb.json"), JSON.stringify(KB), "utf8");
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

  it("초기 ADK가 없어도 SetWorkspace 뒤 같은 런타임에서 지식 도구가 복구된다", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kb-late-workspace-"));
    dirs.push(parent);
    const missing = join(parent, "not-created-yet");
    const ready = await seededAdk();
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(missing) });
    expect(deps.toolExecutor.specs().map((s: { name: string }) => s.name)).toContain("skill_knowledge_ask");
    deps.setKnowledgeWorkspace(ready);
    const result = await deps.toolExecutor.execute({ id: "late", name: "skill_knowledge_ask", args: { query: "전입신고 필요서류?" } }, {});
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.output).answer).toContain("신분증");
  });

  it("NAIA_KNOWLEDGE=off → 지식 도구 미노출(격리)", async () => {
    const adk = await seededAdk();
    const deps = await composeAgentRuntimeDeps({ env: { ...baseEnv(adk), NAIA_KNOWLEDGE: "off" } });
    const names = deps.toolExecutor.specs().map((s: { name: string }) => s.name);
    expect(names).not.toContain("skill_knowledge_ask");
  });

  it("활성 스코프(멀티스코프 V1) — knowledge.json scope 따라 knowledge/<scope>/kb.json 읽음(default 아님)", async () => {
    const adk = await mkdtemp(join(tmpdir(), "kb-scope-"));
    dirs.push(adk);
    // scope=proj 에만 KB(default 엔 없음) + 셸 소유 knowledge.json{scope:proj}.
    await mkdir(join(adk, "naia-settings", "knowledge", "proj"), { recursive: true });
    await writeFile(join(adk, "naia-settings", "knowledge", "proj", "kb.json"), JSON.stringify(KB), "utf8");
    await mkdir(join(adk, "naia-settings"), { recursive: true });
    await writeFile(join(adk, "naia-settings", "knowledge.json"), JSON.stringify({ version: 1, scope: "proj", sources: [] }), "utf8");
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    // proj scope 의 KB 를 읽어 근거 답변(default 였으면 부재→기권). 읽기/쓰기 scope 정렬.
    const r = await deps.toolExecutor.execute({ id: "ts", name: "skill_knowledge_ask", args: { query: "전입신고 필요서류?" } }, {});
    expect(JSON.parse(r.output).abstained).toBe(false);
    expect(JSON.parse(r.output).answer).toContain("신분증");
  });

  it("★라이브 리로드 — 기동 후 컴파일(kb.json 변경)이 재시작 없이 다음 질의에 반영", async () => {
    const adk = await seededAdk(false); // kb.json 없음(빈 KB 로 기동)
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    // 1) 컴파일 전 = 기권(빈 KB)
    const r1 = await deps.toolExecutor.execute({ id: "lr1", name: "skill_knowledge_ask", args: { query: "전입신고 필요서류?" } }, {});
    expect(JSON.parse(r1.output).abstained).toBe(true);
    // 2) "지금 컴파일" 시뮬 — kb.json 작성(mtime 변화)
    await mkdir(join(adk, "naia-settings", "knowledge", "default"), { recursive: true });
    await writeFile(join(adk, "naia-settings", "knowledge", "default", "kb.json"), JSON.stringify(KB), "utf8");
    // 3) 재시작 없이 같은 deps 로 질의 → 재로딩되어 근거 답변(stale KB 버그 회귀 차단)
    const r2 = await deps.toolExecutor.execute({ id: "lr2", name: "skill_knowledge_ask", args: { query: "전입신고 필요서류?" } }, {});
    expect(JSON.parse(r2.output).abstained).toBe(false);
    expect(JSON.parse(r2.output).answer).toContain("신분증");
  });

  it("무효 scope(knowledge.json) → default 폴백(경로탈출 안전)", async () => {
    const adk = await seededAdk(); // knowledge/default/kb.json 시드
    await mkdir(join(adk, "naia-settings"), { recursive: true });
    await writeFile(join(adk, "naia-settings", "knowledge.json"), JSON.stringify({ version: 1, scope: "../../etc", sources: [] }), "utf8");
    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    // 무효 scope 무시 → default 읽음(시드된 KB) → 근거 답변.
    const r = await deps.toolExecutor.execute({ id: "ts2", name: "skill_knowledge_ask", args: { query: "전입신고 필요서류?" } }, {});
    expect(JSON.parse(r.output).abstained).toBe(false);
  });

  it("SetWorkspace 경계가 바뀌면 같은 런타임이 새 ADK 지식만 읽는다", async () => {
    const first = await seededAdk();
    const second = await seededAdk(false);
    const secondKb = structuredClone(KB);
    secondKb.kb.cards = [{
      id: "c-second", title: "부산 전용 안내",
      fields: { content: "부산 전용 확인어는 광안대교입니다." },
      sourceUris: ["file:///second/busan.md"], confidence: 1, status: "accepted",
    }];
    secondKb.kb.entities = [];
    await mkdir(join(second, "naia-settings", "knowledge", "default"), { recursive: true });
    await writeFile(join(second, "naia-settings", "knowledge", "default", "kb.json"), JSON.stringify(secondKb), "utf8");

    const deps = await composeAgentRuntimeDeps({ env: baseEnv(first) });
    const before = await deps.toolExecutor.execute({ id: "ws1", name: "skill_knowledge_ask", args: { query: "전입신고 필요서류?" } }, {});
    expect(JSON.parse(before.output).answer).toContain("신분증");

    deps.setKnowledgeWorkspace(second);
    const after = await deps.toolExecutor.execute({ id: "ws2", name: "skill_knowledge_ask", args: { query: "부산 전용 확인어?" } }, {});
    expect(JSON.parse(after.output).answer).toContain("광안대교");
    const oldKnowledge = await deps.toolExecutor.execute({ id: "ws3", name: "skill_knowledge_ask", args: { query: "전입신고 필요서류?" } }, {});
    expect(JSON.parse(oldKnowledge.output).abstained).toBe(true);
  });

  it.runIf(process.platform !== "win32")("knowledge 디렉터리 symlink가 ADK 밖을 가리키면 질의가 fail-closed", async () => {
    const adk = await seededAdk(false);
    const outside = await mkdtemp(join(tmpdir(), "kb-outside-"));
    dirs.push(outside);
    await mkdir(join(outside, "default"), { recursive: true });
    await writeFile(join(outside, "default", "kb.json"), JSON.stringify(KB), "utf8");
    await mkdir(join(adk, "naia-settings"), { recursive: true });
    await symlink(outside, join(adk, "naia-settings", "knowledge"), "dir");

    const deps = await composeAgentRuntimeDeps({ env: baseEnv(adk) });
    const names = deps.toolExecutor.specs().map((s: { name: string }) => s.name);
    expect(names).toContain("skill_knowledge_ask");
    const result = await deps.toolExecutor.execute({ id: "sym", name: "skill_knowledge_ask", args: { query: "전입신고?" } }, {});
    expect(result.isError).toBe(true);
    expect(result.output).toContain("symbolic link");
  });
});
