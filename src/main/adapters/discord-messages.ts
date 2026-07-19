import type { DiscordRuntimeTextPort } from "../ports/discord.js";

export type DiscordRuntimeLocale = "en" | "ko";
type MessageKey =
  | "emptyReply"
  | "failureReply"
  | "processingDisclosure";

const MESSAGES: Record<DiscordRuntimeLocale, Record<MessageKey, string>> = {
  en: {
    emptyReply: "No response was produced.",
    failureReply: "The request could not be processed.",
    processingDisclosure: "Processing: {workload} → {destination} ({decision})",
  },
  ko: {
    emptyReply: "응답을 만들지 못했습니다.",
    failureReply: "요청을 처리하지 못했습니다.",
    processingDisclosure: "처리: {workload} → {destination} ({decision})",
  },
};

function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (_match, key: string) => values[key] ?? "");
}

export function makeDiscordRuntimeText(locale: DiscordRuntimeLocale): DiscordRuntimeTextPort {
  const messages = MESSAGES[locale];
  return {
    emptyReply: () => messages.emptyReply,
    failureReply: () => messages.failureReply,
    processingDisclosure: (input) => render(messages.processingDisclosure, {
      workload: input.workload,
      destination: input.destination,
      decision: input.decision,
    }),
  };
}
