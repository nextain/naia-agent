import { describe, expect, it } from "vitest";
import {
	evaluateDiscordDmIngress,
	evaluateDiscordIngress,
	type DiscordDmIngressPolicyInput,
	type DiscordIngressPolicyInput,
} from "../main/domain/discord-ingress-policy.js";

const allowed: DiscordIngressPolicyInput = {
	readySelfUserId: "bot-1", messageId: "m-1", guildId: "g-1", channelId: "c-1",
	authorId: "u-1", authorIsBot: false, mentionsSelf: true, repliesToSelf: false,
	allowedGuildIds: ["g-1"], allowedChannelIds: ["c-1"], allowedUserIds: ["u-1"],
	participation: "mentions",
};
describe("PROPOSED-REQ-DG-02 partial", () => {
	it.each([
		[{ ...allowed, readySelfUserId: null }, "pre_ready"],
		[{ ...allowed, authorIsBot: true }, "bot_author"],
		[{ ...allowed, authorId: "bot-1" }, "self_author"],
		[{ ...allowed, guildId: "g-2" }, "guild_denied"],
		[{ ...allowed, channelId: "c-2" }, "channel_denied"],
		[{ ...allowed, authorId: "u-2" }, "user_denied"],
		[{ ...allowed, participation: "paused" }, "participation_paused"],
		[{ ...allowed, mentionsSelf: false, repliesToSelf: false }, "not_addressed"],
	] as const)("fail-closed reason", (input, reason) => {
		expect(evaluateDiscordIngress(input)).toEqual({ accepted: false, reason });
	});
	it("all은 허용 사용자 메시지를 호출 없이 받고 paused는 항상 닫힌다", () => {
		expect(evaluateDiscordIngress({
			...allowed, participation: "all", mentionsSelf: false, repliesToSelf: false,
		})).toEqual({ accepted: true, messageId: "m-1" });
		expect(evaluateDiscordIngress({
			...allowed, participation: "all", authorId: "u-2", mentionsSelf: false,
		})).toEqual({ accepted: false, reason: "user_denied" });
		expect(evaluateDiscordIngress({
			...allowed, participation: "paused", repliesToSelf: true,
		})).toEqual({ accepted: false, reason: "participation_paused" });
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

describe("Discord direct-message policy", () => {
	const dm: DiscordDmIngressPolicyInput = {
		readySelfUserId: "bot-1",
		messageId: "m-1",
		channelId: "dm-channel-1",
		authorId: "u-1",
		authorIsBot: false,
		allowedUserIds: ["u-1"],
	};

	it("accepts only an allowlisted human after READY without requiring a mention", () => {
		expect(evaluateDiscordDmIngress(dm)).toEqual({ accepted: true, messageId: "m-1" });
		expect(evaluateDiscordDmIngress({ ...dm, readySelfUserId: null }))
			.toEqual({ accepted: false, reason: "pre_ready" });
		expect(evaluateDiscordDmIngress({ ...dm, allowedUserIds: [] }))
			.toEqual({ accepted: false, reason: "invalid_event" });
	});

	it.each([
		[{ ...dm, authorIsBot: true }, "bot_author"],
		[{ ...dm, authorId: "bot-1" }, "self_author"],
		[{ ...dm, authorId: "u-2" }, "user_denied"],
	] as const)("rejects unsafe DM sender: %o", (input, reason) => {
		expect(evaluateDiscordDmIngress(input)).toEqual({ accepted: false, reason });
	});
});
