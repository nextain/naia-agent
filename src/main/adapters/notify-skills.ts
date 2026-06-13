// adapters/notify-skills — 알림 ToolExecutorPort(slack/discord/google_chat webhook). old notify-{slack,discord,google-chat} 패턴 이식.
// ⚠️ external = injected post(fetch) + webhookUrl(config/secret). 미주입/미설정=정직 unsupported.
// §E 동일 규약(github): no-throw 경계, abort 가드, arg 검증. tier="ask"(외부 메시지 발신 → UC13 승인).
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import { isAborted } from "./signal-util.js";

export type NotifyTarget = "slack" | "discord" | "google_chat";
const TARGETS: readonly NotifyTarget[] = ["slack", "discord", "google_chat"];

/** webhook POST(injected). 미주입=발신 불가. */
export type WebhookPost = (url: string, body: unknown, signal?: AbortSignal) => Promise<{ ok: boolean; status: number }>;
/** target 별 webhook URL 해석(config/secret). 미설정=null. */
export type WebhookUrlResolver = (target: NotifyTarget) => Promise<string | null>;
export interface NotifyDeps { post?: WebhookPost; webhookUrl?: WebhookUrlResolver; }

const TOOLS: readonly ToolSpec[] = [
  {
    name: "notify",
    description: "외부 채널로 알림 발신(slack/discord/google_chat). 인자: {target, message}. 사용자가 알림/메시지 전송을 원할 때.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: [...TARGETS], description: TARGETS.join(" | ") },
        message: { type: "string", description: "보낼 메시지" },
      },
      required: ["target", "message"],
    },
    tier: "ask", // 외부 발신 → 승인
  },
];

const ok = (output: string) => ({ output });
const err = (output: string) => ({ output, isError: true });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function safeMsg(e: unknown): string {
  try { if (e !== null && typeof e === "object") { const m = (e as { message?: unknown }).message; if (typeof m === "string") return m; } } catch { /* getter throw */ }
  try { return String(e); } catch { return "tool error"; }
}
/** target 별 webhook payload(old 충실: slack/google_chat={text}, discord={content}). */
function payloadFor(target: NotifyTarget, message: string): Record<string, string> {
  return target === "discord" ? { content: message } : { text: message };
}

export function makeNotifyExecutor(deps: NotifyDeps = {}): ToolExecutorPort {
  return {
    specs: () => TOOLS,
    async execute(call: ToolCall, opts: { signal?: AbortSignal }): Promise<{ output: string; isError?: boolean }> {
      let signal: AbortSignal | undefined;
      let aborted = false;
      const abortGuard = () => { if (isAborted(signal)) { aborted = true; throw new Error("aborted"); } };
      try {
        signal = opts?.signal;
        abortGuard();
        if (!deps.post || !deps.webhookUrl) return err("notify unavailable (post/webhook 미주입 — external)");
        if (!isObj(call.args)) return err("args must be object");
        const a = call.args;
        const target = a.target;
        if (typeof target !== "string" || !(TARGETS as readonly string[]).includes(target)) return err(`target invalid (allowed: ${TARGETS.join("/")})`);
        const message = a.message;
        if (typeof message !== "string" || !message.trim()) return err("message required");

        const url = await deps.webhookUrl(target as NotifyTarget);
        abortGuard();
        if (!url) return err(`${target} webhook 미설정(config/secret 필요)`); // 정직 — empty POST 안 함
        const r = await deps.post(url, payloadFor(target as NotifyTarget, message), signal);
        abortGuard();
        return r.ok ? ok(`${target} 알림 전송됨`) : err(`${target} webhook ${r.status}`);
      } catch (e) {
        if (aborted || isAborted(signal)) throw new Error("aborted");
        return err(`notify 실패: ${safeMsg(e)}`);
      }
    },
  };
}
