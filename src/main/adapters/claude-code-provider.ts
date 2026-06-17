// adapters/claude-code-provider — 실 ProviderPort. **Claude Agent SDK**(@anthropic-ai/claude-agent-sdk `query()`).
// `claude-code-cli` provider 전용 — 사용자의 **로컬 Claude Code 구독 인증**을 그대로 사용(apiKey 미주입, x-api-key 없음).
//   → Anthropic Messages API(api.anthropic.com + ANTHROPIC_API_KEY)로 가지 않는다(그건 별 provider `anthropic`).
//   SDK 가 로컬 Claude Code CLI(2.x) 인증을 물려받아 호출 → per-token 과금 아님(구독 = 사용자에게 $0).
//
// ⚠️ 런타임 의존: 이 어댑터는 사용자 환경에 **Claude Code CLI 가 설치+로그인** 되어 있어야 실제로 동작한다
//   (SDK 가 CLI 프로세스를 스폰해 구독 인증을 사용). 설치/로그인은 사용자 env 책임 — 헤드리스 테스트는 query 를 mock.
//
// 헥사고날: query 주입형(deps.query, 미주입=SDK 의 실 query). 테스트가 SDK 프로세스 스폰 없이 mock.
// SDK 스트림(SDKMessage) → ProviderChunk 매핑. includePartialMessages=true 로 토큰 단위 stream_event 수신:
//   stream_event(=Anthropic 와이어 raw SSE 와 동형) 의 content_block_{start,delta,stop} 를 anthropic-provider 와
//   동일 패턴으로 접어 text/thinking/toolUse 방출. result(최종)에서 usage + 오류 판정.
import type { ProviderPort, ProviderChatOpts } from "../ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../domain/chat.js";

// SDK 의 query 시그니처(node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts 실측):
//   query(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query
//   Query extends AsyncGenerator<SDKMessage, void>
// ⚠️ SDK 의 message/event 깊은 타입(BetaMessage/BetaRawMessageStreamEvent)은 peer @anthropic-ai/sdk 버전에 묶여
//    있어 직접 import 하지 않고 **구조적 narrowing** 으로 소비(skipLibCheck 환경에서도 안전, 결합 최소).
export interface QueryParams {
  prompt: string;
  options?: {
    model?: string;
    systemPrompt?: string | string[] | { type: "preset"; preset: "claude_code"; append?: string };
    abortController?: AbortController;
    includePartialMessages?: boolean;
    [k: string]: unknown;
  };
}
/** SDK query 가 반환하는 스트림(SDKMessage 의 구조적 subset — 우리가 읽는 필드만). */
export type SdkQuery = AsyncIterable<SdkMessageLike>;
export type QueryFn = (params: QueryParams) => SdkQuery;

/** SDKMessage 중 우리가 읽는 variant 의 구조적 표현(discriminant=type). 그 외 type 은 무시. */
type SdkMessageLike =
  | { type: "stream_event"; event?: StreamEventLike }
  | { type: "assistant"; message?: { content?: unknown; usage?: UsageLike } }
  | { type: "result"; subtype?: string; is_error?: boolean; result?: string; usage?: UsageLike }
  | { type: string; [k: string]: unknown };

interface UsageLike { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; }
/** stream_event.event = Anthropic raw SSE message stream event(message_start / content_block_x / message_delta). */
interface StreamEventLike {
  type?: string;
  index?: number;
  message?: { usage?: UsageLike };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
  usage?: UsageLike;
}

interface ToolAcc { id: string; name: string; json: string; }

/**
 * ChatMessage[] (+ systemPrompt) → 단일 prompt 문자열로 폴드.
 * Agent SDK query 는 단발 prompt(string) 또는 SDKUserMessage 스트림을 받는다. 우리 도메인은 멀티턴 ChatMessage[]
 * 이므로 role 라벨을 붙여 1개 prompt 로 직렬화(system 은 options.systemPrompt 로 분리 전달 → 여기선 system role 만 흡수).
 * tool 라운드(assistant.toolCalls / tool result)도 텍스트로 평탄화(SDK 가 자체 도구루프를 도므로 와이어 tool_use 재주입 불요).
 */
function foldMessages(messages: readonly ChatMessage[]): { system: string; prompt: string } {
  let system = "";
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "system") { system += (system ? "\n\n" : "") + m.content; continue; }
    if (m.role === "tool") { if (m.content) lines.push(`Tool result: ${m.content}`); continue; }
    if (m.role === "assistant") {
      if (m.content) lines.push(`Assistant: ${m.content}`);
      if (m.toolCalls) for (const c of m.toolCalls) lines.push(`Assistant called tool ${c.name}(${JSON.stringify(c.args ?? {})})`);
      continue;
    }
    lines.push(`User: ${m.content}`); // user
  }
  return { system, prompt: lines.join("\n\n") };
}

/**
 * Claude Agent SDK 기반 ProviderPort. **apiKey 없음** — 로컬 Claude Code 구독 인증을 SDK 가 사용.
 * model 미지정 시 config.model. opts.signal → AbortController(SDK abortController 옵션). systemPrompt = opts + system role 합류.
 */
export function makeClaudeCodeProvider(deps: { model?: string; query?: QueryFn }): ProviderPort {
  const runQuery: QueryFn = deps.query ?? defaultQuery;
  return {
    async *chat(config: ProviderConfig, messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      const folded = foldMessages(messages);
      const systemText = [opts.systemPrompt, folded.system].filter(Boolean).join("\n\n");

      // opts.signal → SDK abortController(SDK 는 AbortController 객체를 받는다). 외부 signal abort 시 컨트롤러도 abort.
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (opts.signal) {
        if (opts.signal.aborted) ac.abort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      let inTok = 0, outTok = 0;
      const toolAcc = new Map<number, ToolAcc>(); // content_block index → 누적 tool_use

      // stream_event(=Anthropic raw SSE 와 동형) 1건 → ProviderChunk[] (anthropic-provider 매핑 패턴 재사용).
      const mapStreamEvent = (ev: StreamEventLike): ProviderChunk[] => {
        const out: ProviderChunk[] = [];
        switch (ev.type) {
          case "message_start": {
            const u = ev.message?.usage;
            if (u) inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            break;
          }
          case "content_block_start": {
            const idx = ev.index ?? 0;
            const cb = ev.content_block;
            if (cb?.type === "tool_use") toolAcc.set(idx, { id: cb.id ?? `call_${idx}`, name: cb.name ?? "", json: "" });
            break;
          }
          case "content_block_delta": {
            const idx = ev.index ?? 0;
            const d = ev.delta;
            if (d?.type === "text_delta" && d.text) out.push({ kind: "text", text: d.text });
            else if (d?.type === "thinking_delta" && d.thinking) out.push({ kind: "thinking", text: d.thinking });
            else if (d?.type === "input_json_delta") { const a = toolAcc.get(idx); if (a && typeof d.partial_json === "string") a.json += d.partial_json; }
            break;
          }
          case "content_block_stop": {
            const idx = ev.index ?? 0;
            const a = toolAcc.get(idx);
            if (a) {
              let args: unknown = {};
              if (a.json.trim()) { try { args = JSON.parse(a.json); } catch { args = {}; } } // 손상 인자 = {}
              out.push({ kind: "toolUse", id: a.id, name: a.name, args });
              toolAcc.delete(idx);
            }
            break;
          }
          case "message_delta": {
            const u = ev.usage;
            if (u?.output_tokens !== undefined) outTok = u.output_tokens; // 누계 스냅샷
            break;
          }
        }
        return out;
      };

      const stream = runQuery({
        prompt: folded.prompt,
        options: {
          model: deps.model ?? config.model,
          ...(systemText ? { systemPrompt: systemText } : {}),
          abortController: ac,
          includePartialMessages: true, // 토큰 단위 stream_event 수신(미설정 시 assistant 완성본만 — 비스트리밍).
        },
      });

      try {
        for await (const msg of stream) {
          if (opts.signal?.aborted) break;
          if (msg.type === "stream_event") {
            if (msg.event) { for (const c of mapStreamEvent(msg.event)) yield c; }
            continue;
          }
          if (msg.type === "result") {
            // result(최종) — is_error 면 rejection(chunk 아님, handler catch=error). usage 보정.
            const r = msg as { is_error?: boolean; result?: string; usage?: UsageLike };
            if (r.is_error) throw new Error(`Claude Code SDK error: ${r.result ?? "unknown"}`);
            const u = r.usage;
            if (u) {
              if (u.input_tokens !== undefined) inTok = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
              if (u.output_tokens !== undefined) outTok = u.output_tokens;
            }
            break;
          }
          // assistant/system/그 외 = 무시(스트리밍은 stream_event 가, 최종 usage 는 result 가 권위).
        }
        if (!opts.signal?.aborted) {
          if (inTok > 0 || outTok > 0) yield { kind: "usage", inputTokens: inTok, outputTokens: outTok };
          yield { kind: "finish" };
        }
      } finally {
        if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
        if (!ac.signal.aborted) ac.abort(); // 소비자 중도 종료 시 SDK 프로세스 정리
      }
    },
  };
}

/** 기본 query — 실 SDK(@anthropic-ai/claude-agent-sdk). 로컬 Claude Code 인증 사용(apiKey 없음).
 *  ⚠️ SDK 의 깊은 타입은 peer 버전 의존이라 구조적 cast 로 소비(우리 QueryParams/SdkMessageLike subset 으로 narrowing). */
const defaultQuery: QueryFn = (params) => {
  // 동적 import 회피(ESM top-level): 모듈 로드는 함수 호출 시점. 실패(미설치/CLI 부재)는 호출자 catch=error.
  // require-style 불가(ESM) → import() 를 then 으로 풀어 AsyncIterable 로 위임.
  return queryViaSdk(params);
};

/** 실 SDK query 위임(동적 import). SDK/CLI 부재 시 throw → ProviderPort 계약상 rejection(handler catch=error). */
async function* queryViaSdk(params: QueryParams): AsyncGenerator<SdkMessageLike, void> {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as { query: (p: unknown) => AsyncIterable<unknown> };
  const stream = mod.query(params) as AsyncIterable<SdkMessageLike>;
  for await (const m of stream) yield m;
}
