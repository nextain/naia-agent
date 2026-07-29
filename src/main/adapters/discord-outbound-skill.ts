import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolCall, ToolSpec } from "../domain/chat.js";
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { OutboundAttachment, OutboundDeliveryPort } from "../ports/outbound-delivery.js";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_CONTENT = 2_000;
const CONTROL = /[\u0000-\u001f\u007f]/;

const tool: ToolSpec = {
  name: "discord_send",
  description: "승인된 Discord 목적지로 결과를 보낸다. destinationId는 Shell에서 승인한 id만 사용하며, 파일은 현재 작업공간의 안전한 상대 경로만 허용한다.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["send", "list"] },
      destinationId: { type: "string", description: "Shell 승인 목적지 id" },
      content: { type: "string", description: "보낼 본문 (최대 2000자)" },
      files: { type: "array", items: { type: "string" }, description: "작업공간 상대 파일 경로 (최대 5개)" },
    },
    required: ["destinationId", "content"],
  },
  tier: "ask",
};

function safeString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max && !CONTROL.test(value);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentLength(value: string): number { return Array.from(value).length; }

function mimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".csv")) return "text/plain";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

async function attachmentsFor(workspace: string, values: unknown): Promise<readonly OutboundAttachment[]> {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > MAX_FILES || !values.every((value) => safeString(value, 500))) {
    throw new Error("invalid files");
  }
  const root = await realpath(workspace);
  let total = 0;
  const attachments: OutboundAttachment[] = [];
  for (const value of values) {
    if (isAbsolute(value) || value.split(/[\\/]+/u).includes("data-private")) throw new Error("file not allowed");
    const candidate = resolve(root, value);
    const rel = relative(root, candidate);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("file outside workspace");
    const path = await realpath(candidate);
    const canonicalRel = relative(root, path);
    if (!canonicalRel || canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)
      || canonicalRel.split(/[\\/]+/u).includes("data-private")) throw new Error("file outside workspace");
    const info = await stat(path);
    if (!info.isFile() || info.size < 0 || info.size > MAX_FILE_BYTES) throw new Error("file too large");
    total += info.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("attachments too large");
    const name = canonicalRel.split(/[\\/]+/u).at(-1)!;
    attachments.push({ name, bytes: await readFile(path), mimeType: mimeType(name) });
  }
  return attachments;
}

export function makeDiscordOutboundExecutor(deps: {
  readonly delivery?: OutboundDeliveryPort;
  readonly workspace: () => string | undefined;
  readonly destinationIds?: () => readonly string[];
}): ToolExecutorPort {
  return {
    specs: () => deps.delivery ? [tool] : [],
    async execute(call: ToolCall): Promise<{ output: string; isError?: boolean }> {
      if (call.name !== tool.name) return { output: `unknown tool: ${call.name}`, isError: true };
      if (isObject(call.args) && call.args.action === "list") {
        const ids = deps.destinationIds?.() ?? [];
        return { output: ids.length ? `Approved Discord destinations: ${ids.join(", ")}` : "No approved Discord destinations." };
      }
      if (!deps.delivery || !call.args || typeof call.args !== "object" || Array.isArray(call.args)) {
        return { output: "Discord delivery is unavailable.", isError: true };
      }
      const args = call.args as Record<string, unknown>;
      if (!safeString(args.destinationId, 128) || !safeString(args.content, MAX_CONTENT) || contentLength(args.content) > MAX_CONTENT) {
        return { output: "destinationId and bounded content are required.", isError: true };
      }
      const workspace = deps.workspace();
      if (!workspace) return { output: "workspace is unavailable for delivery.", isError: true };
      try {
        const attachments = await attachmentsFor(workspace, args.files);
        const result = await deps.delivery.send({ destinationId: args.destinationId, content: args.content, attachments });
        return { output: `Discord delivery completed (message ${result.messageId}; attachments ${attachments.length}).` };
      } catch {
        // Do not reflect destination, content, filenames, or remote errors into the model/log surface.
        return { output: "Discord delivery failed or was not permitted.", isError: true };
      }
    },
  };
}
