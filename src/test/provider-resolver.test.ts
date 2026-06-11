import { describe, expect, it } from "vitest";
import { resolveProviderSpec } from "../main/composition/provider-resolver.js";

/**
 * UC12 provider 해석 — naia-settings/config.json(NAIA_MAIN_*) + env 폴백.
 * 기존 컨벤션 필드 재사용 검증 + dev(AGENT_PROVIDER) 폴백 + 미선택→fake.
 */
describe("resolveProviderSpec (UC12 런타임 멀티-provider)", () => {
	it("config NAIA_MAIN_PROVIDER=glm → coding 엔드포인트 + GLM_KEY + glm-4.6", () => {
		const s = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "glm" }, env: { GLM_KEY: "k" } });
		expect(s.kind).toBe("openai-compat");
		if (s.kind !== "openai-compat") throw new Error();
		expect(s.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
		expect(s.apiKey).toBe("k");
		expect(s.model).toBe("glm-4.6");
	});

	it("glm: NAIA_MAIN_MODEL=naia-local(비-glm) → glm-4.6 강제 / glm-4.5 → 유지", () => {
		const a = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "glm", NAIA_MAIN_MODEL: "naia-local" }, env: { GLM_KEY: "k" } });
		const b = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "glm", NAIA_MAIN_MODEL: "glm-4.5" }, env: { GLM_KEY: "k" } });
		expect(a.kind === "openai-compat" && a.model).toBe("glm-4.6");
		expect(b.kind === "openai-compat" && b.model).toBe("glm-4.5");
	});

	it("GLM_KEY 가 GLM_API_KEY 보다 우선", () => {
		const s = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "glm" }, env: { GLM_KEY: "primary", GLM_API_KEY: "secondary" } });
		expect(s.kind === "openai-compat" && s.apiKey).toBe("primary");
	});

	it("config NAIA_MAIN_PROVIDER=ollama → ollama", () => {
		const s = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "ollama", NAIA_MAIN_MODEL: "gemma3:4b" }, env: {} });
		expect(s.kind).toBe("ollama");
		expect(s.kind === "ollama" && s.model).toBe("gemma3:4b");
	});

	it("naia(nextain) + NAIA_ANYLLM_BASE_URL → openai-compat + NAIA_ANYLLM_API_KEY", () => {
		const s = resolveProviderSpec({
			config: { NAIA_MAIN_PROVIDER: "nextain", NAIA_ANYLLM_BASE_URL: "https://gw/v1", NAIA_MAIN_MODEL: "naia-1" },
			env: { NAIA_ANYLLM_API_KEY: "nk" },
		});
		expect(s.kind).toBe("openai-compat");
		if (s.kind !== "openai-compat") throw new Error();
		expect(s.baseUrl).toBe("https://gw/v1");
		expect(s.apiKey).toBe("nk");
		expect(s.model).toBe("naia-1");
	});

	it("naia 선택인데 base url 없음 → fake(reason)", () => {
		const s = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "naia" }, env: {} });
		expect(s.kind).toBe("fake");
		expect(s.kind === "fake" && /NAIA_ANYLLM_BASE_URL/.test(s.reason)).toBe(true);
	});

	it("vllm + OPENAI_BASE_URL → openai-compat(키 없음)", () => {
		const s = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "vllm", OPENAI_BASE_URL: "http://h:8000/v1", NAIA_MAIN_MODEL: "qwen" }, env: {} });
		expect(s.kind).toBe("openai-compat");
		expect(s.kind === "openai-compat" && s.baseUrl).toBe("http://h:8000/v1");
		expect(s.kind === "openai-compat" && s.apiKey).toBe("");
	});

	it("openai → 기본 api.openai.com/v1 + OPENAI_API_KEY", () => {
		const s = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "openai", NAIA_MAIN_MODEL: "gpt-4o" }, env: { OPENAI_API_KEY: "oa" } });
		expect(s.kind === "openai-compat" && s.baseUrl).toBe("https://api.openai.com/v1");
		expect(s.kind === "openai-compat" && s.apiKey).toBe("oa");
	});

	it("config 없음 + AGENT_PROVIDER=glm env → glm (dev 폴백)", () => {
		const s = resolveProviderSpec({ config: {}, env: { AGENT_PROVIDER: "glm", GLM_KEY: "k" } });
		expect(s.kind).toBe("openai-compat");
		expect(s.kind === "openai-compat" && s.label.startsWith("glm")).toBe(true);
	});

	it("config 의 NAIA_MAIN_PROVIDER 가 AGENT_PROVIDER env 를 덮어씀(config 우선)", () => {
		const s = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "glm" }, env: { AGENT_PROVIDER: "ollama", GLM_KEY: "k" } });
		expect(s.kind).toBe("openai-compat"); //  glm, not ollama
	});

	it("provider 미선택(빈 config + env 없음) → fake", () => {
		const s = resolveProviderSpec({ config: {}, env: {} });
		expect(s.kind).toBe("fake");
	});

	it("미지원 provider(anthropic) → fake(reason)", () => {
		const s = resolveProviderSpec({ config: { NAIA_MAIN_PROVIDER: "anthropic" }, env: {} });
		expect(s.kind).toBe("fake");
		expect(s.kind === "fake" && /미지원/.test(s.reason)).toBe(true);
	});
});
