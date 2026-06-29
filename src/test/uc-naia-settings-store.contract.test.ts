// naia-settings storage 정본 계약 — `<adkPath>/naia-settings/`(= naia-adk 워크스페이스) → 활성 ProviderConfig.
// 정본(루크): 설정은 naia-adk 에 저장. naia-os 셸이 config.json 을 쓰고(시크릿 strip→키체인), agent 가 기동 시 로딩.
// 읽기(2026-06-17 config-first): config.json(셸 정본 {provider,model}, 키는 credentials 포트가 공급) → llm.json(구 CLI 3-role, apiKeyRef→secret) 폴백.
// 계약: docs/progress/UC-provider-provenance-contract-2026-06-12.md
import { describe, it, expect } from "vitest";
import { makeNaiaSettingsStore, roleHasPlaintextSecret, type SettingsFsRead } from "../main/adapters/naia-settings-store.js";

/** 메모리 fs — path→content 맵. */
function memFs(files: Record<string, string>): SettingsFsRead {
	return {
		existsSync: (p) => p in files,
		readFileSync: (p) => {
			if (!(p in files)) throw new Error(`ENOENT ${p}`);
			return files[p]!;
		},
	};
}
const LLM = "/ws/naia-settings/llm.json";
const CONFIG = "/ws/naia-settings/config.json";
const secrets: Record<string, string> = { GLM_API_KEY: "glm-SECRET", NAIA_ANYLLM_API_KEY: "naia-LOGIN" };
const resolveSecret = (ref: string) => secrets[ref];
const store = (files: Record<string, string>) => makeNaiaSettingsStore({ fs: memFs(files), resolveSecret });

describe("loadMain — config.json (naia-os 셸 정본 포맷; 키는 키체인=credentials 포트가 공급)", () => {
	it("zai(API-key 타입) config → {provider, model}, 키 없음(credentials 가 chat 시 붙임)", () => {
		expect(store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "glm-5.1", agentName: "Naia", onboardingComplete: true }) }).loadMain("/ws"))
			.toEqual({ provider: "zai", model: "glm-5.1" }); // apiKey 미포함 — 셸이 strip, 핸들러가 credentials.get 으로 공급
	});
	it("nextain(naia 계정) config → labGatewayUrl(naiaGatewayUrl/NAIA_ANYLLM_BASE_URL), 키 없음", () => {
		expect(store({ [CONFIG]: JSON.stringify({ provider: "nextain", model: "gemini-2.5-flash", NAIA_ANYLLM_BASE_URL: "https://api.nextain.io" }) }).loadMain("/ws"))
			.toEqual({ provider: "nextain", model: "gemini-2.5-flash", labGatewayUrl: "https://api.nextain.io" });
	});
	it("ollama(로컬) config → ollamaHost", () => {
		expect(store({ [CONFIG]: JSON.stringify({ provider: "ollama", model: "gemma3:4b", ollamaHost: "http://localhost:11434" }) }).loadMain("/ws"))
			.toEqual({ provider: "ollama", model: "gemma3:4b", ollamaHost: "http://localhost:11434" });
	});
	it("★ native provider: config.json naiaGatewayUrl 무시(nextain 전용) — stale 게이트웨이 오라우팅 방지(적대적 리뷰 MEDIUM)", () => {
		expect(store({ [CONFIG]: JSON.stringify({ provider: "openai", model: "gpt-4o", naiaGatewayUrl: "https://stale-gw/v1" }) }).loadMain("/ws"))
			.toEqual({ provider: "openai", model: "gpt-4o" }); // labGatewayUrl 미적용 → nativeBaseUrl 기본(api.openai.com)
	});
	it("★ native provider + llm.json baseUrl(CLI 커스텀 self-host) → labGatewayUrl 보존(nativeBaseUrl override)", () => {
		expect(store({ [LLM]: JSON.stringify({ version: 1, main: { provider: "openai", model: "gpt-4o", baseUrl: "https://my-openai-proxy/v1" } }) }).loadMain("/ws"))
			.toEqual({ provider: "openai", model: "gpt-4o", labGatewayUrl: "https://my-openai-proxy/v1" });
	});
	it("provider/model 불완전 = null", () => {
		expect(store({ [CONFIG]: JSON.stringify({ provider: "zai" }) }).loadMain("/ws")).toBeNull();
	});
});

describe("loadMain — 우선순위(config.json 정본 우선, llm.json 폴백)", () => {
	it("config.json 우선: 둘 다 있으면 config.json(naia-os UI 선택) 채택", () => {
		expect(store({
			[LLM]: JSON.stringify({ version: 1, main: { provider: "glm", model: "glm-5.1", apiKeyRef: "GLM_API_KEY" } }),
			[CONFIG]: JSON.stringify({ provider: "nextain", model: "gemini-2.5-flash" }),
		}).loadMain("/ws")).toEqual({ provider: "nextain", model: "gemini-2.5-flash" }); // config.json 채택(desktop SoT)
	});
	it("config.json 부재 시 llm.json 폴백(구 CLI 3-role, apiKeyRef→키체인 secret)", () => {
		expect(store({
			[LLM]: JSON.stringify({ version: 1, main: { provider: "glm", model: "glm-5.1", apiKeyRef: "GLM_API_KEY" } }),
		}).loadMain("/ws")).toEqual({ provider: "glm", model: "glm-5.1", apiKey: "glm-SECRET" });
	});
	it("★ stale llm.json(구 {openai:..} 포맷, main 없음) 무시 + config.json 채택", () => {
		expect(store({
			[LLM]: JSON.stringify({ openai: { baseURL: "http://127.0.0.1:8000/v1", model: "naia-coding", apiKey: "EMPTY" } }),
			[CONFIG]: JSON.stringify({ provider: "zai", model: "glm-5.1" }),
		}).loadMain("/ws")).toEqual({ provider: "zai", model: "glm-5.1" }); // llm.json shape 불일치 → config.json
	});
	it("llm.json nextain main → lab-proxy 키 배치(naiaKey + labGatewayUrl)", () => {
		expect(store({ [LLM]: JSON.stringify({ version: 1, main: { provider: "nextain", model: "gemini-2.5-flash", baseUrl: "https://api.nextain.io", apiKeyRef: "NAIA_ANYLLM_API_KEY" } }) }).loadMain("/ws"))
			.toEqual({ provider: "nextain", model: "gemini-2.5-flash", naiaKey: "naia-LOGIN", labGatewayUrl: "https://api.nextain.io" });
	});
	it("둘 다 없음 = null(env-only degrade, no-throw)", () => {
		expect(store({}).loadMain("/ws")).toBeNull();
	});
	it("adkPath 빈값 = null", () => {
		expect(store({ [CONFIG]: "{}" }).loadMain("")).toBeNull();
	});
	it("trailing slash 정규화(/ws/ → /ws/naia-settings/...)", () => {
		expect(store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "glm-5.1" }) }).loadMain("/ws/")?.provider).toBe("zai");
	});
});

describe("loadMain — llm.json 평문 키 방어", () => {
	it("main 에 raw 자격증명(apiKey 필드/sk- 값) = llm.json 거부 → config 없으면 null(폴백 없음)", () => {
		expect(store({
			[LLM]: JSON.stringify({ main: { provider: "glm", model: "glm-5.1", apiKey: "sk-deadbeef12345678" } }),
		}).loadMain("/ws")).toBeNull();
	});
	it("apiKeyRef 값이 raw 키처럼 생김 = 거부", () => {
		expect(store({ [LLM]: JSON.stringify({ main: { provider: "anthropic", model: "claude", apiKeyRef: "sk-ant-api03-AAAAAAAA" } }) }).loadMain("/ws")).toBeNull();
	});
	it("apiKeyRef 미해석(키체인에 없음) = 키 필드 생략", () => {
		expect(store({ [LLM]: JSON.stringify({ main: { provider: "glm", model: "glm-5.1", apiKeyRef: "MISSING_KEY" } }) }).loadMain("/ws"))
			.toEqual({ provider: "glm", model: "glm-5.1" });
	});
});

describe("roleHasPlaintextSecret (불변식 방어 단위)", () => {
	it("apiKeyRef 만 = 안전(false)", () => {
		expect(roleHasPlaintextSecret({ provider: "glm", model: "x", apiKeyRef: "GLM_API_KEY" })).toBe(false);
	});
	it("secret-ish 키(token/api_key) = true", () => {
		expect(roleHasPlaintextSecret({ provider: "x", token: "abc" })).toBe(true);
		expect(roleHasPlaintextSecret({ provider: "x", api_key: "y" })).toBe(true);
	});
	it("raw 자격증명처럼 생긴 값 = true(키 이름 무관)", () => {
		expect(roleHasPlaintextSecret({ provider: "x", baseUrl: "AIzaSyAAAAAAAAAA" })).toBe(true);
	});
});

describe("loadMemoryConfig — config.json 의 adapter/embedding 선택(issue #7)", () => {
	it("config 부재 = null(메모리 기본 local+키워드-only)", () => {
		expect(store({}).loadMemoryConfig("/ws")).toBeNull();
	});
	it("memory 미설정 config → adapter=local, embedding.provider=none(기본)", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "glm-5.1" }) }).loadMemoryConfig("/ws");
		expect(r?.adapter).toBe("local");
		expect(r?.embedding.provider).toBe("none");
	});
	it("offline embedding device(gpu/cpu) 매핑 + 무효값 무시", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryEmbeddingProvider: "offline", memoryEmbeddingDevice: "gpu" }) }).loadMemoryConfig("/ws");
		expect(r?.embedding.device).toBe("gpu");
		const r2 = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryEmbeddingProvider: "offline", memoryEmbeddingDevice: "tpu" }) }).loadMemoryConfig("/ws");
		expect(r2?.embedding.device).toBeUndefined();
	});
	it("offline embedding + offlineModel 매핑", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryEmbeddingProvider: "offline", memoryOfflineModel: "all-mpnet-base-v2" }) }).loadMemoryConfig("/ws");
		expect(r?.embedding.provider).toBe("offline");
		expect(r?.embedding.offlineModel).toBe("all-mpnet-base-v2");
	});
	it("vllm embedding(baseUrl/model) 매핑", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryEmbeddingProvider: "vllm", memoryEmbeddingBaseUrl: "http://localhost:11434", memoryEmbeddingModel: "nomic-embed-text" }) }).loadMemoryConfig("/ws");
		expect(r?.embedding.provider).toBe("vllm");
		expect(r?.embedding.baseUrl).toBe("http://localhost:11434");
		expect(r?.embedding.model).toBe("nomic-embed-text");
	});
	it("qdrant adapter + qdrantUrl 매핑(키는 strip → config 엔 없음)", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryAdapter: "qdrant", qdrantUrl: "http://localhost:6333" }) }).loadMemoryConfig("/ws");
		expect(r?.adapter).toBe("qdrant");
		expect(r?.qdrantUrl).toBe("http://localhost:6333");
		expect(r?.qdrantApiKey).toBeUndefined(); // strip 됨 → resolveSecret 미공급 시 부재
	});
	it("비밀(embed/qdrant apiKey)은 resolveSecret(env/키체인)로 best-effort 채움", () => {
		const secretStore = makeNaiaSettingsStore({
			fs: memFs({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryAdapter: "qdrant", qdrantUrl: "http://q", memoryEmbeddingProvider: "vllm", memoryEmbeddingBaseUrl: "http://e", memoryEmbeddingModel: "em" }) }),
			resolveSecret: (ref) => ({ NAIA_MEMORY_QDRANT_API_KEY: "qd-SECRET", NAIA_MEMORY_EMBED_API_KEY: "emb-SECRET" })[ref],
		});
		const r = secretStore.loadMemoryConfig("/ws");
		expect(r?.qdrantApiKey).toBe("qd-SECRET");
		expect(r?.embedding.apiKey).toBe("emb-SECRET");
	});
});

describe("loadMemoryConfig — LLM 사실추출 선택(issue #7)", () => {
	it("미설정 → llm.provider=none(휴리스틱)", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m" }) }).loadMemoryConfig("/ws");
		expect(r?.llm.provider).toBe("none");
	});
	it("vllm LLM(baseUrl/model) 매핑", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryLlmProvider: "vllm", memoryLlmBaseUrl: "http://localhost:8000", memoryLlmModel: "qwen" }) }).loadMemoryConfig("/ws");
		expect(r?.llm.provider).toBe("vllm");
		expect(r?.llm.baseUrl).toBe("http://localhost:8000");
		expect(r?.llm.model).toBe("qwen");
	});
	it("naia LLM = 게이트웨이(naiaGatewayUrl) + naiaKey(resolveSecret) 정규화", () => {
		const secretStore = makeNaiaSettingsStore({
			fs: memFs({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryLlmProvider: "naia", naiaGatewayUrl: "https://gw", memoryLlmModel: "vertexai:gemini" }) }),
			// 정식 account = NAIA_ANYLLM_API_KEY(os writeAgentKey(naiaKey)가 쓰는 곳).
			resolveSecret: (ref) => ({ NAIA_ANYLLM_API_KEY: "naia-SECRET" })[ref],
		});
		const r = secretStore.loadMemoryConfig("/ws");
		expect(r?.llm.provider).toBe("naia");
		expect(r?.llm.baseUrl).toBe("https://gw");
		expect(r?.llm.apiKey).toBe("naia-SECRET");
		expect(r?.llm.model).toBe("vertexai:gemini");
	});
});

describe("loadMemoryConfig — naia sub-LLM model 폴백 + graceful degrade (S5/G5)", () => {
	// 실데이터(D:/alpha-adk/naia-settings/config.json): memoryLlmProvider:"naia" + NAIA_ANYLLM_BASE_URL 인데
	// memoryLlmModel 부재(OS SettingsTab 이 naia 일 때 model 입력란 미렌더). 폴백 없으면 model 누락 →
	// makeNaiaMemory 의 fail-closed throw → memory=off(G5). 기본 게이트웨이 경량 모델로 채워 init 정상화.
	it("naia LLM + memoryLlmModel 부재 + 키 존재 → 기본 모델로 완전 구성(memory init 정상)", () => {
		const secretStore = makeNaiaSettingsStore({
			fs: memFs({ [CONFIG]: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6", memoryLlmProvider: "naia", NAIA_ANYLLM_BASE_URL: "https://api.nextain.io" }) }),
			resolveSecret: (ref) => ({ NAIA_ANYLLM_API_KEY: "naia-SECRET" })[ref],
		});
		const r = secretStore.loadMemoryConfig("/ws");
		expect(r?.llm.provider).toBe("naia");
		expect(r?.llm.baseUrl).toBe("https://api.nextain.io");
		expect(r?.llm.apiKey).toBe("naia-SECRET");
		expect(r?.llm.model).toBe("gemini-3.1-flash-lite"); // 기본 폴백(메모리 경량 sub-LLM)
	});
	it("명시 memoryLlmModel 은 기본 폴백보다 우선", () => {
		const secretStore = makeNaiaSettingsStore({
			fs: memFs({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryLlmProvider: "naia", memoryLlmModel: "vertexai:gemini-3.1-flash" }) }),
			resolveSecret: (ref) => ({ NAIA_ANYLLM_API_KEY: "naia-SECRET" })[ref],
		});
		expect(secretStore.loadMemoryConfig("/ws")?.llm.model).toBe("vertexai:gemini-3.1-flash");
	});
	it("★ graceful degrade: naia 인데 키(naiaKey) 부재 → llm.provider=none(휴리스틱, 메모리 계속 동작 — 전체 OFF 아님)", () => {
		// 게이트웨이 호출 키가 없으면 LLM 추출은 불가하지만, embedding/키워드 회상·저장은 살아야 한다.
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryLlmProvider: "naia", memoryLlmModel: "x" }) /* store 의 secrets 엔 NAIA_ANYLLM_API_KEY 가 있음 */ }).loadMemoryConfig("/ws");
		// 기본 store 의 secrets 에는 NAIA_ANYLLM_API_KEY=naia-LOGIN 이 있어 키가 존재 → 정상 구성된다(대조군).
		expect(r?.llm.provider).toBe("naia");
		// 키 없는 store 로 다시 — 강등 검증
		const noKey = makeNaiaSettingsStore({
			fs: memFs({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryLlmProvider: "naia", memoryLlmModel: "x" }) }),
			resolveSecret: () => undefined,
		});
		const d = noKey.loadMemoryConfig("/ws");
		expect(d?.llm.provider).toBe("none"); // 강등 — buildMemoryFactExtractor=undefined(휴리스틱), memory 계속 동작
		expect(d?.llm.baseUrl).toBeUndefined();
		expect(d?.llm.model).toBeUndefined();
		expect(d?.adapter).toBe("local"); // 메모리 자체는 살아있음
	});
	it("vllm sub-LLM 은 model 만 있고 baseUrl 누락이면 degrade→none(graceful, throw 아님)", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryLlmProvider: "vllm", memoryLlmModel: "qwen" }) }).loadMemoryConfig("/ws");
		expect(r?.llm.provider).toBe("none"); // baseUrl 없음 → 구성 불가 → 강등(메모리 살아있음)
	});
});

describe("loadMemoryConfig — naia 게이트웨이 URL 폴백(적대적 리뷰 HIGH 수정: OS 가 naiaGatewayUrl 미기록)", () => {
	it("naia LLM — config 게이트웨이 없으면 기본 api.nextain.io 폴백(키워드-only 무단 강등 방지)", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryLlmProvider: "naia", memoryLlmModel: "vertexai:gemini" }) }).loadMemoryConfig("/ws");
		expect(r?.llm.provider).toBe("naia");
		expect(r?.llm.baseUrl).toBe("https://api.nextain.io"); // 이전엔 undefined → buildMemorySummarizer/FactExtractor throw → 메모리 OFF
	});
	it("naia 임베딩 — naiaGatewayUrl 기본 폴백(항상 게이트웨이 존재)", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryEmbeddingProvider: "naia" }) }).loadMemoryConfig("/ws");
		expect(r?.embedding.provider).toBe("naia");
		expect(r?.embedding.naiaGatewayUrl).toBe("https://api.nextain.io");
	});
	it("NAIA_ANYLLM_BASE_URL(OS buildNaiaConfigEnv 산출) 가 naiaGatewayUrl 보다 폴백 우선", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryEmbeddingProvider: "naia", NAIA_ANYLLM_BASE_URL: "https://gw.custom" }) }).loadMemoryConfig("/ws");
		expect(r?.embedding.naiaGatewayUrl).toBe("https://gw.custom");
	});
	it("config naiaGatewayUrl 가 최우선(명시값 > NAIA_ANYLLM_BASE_URL > 기본)", () => {
		const r = store({ [CONFIG]: JSON.stringify({ provider: "zai", model: "m", memoryEmbeddingProvider: "naia", naiaGatewayUrl: "https://gw.explicit", NAIA_ANYLLM_BASE_URL: "https://gw.env" }) }).loadMemoryConfig("/ws");
		expect(r?.embedding.naiaGatewayUrl).toBe("https://gw.explicit");
	});
});

describe("loadEngineProfile — naia-os Profile & Engine 계약 (mode 잔재 Phase 3.3 폐기)", () => {
	it("nextain main + naia sub/embedding + GPU tier (3-role 스냅샷, mode 없음)", () => {
		const r = store({
			[CONFIG]: JSON.stringify({
				provider: "nextain",
				model: "gemini-2.5-flash",
				memoryLlmProvider: "naia",
				memoryEmbeddingProvider: "naia",
				localGpuTier: "auto",
			}),
		}).loadEngineProfile("/ws");
		expect(r).toEqual({
			mainProvider: "nextain",
			mainModel: "gemini-2.5-flash",
			subProvider: "naia",
			embeddingProvider: "naia",
			localGpuTier: "auto",
		});
		// mode(3-profile 잔재)는 Phase 3.3 폐기 — 필드 없음 단언.
		expect((r as unknown as Record<string, unknown>)?.mode).toBeUndefined();
	});

	it("ollama/vllm main + local memory providers (3-role 스냅샷)", () => {
		const r = store({
			[CONFIG]: JSON.stringify({
				provider: "ollama",
				model: "gemma3:4b",
				memoryLlmProvider: "ollama",
				memoryEmbeddingProvider: "ollama",
				localGpuTier: "external-llm-6g",
			}),
		}).loadEngineProfile("/ws");
		expect(r).toEqual({
			mainProvider: "ollama",
			mainModel: "gemma3:4b",
			subProvider: "ollama",
			embeddingProvider: "ollama",
			localGpuTier: "external-llm-6g",
		});
	});

	it("external API main; invalid sub/embedding/tier degrade to none/off", () => {
		const r = store({
			[CONFIG]: JSON.stringify({
				provider: "gemini",
				model: "gemini-2.5-flash",
				memoryLlmProvider: "openai",
				memoryEmbeddingProvider: "pinecone",
				localGpuTier: "12gb",
			}),
		}).loadEngineProfile("/ws");
		expect(r).toEqual({
			mainProvider: "gemini",
			mainModel: "gemini-2.5-flash",
			subProvider: "none",
			embeddingProvider: "none",
			localGpuTier: "off",
		});
	});

	it("missing or incomplete config degrades to null", () => {
		expect(store({}).loadEngineProfile("/ws")).toBeNull();
		expect(store({ [CONFIG]: JSON.stringify({ provider: "nextain" }) }).loadEngineProfile("/ws")).toBeNull();
		expect(store({ [CONFIG]: JSON.stringify({ provider: "nextain", model: "m" }) }).loadEngineProfile("")).toBeNull();
	});
});
