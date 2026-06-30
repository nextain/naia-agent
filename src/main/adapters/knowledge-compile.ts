/** @uc UC-KNOWLEDGE (FR-KB-5, K1b 컴파일) — 워크스페이스 지식 소스(폴더) → kb-compiler compile → kb.json.
 *
 *  naia-os 설정(`naia-settings/knowledge.json`)이 등록한 소스 폴더들을 읽어 kb-compiler 로 컴파일,
 *  naia-adk `knowledge/<scope>/kb.json` 에 영속(가반 envelope). gRPC `CompileKnowledge` RPC 가 호출(K1b).
 *
 *  경계: 본 어댑터 = 컴파일(쓰기). 읽기(search/ask) = `knowledge-skill.ts`(K1a). config 정본 = **셸 소유**
 *  (에이전트는 `knowledge.json` 을 *읽기만*, 쓰기 없음 — 신뢰경계 자가확장 차단, naia-os FR-KB-OS.9 대칭).
 *  비종속(D03): kb-compiler 어댑터 선택은 `KnowledgeCompileBackend` 뒤 — 코어/UC 는 엔진을 모름(fake 로 계약검증).
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

/** 컴파일 결과(통계). gRPC `CompileKnowledgeResult` 와 동형(camelCase). */
export interface CompileKnowledgeResult {
	ok: boolean;
	scope: string;
	sourceCount: number;
	cardCount: number;
	entityCount: number;
	relationCount: number;
	error?: string;
}

/** 등록 소스 폴더들 → 컴파일 → kb.json 저장. kb-compiler 종속을 이 경계 뒤로 숨긴다(D03). */
export interface KnowledgeCompileBackend {
	compileSources(opts: {
		sources: string[];
		scope: string;
		outDir: string;
	}): Promise<{
		sourceCount: number;
		cardCount: number;
		entityCount: number;
		relationCount: number;
	}>;
}

export interface CompileKnowledgeDeps {
	/** `knowledge.json`(셸 소유 설정) 읽기 → {scope, sources}. 부재/깨짐 = 빈(throw 아님). */
	readConfig(adkPath: string): Promise<{ scope: string; sources: string[] }>;
	backend: KnowledgeCompileBackend;
	diag?: { log: (m: string, c?: unknown) => void };
}

/** UC — adkPath → (config 읽기 → 컴파일 → 통계). no-throw(실패=ok:false+error, RPC 안정). */
/** 스코프 = `knowledge/<scope>/kb.json` 경로 세그먼트 → **경로탈출 방지**(K-SEC). 구분자(`/`·`\`)·`..`·
 *  드라이브절대·널바이트·과길이 거부. 셸 소유 config 라도 defense-in-depth: 악의/버그로 `../../etc` 가 와도
 *  outDir 이 워크스페이스 밖으로 못 나가게 한다(Rust `read_naia_knowledge_kb` 의 scope 가드와 대칭). */
export function isValidKnowledgeScope(scope: string): boolean {
	if (typeof scope !== "string" || scope.length === 0 || scope.length > 128)
		return false;
	if (scope.includes("/") || scope.includes("\\") || scope.includes("\0"))
		return false;
	if (scope === "." || scope.includes("..")) return false;
	if (/^[A-Za-z]:/.test(scope)) return false; // 드라이브 절대
	return true;
}

export function makeCompileKnowledge(deps: CompileKnowledgeDeps) {
	return async function compileKnowledge(
		adkPath: string,
	): Promise<CompileKnowledgeResult> {
		const fail = (scope: string, error?: string): CompileKnowledgeResult => ({
			ok: false,
			scope,
			sourceCount: 0,
			cardCount: 0,
			entityCount: 0,
			relationCount: 0,
			...(error ? { error } : {}),
		});
		let scope = "default";
		try {
			if (!adkPath) return fail(scope, "adkPath 미지정");
			const cfg = await deps.readConfig(adkPath);
			scope = cfg.scope || "default";
			// K-SEC: 경로탈출 방지 — scope 가 outDir = knowledge/<scope> 세그먼트라 구분자/.. 차단.
			if (!isValidKnowledgeScope(scope))
				return fail(scope, "유효하지 않은 지식 스코프(경로 구분자/.. 금지)");
			if (!cfg.sources.length)
				return fail(scope, "등록된 소스 폴더가 없습니다");
			const outDir = join(adkPath, "knowledge", scope);
			const stats = await deps.backend.compileSources({
				sources: cfg.sources,
				scope,
				outDir,
			});
			deps.diag?.log("knowledge compiled", { scope, ...stats });
			return { ok: true, scope, ...stats };
		} catch (e) {
			return fail(scope, e instanceof Error ? e.message : String(e));
		}
	};
}

// ── 실 배선 (kb-compiler + node fs) — entry 가 주입. 통합 테스트 대상. ──────────────

const TEXT_EXT = new Set([".md", ".markdown", ".txt"]);
const MAX_FILES = 500; // 폭주 가드(대형 폴더 — 무한 수집 방지)

/** `naia-settings/knowledge.json` 읽기 — 셸이 쓴 정본(에이전트 읽기전용). 부재/깨짐 = 빈. */
export async function readWorkspaceKnowledgeConfig(
	adkPath: string,
): Promise<{ scope: string; sources: string[] }> {
	const path = join(adkPath, "naia-settings", "knowledge.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return { scope: "default", sources: [] };
	}
	try {
		const obj = JSON.parse(raw) as { scope?: unknown; sources?: unknown };
		const scope =
			typeof obj.scope === "string" && obj.scope.trim()
				? obj.scope.trim()
				: "default";
		const sources: string[] = [];
		if (Array.isArray(obj.sources)) {
			for (const s of obj.sources) {
				const p =
					s && typeof s === "object"
						? (s as { path?: unknown }).path
						: undefined;
				if (typeof p === "string" && p.trim()) sources.push(p);
			}
		}
		return { scope, sources };
	} catch {
		return { scope: "default", sources: [] };
	}
}

async function* walkTextFiles(
	dir: string,
	budget: { n: number },
): AsyncGenerator<string> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // 접근 불가 폴더 = 건너뜀(정직 — 부분 컴파일)
	}
	for (const e of entries) {
		if (budget.n <= 0) return;
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name.startsWith(".")) continue;
			yield* walkTextFiles(full, budget);
		} else if (e.isFile() && TEXT_EXT.has(extname(e.name).toLowerCase())) {
			budget.n--;
			yield full;
		}
	}
}

/** 실 backend — kb-compiler(오프라인 결정론: Ingest + Markdown extract) + WorkspaceStoreAdapter.
 *  동적 import 로 kb-compiler 격리(코어 무종속, compose 패턴 동형). `compile()` 내부가 kb.json 저장. */
export function makeKbCompilerBackend(): KnowledgeCompileBackend {
	return {
		async compileSources({ sources, outDir }) {
			const {
				compile,
				IngestAdapter,
				MarkdownExtractAdapter,
				MemoryRetrievalAdapter,
				WorkspaceStoreAdapter,
			} = await import("@naia/kb-compiler");
			const sourceInputs: {
				kind: "file";
				uri: string;
				title: string;
				text: string;
			}[] = [];
			const budget = { n: MAX_FILES };
			for (const folder of sources) {
				for await (const file of walkTextFiles(folder, budget)) {
					let text: string;
					try {
						text = await readFile(file, "utf8");
					} catch {
						continue;
					}
					if (!text.trim()) continue;
					sourceInputs.push({
						kind: "file",
						uri: file,
						title: basename(file),
						text,
					});
				}
			}
			const adapters = {
				ingest: new IngestAdapter(),
				// K-SEC(extract 인젝션 안전): MarkdownExtractAdapter = **로컬 결정론**(LLM 미사용) → 자료에 심긴
				//   프롬프트("이전 지시 무시…")가 *해석되지 않는다* = 추출 단계 인젝션 surface 0. ⚠️ 이후 LLM 추출
				//   (GeminiExtractAdapter)로 바꾸면 비신뢰 자료가 인젝션 벡터가 됨 → 그땐 비신뢰 소스 격리/sanitize
				//   필수(현 오프라인 경로는 그 위험 없음). retrieval=MemoryRetrieval=in-process 인덱스(memory store 아님).
				extract: new MarkdownExtractAdapter(),
				retrieval: new MemoryRetrievalAdapter(),
				// 쓰기는 outDir(knowledge/<scope>) 한정 — naia-memory store 와 **물리적 분리**(누수 차단, K-SEC).
				store: new WorkspaceStoreAdapter({ dir: outDir }),
			};
			// compile 내부에서 store.save(kb) → outDir/kb.json 영속(WorkspaceStoreAdapter envelope).
			const result = await compile({ sources: sourceInputs }, adapters);
			return {
				sourceCount: result.report.sourceCount,
				cardCount: result.report.cardCount,
				entityCount: result.report.entityCount,
				relationCount: result.report.relationCount,
			};
		},
	};
}
