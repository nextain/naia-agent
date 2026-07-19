import { describe, expect, it } from "vitest";
import { evaluateDiscordIngress, type DiscordIngressPolicyInput } from "../main/domain/discord-ingress-policy.js";

const allowed: DiscordIngressPolicyInput = {
	readySelfUserId: "bot-1", messageId: "m-1", guildId: "g-1", channelId: "c-1",
	authorId: "u-1", authorIsBot: false, mentionsSelf: true, repliesToSelf: false,
	allowedGuildIds: ["g-1"], allowedChannelIds: ["c-1"], allowedUserIds: ["u-1"],
};
describe("PROPOSED-REQ-DG-02 partial", () => {
	it.each([
		[{ ...allowed, readySelfUserId: null }, "pre_ready"],
		[{ ...allowed, authorIsBot: true }, "bot_author"],
		[{ ...allowed, authorId: "bot-1" }, "self_author"],
		[{ ...allowed, guildId: "g-2" }, "guild_denied"],
		[{ ...allowed, channelId: "c-2" }, "channel_denied"],
		[{ ...allowed, authorId: "u-2" }, "user_denied"],
		[{ ...allowed, mentionsSelf: false, repliesToSelf: false }, "not_addressed"],
	] as const)("fail-closed reason", (input, reason) => {
		expect(evaluateDiscordIngress(input)).toEqual({ accepted: false, reason });
	});
	it("mention/reply를 허용한다", () => {
		expect(evaluateDiscordIngress(allowed)).toEqual({ accepted: true, messageId: "m-1" });
		expect(evaluateDiscordIngress({ ...allowed, mentionsSelf: false, repliesToSelf: true }))
			.toEqual({ accepted: true, messageId: "m-1" });
	});
	it("malformed와 상한 초과를 거부한다", () => {
		expect(evaluateDiscordIngress(42)).toEqual({ accepted: false, reason: "invalid_event" });
		expect(evaluateDiscordIngress({ ...allowed, authorIsBot: "false" } as unknown))
			.toEqual({ accepted: false, reason: "invalid_event" });
		expect(evaluateDiscordIngress({ ...allowed, allowedUserIds: Array(257).fill("u-1") }))
			.toEqual({ accepted: false, reason: "invalid_event" });
	});
	it("identifier·allowlist 정확한 경계를 허용한다", () => {
		const id = "u".repeat(128);
		expect(evaluateDiscordIngress({
			...allowed, authorId: id,
			allowedUserIds: [id, ...Array.from({ length: 255 }, (_, i) => `u-${i}`)],
		})).toEqual({ accepted: true, messageId: "m-1" });
		expect(evaluateDiscordIngress({ ...allowed, authorId: "u".repeat(129), allowedUserIds: ["u".repeat(129)] }))
			.toEqual({ accepted: false, reason: "invalid_event" });
	});
	it("hostile array own-method override를 무시한다", () => {
		const hostile = ["g-1"];
		Object.defineProperties(hostile, { includes: { value: null }, every: { value: null } });
		expect(evaluateDiscordIngress({ ...allowed, allowedGuildIds: hostile }))
			.toEqual({ accepted: true, messageId: "m-1" });
	});
});
