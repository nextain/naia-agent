import type { CodingJobCourseLifecycleState } from "../domain/coding-job.js";
import type { DiscordRuntimeTextPort } from "../ports/discord.js";

export type DiscordRuntimeLocale = "en" | "ko";
type MessageKey =
  | "emptyReply"
  | "failureReply"
  | CodingJobCourseLifecycleState
  | "processingDisclosure";

const MESSAGES: Record<DiscordRuntimeLocale, Record<MessageKey, string>> = {
  en: {
    emptyReply: "No response was produced.",
    failureReply: "The request could not be processed.",
    received: "The course task was accepted.",
    running: "The course task is running.",
    completed: "The course task completed. Check the result in Shell.",
    failed: "The course task did not complete. Check its status in Shell.",
    processingDisclosure: "Processing: {workload} → {destination} ({decision})",
  },
  ko: {
    emptyReply: "응답을 만들지 못했습니다.",
    failureReply: "요청을 처리하지 못했습니다.",
    received: "수업 작업을 접수했습니다.",
    running: "수업 작업을 진행하고 있습니다.",
    completed: "수업 작업이 완료되었습니다. Shell에서 결과를 확인해 주세요.",
    failed: "수업 작업을 완료하지 못했습니다. Shell에서 작업 상태를 확인해 주세요.",
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
    courseLifecycle: (state) => messages[state],
    processingDisclosure: (input) => render(messages.processingDisclosure, {
      workload: input.workload,
      destination: input.destination,
      decision: input.decision,
    }),
  };
}
