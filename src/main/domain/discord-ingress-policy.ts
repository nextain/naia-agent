export interface DiscordIngressPolicyInput {
	readonly readySelfUserId: string | null;
	readonly messageId: string;
	readonly guildId: string;
	readonly channelId: string;
	readonly authorId: string;
	readonly authorIsBot: boolean;
	readonly mentionsSelf: boolean;
	readonly repliesToSelf: boolean;
	readonly allowedGuildIds: readonly string[];
	readonly allowedChannelIds: readonly string[];
	readonly allowedUserIds: readonly string[];
	readonly participation: "mentions" | "all" | "paused";
}

export type DiscordIngressDecision =
	| { readonly accepted: true; readonly messageId: string }
	| { readonly accepted: false; readonly reason:
		| "invalid_event" | "pre_ready" | "bot_author" | "self_author"
		| "guild_denied" | "channel_denied" | "user_denied"
		| "participation_paused" | "not_addressed" };

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ALLOWLIST_ENTRIES = 256;

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}
function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length <= MAX_ALLOWLIST_ENTRIES
		&& Array.prototype.every.call(value, isIdentifier);
}
function containsIdentifier(values: readonly string[], identifier: string): boolean {
	return Array.prototype.includes.call(values, identifier);
}
function isInput(value: unknown): value is DiscordIngressPolicyInput {
	if (typeof value !== "object" || value === null) return false;
	const input = value as Record<string, unknown>;
	return (input.readySelfUserId === null || isIdentifier(input.readySelfUserId))
		&& isIdentifier(input.messageId) && isIdentifier(input.guildId)
		&& isIdentifier(input.channelId) && isIdentifier(input.authorId)
		&& typeof input.authorIsBot === "boolean"
		&& typeof input.mentionsSelf === "boolean" && typeof input.repliesToSelf === "boolean"
		&& isStringArray(input.allowedGuildIds) && isStringArray(input.allowedChannelIds)
		&& isStringArray(input.allowedUserIds)
		&& ["mentions", "all", "paused"].includes(String(input.participation));
}

export function evaluateDiscordIngress(value: unknown): DiscordIngressDecision {
	try {
		if (!isInput(value)) return { accepted: false, reason: "invalid_event" };
		if (value.readySelfUserId === null) return { accepted: false, reason: "pre_ready" };
		if (value.authorIsBot) return { accepted: false, reason: "bot_author" };
		if (value.authorId === value.readySelfUserId) return { accepted: false, reason: "self_author" };
		if (!containsIdentifier(value.allowedGuildIds, value.guildId)) return { accepted: false, reason: "guild_denied" };
		if (!containsIdentifier(value.allowedChannelIds, value.channelId)) return { accepted: false, reason: "channel_denied" };
		if (!containsIdentifier(value.allowedUserIds, value.authorId)) return { accepted: false, reason: "user_denied" };
		if (value.participation === "paused") return { accepted: false, reason: "participation_paused" };
		if (value.participation === "mentions" && !value.mentionsSelf && !value.repliesToSelf) {
			return { accepted: false, reason: "not_addressed" };
		}
		return { accepted: true, messageId: value.messageId };
	} catch {
		return { accepted: false, reason: "invalid_event" };
	}
}
