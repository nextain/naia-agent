// adapters/anthropic-provider — 실 ProviderPort. Anthropic Messages API(/v1/messages) SSE 스트림.
// `anthropic`(직접 키, per-token) **전용**. ⚠️ claude-code-cli 는 더 이상 이 어댑터를 쓰지 않는다 —
//   claude-code 라우트(adapters/claude-code-provider, Claude Agent SDK 구독 인증)로 격리(2026-06-18, FR-PROV-5).
//   여긴 ANTHROPIC_API_KEY 직접 호출만(구독 아님). 라우팅 격리는 domain/provider-route.ts 가 SoT.
// ⚠️ 에이전트 컨벤션 충실: @anthropic-ai/sdk 대신 **raw fetch(주입형)** — deps 최소 + 헤드리스 계약테스트(URL/헤더/스트림 mock).
//    raw fetch 가 곧 SDK 와이어(SDK 는 이 위의 얇은 래퍼)이고, 기존 openai-compat/ollama 어댑터가 동일 패턴이다.
// Messages API ≠ OpenAI-compat: 별 엔드포인트(/v1/messages), x-api-key + anthropic-version 헤더, content block 구조,
//   SSE = message_start / content_block_{start,delta,stop} / message_delta / message_stop / error.
import type { ProviderPort, ProviderChatOpts } from "../ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../domain/chat.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; statusText: string;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> | void } } | null;
}>;

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 16000; // per-response 상한(스트림이라 timeout 무관). 전 모델(haiku/sonnet 64K, opus 128K) cap 미만이라 400 안 남.

/**
 * ChatMessage[] → Anthropic Messages 와이어. system 은 top-level(별도 반환), 나머지는 content block.
 * - system role 메시지 → top-level system 으로 흡수(Anthropic messages 엔 system role 없음).
 * - assistant.toolCalls → tool_use block, tool role → tool_result block(연속 tool 은 한 user 메시지로 병합 — Anthropic 규약).
 */
function buildAnthropicMessages(messages: readonly ChatMessage[]): { system: string; wire: Array<Record<string, unknown>> } {
  let system = "";
  const wire: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system") { system += (system ? "\n\n" : "") + m.content; continue; }
    if (m.role === "tool") {
      // tool_result 는 user 메시지 안에. 직전이 tool_result 묶음 user 면 거기 append(한 turn 결과 묶음).
      const block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
      const last = wire[wire.length - 1] as { role?: string; content?: unknown } | undefined;
      const lastBlocks = last && last.role === "user" && Array.isArray(last.content) ? (last.content as Array<{ type?: string }>) : null;
      if (lastBlocks && lastBlocks.length > 0 && lastBlocks.every((b) => b.type === "tool_result")) {
        (last!.content as unknown[]).push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (m.content) content.push({ type: "text", text: m.content });
      if (m.toolCalls) for (const c of m.toolCalls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      // 빈 text block(text:"")은 Anthropic 이 400("text content blocks must be non-empty") → content·toolCalls 둘 다 없으면 공백 1자(턴 구조 보존).
      wire.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: " " }] });
      continue;
    }
    wire.push({ role: "user", content: [{ type: "text", text: m.content }] }); // user
  }
  return { system, wire };
}

interface ToolAcc { id: string; name: string; json: string; }

/**
 * baseUrl 기본 = https://api.anthropic.com (config host override 가능). apiKey = x-api-key.
 * model 미지정 시 config.model. enableThinking → adaptive thinking(4.6+ 레지스트리 모델 가정).
 */
export function makeAnthropicProvider(deps: { baseUrl: string; apiKey: string; model?: string; fetch?: FetchLike }): ProviderPort {
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async *chat(config: ProviderConfig, messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      const built = buildAnthropicMessages(messages);
      const systemText = [opts.systemPrompt, built.system].filter(Boolean).join("\n\n");
      const tools = opts.tools && opts.tools.length > 0
        ? opts.tools.map((s) => ({ name: s.name, description: s.description, input_schema: s.parameters ?? { type: "object", properties: {} } }))
        : undefined;

      const body: Record<string, unknown> = {
        model: deps.model ?? config.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        // prompt caching: 안정 prefix(system + tools)에 cache_control 1개 — 반복 턴서 prefix 재처리 회피(GA, beta 헤더 불요).
        ...(systemText ? { system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }] } : {}),
        messages: built.wire,
        ...(tools ? { tools } : {}),
        // 4.6+ = adaptive thinking(budget_tokens 폐기). enableThinking 일 때만 — 미지원 모델 400 회피 위해 opt-in.
        ...(config.enableThinking ? { thinking: { type: "adaptive" } } : {}),
        stream: true,
      };

      const resp = await doFetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": deps.apiKey, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify(body),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`Anthropic ${base} failed: ${resp.status} ${resp.statusText}`); // rejection→handler catch=error
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let inTok = 0, outTok = 0;
      const toolAcc = new Map<number, ToolAcc>(); // content_block index → 누적 tool_use

      // SSE data json 1건 처리: type 별 분기. Anthropic 은 event: 줄도 보내나 data: 의 JSON.type 으로 충분(event 무시).
      const parseData = (payload: string): ProviderChunk[] => {
        const t = payload.trim();
        if (!t) return [];
        let evt: { type?: string; [k: string]: unknown };
        try { evt = JSON.parse(t); } catch { return []; }
        const out: ProviderChunk[] = [];
        switch (evt.type) {
          case "message_start": {
            const u = (evt.message as { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } } | undefined)?.usage;
            if (u) inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            break;
          }
          case "content_block_start": {
            const idx = evt.index as number;
            const cb = evt.content_block as { type?: string; id?: string; name?: string } | undefined;
            if (cb?.type === "tool_use") toolAcc.set(idx, { id: cb.id ?? `call_${idx}`, name: cb.name ?? "", json: "" });
            break;
          }
          case "content_block_delta": {
            const idx = evt.index as number;
            const d = evt.delta as { type?: string; text?: string; partial_json?: string; thinking?: string } | undefined;
            if (d?.type === "text_delta" && d.text) out.push({ kind: "text", text: d.text });
            else if (d?.type === "thinking_delta" && d.thinking) out.push({ kind: "thinking", text: d.thinking });
            else if (d?.type === "input_json_delta") { const a = toolAcc.get(idx); if (a && typeof d.partial_json === "string") a.json += d.partial_json; }
            break;
          }
          case "content_block_stop": {
            const idx = evt.index as number;
            const a = toolAcc.get(idx);
            if (a) {
              let args: unknown = {};
              if (a.json.trim()) { try { args = JSON.parse(a.json); } catch { args = {}; } } // 손상 인자 = {}(턴 진행)
              out.push({ kind: "toolUse", id: a.id, name: a.name, args });
              toolAcc.delete(idx);
            }
            break;
          }
          case "message_delta": {
            const u = evt.usage as { output_tokens?: number } | undefined;
            if (u?.output_tokens !== undefined) outTok = u.output_tokens; // 누계 스냅샷(마지막 채택)
            break;
          }
          case "error":
            throw new Error(`Anthropic stream error: ${JSON.stringify(evt.error ?? evt)}`);
          // message_stop / ping / content_block(text 시작) = 무시(finalize 는 루프 종료 후)
        }
        return out;
      };

      try {
        outer: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
            const s = line.trim();
            if (!s.startsWith("data:")) continue; // event:/빈 줄 skip
            for (const c of parseData(s.slice(5))) yield c; // text/thinking 즉시 방출, toolUse=block_stop 시
            if (opts.signal?.aborted) break outer;
          }
        }
        if (!opts.signal?.aborted) {
          // EOF flush(openai-compat/ollama 패리티): newline 없이 끝난 마지막 data: 줄 + 멀티바이트 잔여 디코드.
          buffer += decoder.decode();
          const last = buffer.trim();
          if (last.startsWith("data:")) { for (const c of parseData(last.slice(5))) yield c; }
          if (inTok > 0 || outTok > 0) yield { kind: "usage", inputTokens: inTok, outputTokens: outTok };
          yield { kind: "finish" };
        }
      } finally {
        try { await reader.cancel?.(); } catch { /* 격리 */ }
      }
    },
  };
}
