/** @spec UC-KNOWLEDGE / FR-KB-5 통합(K1b) — 실 kb-compiler backend: 폴더(.md) → compile → kb.json 영속.
 *  cross-repo in-process(naia-agent → @naia/kb-compiler: Ingest + Markdown extract + WorkspaceStore). fake 아님. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	makeCompileKnowledge,
	makeKbCompilerBackend,
	readWorkspaceKnowledgeConfig,
} from "../main/adapters/knowledge-compile.js";

describe("UC-KNOWLEDGE 컴파일 통합 — 실 kb-compiler 폴더→kb.json(FR-KB-5, K1b)", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		while (dirs.length)
			await rm(dirs.pop() as string, { recursive: true, force: true });
	});

	it("등록 폴더(.md) → compile → knowledge/<scope>/kb.json 영속 + 통계 + sourceUris 보존", async () => {
		const adk = await mkdtemp(join(tmpdir(), "kbc-int-"));
		dirs.push(adk);
		const srcDir = join(adk, "sources", "gov");
		await mkdir(srcDir, { recursive: true });
		await writeFile(
			join(srcDir, "jeonipsingo.md"),
			"# 전입신고\n\n전입신고 필요서류는 **신분증**과 **임대차계약서**. 담당은 **주민센터**. 전입신고는 14일 이내에 해야 한다. 인터넷 신청도 가능하다. 세대주 변경도 함께 처리된다.\n",
			"utf8",
		);
		await writeFile(
			join(srcDir, "passport.md"),
			"# 여권 발급\n\n여권 발급 **수수료**는 53000원. 담당은 **민원여권과**. 사진과 신분증 지참. 처리기간은 약 일주일 소요된다. 긴급 발급도 가능하다.\n",
			"utf8",
		);
		// 셸이 쓴 정본(스코프 + 소스) — naia-settings/knowledge.json
		await mkdir(join(adk, "naia-settings"), { recursive: true });
		await writeFile(
			join(adk, "naia-settings", "knowledge.json"),
			JSON.stringify({ version: 1, scope: "gov", sources: [{ path: srcDir }] }),
			"utf8",
		);

		const compile = makeCompileKnowledge({
			readConfig: readWorkspaceKnowledgeConfig,
			backend: makeKbCompilerBackend(),
		});
		const r = await compile(adk);
		expect(r.ok).toBe(true);
		expect(r.scope).toBe("gov");
		expect(r.sourceCount).toBe(2);
		expect(r.cardCount).toBeGreaterThan(0);
		expect(r.entityCount).toBeGreaterThan(0);

		// kb.json 영속 + 가반 envelope({version:1,kb})
		const env = JSON.parse(
			await readFile(join(adk, "knowledge", "gov", "kb.json"), "utf8"),
		);
		expect(env.version).toBe(1);
		expect(env.kb.cards.length).toBe(r.cardCount);
		// sourceUris = 원본 파일 경로 보존(근거→원문 키)
		const uris = env.kb.cards.flatMap(
			(c: { sourceUris: string[] }) => c.sourceUris,
		);
		expect(uris.some((u: string) => u.includes("jeonipsingo.md"))).toBe(true);
	});

	it("config 부재(소스 0) → ok:false(미컴파일, throw 아님)", async () => {
		const adk = await mkdtemp(join(tmpdir(), "kbc-int2-"));
		dirs.push(adk);
		const compile = makeCompileKnowledge({
			readConfig: readWorkspaceKnowledgeConfig,
			backend: makeKbCompilerBackend(),
		});
		expect((await compile(adk)).ok).toBe(false);
	});
});
