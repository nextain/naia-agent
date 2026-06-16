// 라이브 설정 reload(정본 R1-2 "startup-only 금지") — 사용자가 naia-os 에서 모델/프로바이더 교체 시
// OS 가 naia-settings 갱신 후 ReloadSettings/SetWorkspace 재호출 → entry 가 setDefaultConfig 로 활성 config swap →
// 다음 턴부터 새 provider 사용. 재기동 없이 모델 전환이 실제로 반영되는지 검증(=사용자 "모델 안 바뀜" 회귀 잠금).
import { describe, it, expect } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import type { ProviderConfig, ChatRequest } from "../main/domain/chat.js";
import type { ProviderResolverPort } from "../main/ports/uc1.js";

function recordingResolver(seen: string[]): ProviderResolverPort {
	return { resolve: (c: ProviderConfig) => { seen.push(`${c.provider}/${c.model}`); return makeFakeProvider(); } };
}
function deps(seen: string[], defaultConfig: ProviderConfig): HandlerDeps {
	return {
		provider: makeFakeProvider(),
		resolver: recordingResolver(seen),
		conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
		credentials: makeInMemoryCredentials(),
		approval: makeInMemoryApproval(),
		egress: { emit: () => {} },
		diag: { log: () => {} },
		defaultConfig,
	};
}
const chat = (id: string): ChatRequest => ({ kind: "chat", requestId: id, messages: [{ role: "user", content: "hi" }] });

describe("ChatTurnHandler — defaultConfig 라이브 reload(setDefaultConfig)", () => {
	it("초기 defaultConfig 사용 → setDefaultConfig 후 다음 턴이 새 config 사용(재기동 없음)", async () => {
		const seen: string[] = [];
		const h = new ChatTurnHandler(deps(seen, { provider: "nextain", model: "gemini-3.1-flash-lite" }));
		await h.onChatRequest(chat("r1"));
		h.setDefaultConfig({ provider: "zai", model: "glm-5.1" }); // OS ReloadSettings → entry swap
		await h.onChatRequest(chat("r2"));
		expect(seen).toEqual(["nextain/gemini-3.1-flash-lite", "zai/glm-5.1"]);
	});

	it("wire req.provider override 는 여전히 우선(있으면 그 턴만) — defaultConfig swap 과 독립", async () => {
		const seen: string[] = [];
		const h = new ChatTurnHandler(deps(seen, { provider: "nextain", model: "gemini-3.1-flash-lite" }));
		await h.onChatRequest({ ...chat("r1"), provider: { provider: "openai", model: "gpt-4o" } });
		expect(seen).toEqual(["openai/gpt-4o"]); // override 우선, defaultConfig 무시
	});

	it("setDefaultConfig(undefined) + wire override 없음 → no provider configured(턴 종료, 크래시 아님)", async () => {
		const seen: string[] = [];
		const h = new ChatTurnHandler(deps(seen, { provider: "nextain", model: "gemini-3.1-flash-lite" }));
		h.setDefaultConfig(undefined);
		await h.onChatRequest(chat("r1")); // activeConfig 없음 → terminalError, resolver 미호출
		expect(seen).toEqual([]);
	});
});
