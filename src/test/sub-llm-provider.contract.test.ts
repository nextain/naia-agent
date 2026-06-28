import { describe, expect, it, vi } from "vitest";
import { buildSubLlmProvider } from "../main/adapters/sub-llm-provider.js";

/**
 * Phase 3.2 — SubLlmPort first-class 표면 계약. sub-LLM 배치(adk-batch·경량) 호출.
 * memoryLlmConfig(naia/vllm/ollama) → OpenAI-compat 비스트리밍. 미구성=undefined(호출처 폴백).
 */
function makeFetch(impl: (url: string, body: unknown) => { ok: boolean; status: number; payload: unknown }) {
	return vi.fn(async (url: string, init: { body: string }) => {
		const r = impl(url, JSON.parse(init.body));
		return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.payload) };
	});
}

describe("buildSubLlmProvider — 구성 해석(미구성=undefined)", () => {
	it("provider='none' → undefined", () => {
		expect(buildSubLlmProvider({ provider: "none" }, { fetch: makeFetch(() => ({ ok: true, status: 200, payload: {} })) })).toBeUndefined();
	});

	it("undefined cfg → undefined", () => {
		expect(buildSubLlmProvider(undefined, { fetch: makeFetch(() => ({ ok: true, status: 200, payload: {} })) })).toBeUndefined();
	});

	it("필수 필드 누락(baseUrl/model) → undefined(fail-open, throw 아님)", () => {
		expect(buildSubLlmProvider({ provider: "ollama" }, { fetch: makeFetch(() => ({ ok: true, status: 200, payload: {} })) })).toBeUndefined();
		expect(buildSubLlmProvider({ provider: "vllm", model: "x" }, { fetch: makeFetch(() => ({ ok: true, status: 200, payload: {} })) })).toBeUndefined();
	});

	it("유효 cfg → SubLlmPort(provider/model 노출)", () => {
		const p = buildSubLlmProvider(
			{ provider: "ollama", baseUrl: "http://localhost:11434/v1", model: "llama3", apiKey: "" },
			{ fetch: makeFetch(() => ({ ok: true, status: 200, payload: {} })) },
		);
		expect(p).toBeDefined();
		expect(p!.provider).toBe("ollama");
		expect(p!.model).toBe("llama3");
	});
});

describe("SubLlmPort.complete — OpenAI-compat 비스트리밍 호출", () => {
	it("systemPrompt + prompt → /chat/completions POST, choices[0].message.content 반환", async () => {
		const fetchFn = makeFetch((_url, body) => {
			const msgs = (body as { messages: { role: string; content: string }[] }).messages;
			expect(msgs[0]).toEqual({ role: "system", content: "sys" });
			expect(msgs[1]).toEqual({ role: "user", content: "hi" });
			return { ok: true, status: 200, payload: { choices: [{ message: { content: "hello back" } }] } };
		});
		const p = buildSubLlmProvider(
			{ provider: "naia", baseUrl: "https://gw/v1", model: "gemini-3.1-flash-lite", apiKey: "k" },
			{ fetch: fetchFn },
		)!;
		const out = await p.complete("hi", { systemPrompt: "sys" });
		expect(out).toBe("hello back");
		expect(fetchFn).toHaveBeenCalledWith(
			"https://gw/v1/chat/completions",
			expect.objectContaining({ method: "POST" }),
		);
		// authorization header(apiKey 있음).
		const init = (fetchFn.mock.calls[0] as unknown[])[1] as { headers: Record<string, string> };
		expect(init.headers.authorization).toBe("Bearer k");
	});

	it("HTTP 실패 → throw(호출처 폴백 결정)", async () => {
		const p = buildSubLlmProvider(
			{ provider: "vllm", baseUrl: "http://x/v1", model: "m" },
			{ fetch: makeFetch(() => ({ ok: false, status: 500, payload: { error: "boom" } })) },
		)!;
		await expect(p.complete("hi")).rejects.toThrow(/HTTP 500/);
	});

	it("후행 슬래시 base URL 정규화", async () => {
		const fetchFn = makeFetch(() => ({ ok: true, status: 200, payload: { choices: [{ message: { content: "ok" } }] } }));
		const p = buildSubLlmProvider(
			{ provider: "ollama", baseUrl: "http://h:11434/v1///", model: "m" },
			{ fetch: fetchFn },
		)!;
		await p.complete("x");
		expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe("http://h:11434/v1/chat/completions");
	});
});
