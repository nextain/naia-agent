/** @spec UC-KNOWLEDGE / FR-KB-5 계약(K1b) — makeCompileKnowledge UC(config→backend→통계, no-throw)
 *  + readWorkspaceKnowledgeConfig(셸 소유 knowledge.json 읽기전용 파싱). fake backend(엔진 무종속 계약). */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type KnowledgeCompileBackend,
	makeCompileKnowledge,
	readWorkspaceKnowledgeConfig,
} from "../main/adapters/knowledge-compile.js";

const STATS = { sourceCount: 2, cardCount: 3, entityCount: 4, relationCount: 1 };

function recordingBackend() {
	const calls: { sources: string[]; scope: string; outDir: string }[] = [];
	const backend: KnowledgeCompileBackend = {
		async compileSources(opts) {
			calls.push(opts);
			return STATS;
		},
	};
	return { backend, calls };
}

describe("UC-KNOWLEDGE 컴파일 계약(FR-KB-5, K1b)", () => {
	it("소스 있음 → backend 호출(outDir=knowledge/<scope>) + 통계 ok:true", async () => {
		const { backend, calls } = recordingBackend();
		const compile = makeCompileKnowledge({
			readConfig: async () => ({ scope: "proj", sources: ["/docs/a", "/docs/b"] }),
			backend,
		});
		const r = await compile("/adk");
		expect(r.ok).toBe(true);
		expect(r.scope).toBe("proj");
		expect(r.cardCount).toBe(3);
		expect(calls).toHaveLength(1);
		expect(calls[0].sources).toEqual(["/docs/a", "/docs/b"]);
		expect(calls[0].outDir).toContain(join("knowledge", "proj"));
	});

	it("소스 0 → ok:false + error(backend 미호출)", async () => {
		const { backend, calls } = recordingBackend();
		const compile = makeCompileKnowledge({
			readConfig: async () => ({ scope: "default", sources: [] }),
			backend,
		});
		const r = await compile("/adk");
		expect(r.ok).toBe(false);
		expect(r.error).toBeTruthy();
		expect(calls).toHaveLength(0);
	});

	it("adkPath 빈 → ok:false", async () => {
		const { backend } = recordingBackend();
		const compile = makeCompileKnowledge({
			readConfig: async () => ({ scope: "x", sources: ["/a"] }),
			backend,
		});
		expect((await compile("")).ok).toBe(false);
	});

	it("backend throw → ok:false + error(no-throw, RPC 안정)", async () => {
		const compile = makeCompileKnowledge({
			readConfig: async () => ({ scope: "default", sources: ["/a"] }),
			backend: {
				async compileSources() {
					throw new Error("boom");
				},
			},
		});
		const r = await compile("/adk");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("boom");
	});

	it("readConfig throw → ok:false(no-throw)", async () => {
		const { backend } = recordingBackend();
		const compile = makeCompileKnowledge({
			readConfig: async () => {
				throw new Error("cfg");
			},
			backend,
		});
		expect((await compile("/adk")).ok).toBe(false);
	});

	describe("readWorkspaceKnowledgeConfig (셸 소유 knowledge.json 읽기전용)", () => {
		const dirs: string[] = [];
		afterEach(async () => {
			while (dirs.length)
				await rm(dirs.pop() as string, { recursive: true, force: true });
		});
		const seed = async (json?: string) => {
			const adk = await mkdtemp(join(tmpdir(), "kbc-cfg-"));
			dirs.push(adk);
			if (json !== undefined) {
				await mkdir(join(adk, "naia-settings"), { recursive: true });
				await writeFile(
					join(adk, "naia-settings", "knowledge.json"),
					json,
					"utf8",
				);
			}
			return adk;
		};

		it("파일 부재 → 기본 빈(throw 아님)", async () => {
			expect(await readWorkspaceKnowledgeConfig(await seed())).toEqual({
				scope: "default",
				sources: [],
			});
		});

		it("유효 → scope + sources(path 추출, 잘못된 항목 무시)", async () => {
			const adk = await seed(
				JSON.stringify({
					version: 1,
					scope: "proj-a",
					sources: [{ path: "/docs/a" }, { path: "/docs/b", label: "B" }, { bad: 1 }],
				}),
			);
			expect(await readWorkspaceKnowledgeConfig(adk)).toEqual({
				scope: "proj-a",
				sources: ["/docs/a", "/docs/b"],
			});
		});

		it("깨진 JSON → 기본 빈(throw 아님)", async () => {
			expect(await readWorkspaceKnowledgeConfig(await seed("{bad"))).toEqual({
				scope: "default",
				sources: [],
			});
		});
	});
});
