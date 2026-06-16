// 전수 프로바이더 배선 검증 — 사용자 goal(2026-06-17): "new-naia-os 의 모든 프로바이더가 new-naia-agent 와 연결".
// 관통 경로(정본 Option S = 설정 기반): config.json(naia-os SoT) → loadMain → makeProviderResolver → 실제 fetch URL/auth.
// 순수(네트워크 mock — 실 API/GPU 불요). naia-os registry.ts 의 LLM 프로바이더 전수.
import { describe, it, expect } from "vitest";
import { makeNaiaSettingsStore, type SettingsFsRead } from "../main/adapters/naia-settings-store.js";
import { makeProviderResolver } from "../main/adapters/provider-resolver.js";
import type { ProviderConfig, ProviderChunk } from "../main/domain/chat.js";

function memFs(files: Record<string, string>): SettingsFsRead {
	return {
		existsSync: (p) => p in files,
		readFileSync: (p) => {
			if (!(p in files)) throw new Error(`ENOENT ${p}`);
			return files[p]!;
		},
	};
}
const CONFIG = "/ws/naia-settings/config.json";
/** config.json(naia-os 셸이 write_naia_config 로 기록하는 SoT) → loadMain 으로 ProviderConfig 조립(키 제외). */
function load(cfg: Record<string, unknown>): ProviderConfig {
	const c = makeNaiaSettingsStore({ fs: memFs({ [CONFIG]: JSON.stringify(cfg) }), resolveSecret: () => undefined }).loadMain("/ws");
	if (!c) throw new Error(`loadMain null for ${JSON.stringify(cfg)}`);
	return c;
}
/** 첫 fetch 의 url/headers 포착(transport 도달 + endpoint 확인). 스트림 즉시 done. */
function capture() {
	const box: { url?: string; headers?: Record<string, string> } = {};
	const fetch = async (url: string, init: { headers: Record<string, string> }) => {
		box.url = url;
		box.headers = init.headers;
		return { ok: true, status: 200, statusText: "OK", body: { getReader: () => ({ read: async () => ({ done: true }), cancel() {} }) } };
	};
	return { fetch, box };
}
async function collect(it: AsyncIterable<ProviderChunk>) {
	for await (const _ of it) {
		/* drain */
	}
}

// 키는 chat 시 credentials 포트가 공급(loadMain 엔 없음). 배선 검증엔 URL 이 핵심이라 테스트용 키만 직접 주입.
function withKey(c: ProviderConfig, secret: { apiKey?: string; naiaKey?: string }): ProviderConfig {
	return { ...c, ...secret };
}

interface WireCase {
	name: string;
	cfg: Record<string, unknown>;
	url: string;
	auth: "x-anyllm" | "bearer";
	key: { apiKey?: string; naiaKey?: string };
}

// naia-os registry.ts LLM 프로바이더 전수 (voice-only omni 모델 제외 — 텍스트 LLM 라우팅 대상).
const CASES: WireCase[] = [
	{
		name: "nextain(naia 계정) → lab-proxy(api.nextain.io/v1) + X-AnyLLM-Key",
		cfg: { provider: "nextain", model: "gemini-3.1-flash-lite", NAIA_ANYLLM_BASE_URL: "https://api.nextain.io" },
		url: "https://api.nextain.io/v1/chat/completions",
		auth: "x-anyllm",
		key: { naiaKey: "naia-XYZ" },
	},
	{
		name: "gemini → native(google openai-compat) + Bearer",
		cfg: { provider: "gemini", model: "gemini-2.5-flash" },
		url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
		auth: "bearer",
		key: { apiKey: "G-KEY" },
	},
	{
		name: "openai → native(api.openai.com/v1) + Bearer",
		cfg: { provider: "openai", model: "gpt-4o" },
		url: "https://api.openai.com/v1/chat/completions",
		auth: "bearer",
		key: { apiKey: "OAI-KEY" },
	},
	{
		name: "xai → native(api.x.ai/v1) + Bearer",
		cfg: { provider: "xai", model: "grok-3-mini" },
		url: "https://api.x.ai/v1/chat/completions",
		auth: "bearer",
		key: { apiKey: "XAI-KEY" },
	},
	{
		name: "zai(GLM coding) → native(api.z.ai) + Bearer",
		cfg: { provider: "zai", model: "glm-5.1" },
		url: "https://api.z.ai/api/coding/paas/v4/chat/completions",
		auth: "bearer",
		key: { apiKey: "GLM-KEY" },
	},
	{
		name: "vllm(custom host) → native({vllmHost}/v1) + Bearer",
		cfg: { provider: "vllm", model: "qwen", vllmHost: "http://gpu-box:8000" },
		url: "http://gpu-box:8000/v1/chat/completions",
		auth: "bearer",
		key: { apiKey: "" },
	},
];

describe("all-providers wiring — naia-os 프로바이더 전수 (config.json → loadMain → resolver → fetch URL)", () => {
	for (const c of CASES) {
		it(c.name, async () => {
			const { fetch, box } = capture();
			const resolver = makeProviderResolver({ fetch: fetch as never });
			const cfg = withKey(load(c.cfg), c.key);
			await collect(resolver.resolve(cfg).chat(cfg, [], {}));
			expect(box.url).toBe(c.url);
			if (c.auth === "x-anyllm") {
				expect(box.headers?.["X-AnyLLM-Key"]).toBe(`Bearer ${c.key.naiaKey}`);
				expect(box.headers?.Authorization).toBeUndefined();
			} else {
				expect(box.headers?.Authorization).toBe(`Bearer ${c.key.apiKey ?? ""}`);
				expect(box.headers?.["X-AnyLLM-Key"]).toBeUndefined();
			}
		});
	}

	it("ollama(custom host) → native /api/chat 어댑터({ollamaHost}/api/chat)", async () => {
		const { fetch, box } = capture();
		const resolver = makeProviderResolver({ fetch: fetch as never });
		const cfg = load({ provider: "ollama", model: "gemma3:4b", ollamaHost: "http://ollama-box:11434" });
		await collect(resolver.resolve(cfg).chat(cfg, [], {}));
		expect(box.url).toBe("http://ollama-box:11434/api/chat"); // ollama 는 OpenAI-compat 아닌 native /api/chat
	});

	// anthropic·claude-code-cli — Anthropic Messages API(/v1/messages, x-api-key). claude-code = SDK/API 패러다임(CLI 아님, 루크 2026-06-17).
	for (const p of ["anthropic", "claude-code-cli"]) {
		it(`${p} → Anthropic Messages API(/v1/messages) + x-api-key`, async () => {
			const { fetch, box } = capture();
			const resolver = makeProviderResolver({ fetch: fetch as never });
			const cfg = withKey(load({ provider: p, model: "claude-sonnet-4-6" }), { apiKey: "ANTHROPIC-KEY" });
			await collect(resolver.resolve(cfg).chat(cfg, [], {}));
			expect(box.url).toBe("https://api.anthropic.com/v1/messages");
			expect(box.headers?.["x-api-key"]).toBe("ANTHROPIC-KEY");
			expect(box.headers?.["anthropic-version"]).toBe("2023-06-01");
			expect(box.headers?.Authorization).toBeUndefined(); // Bearer 아님 — x-api-key
		});
	}
});
