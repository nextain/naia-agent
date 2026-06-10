// adapters/openai-compat-provider — 실 ProviderPort (이식: old providers/zai.ts·openai.ts).
// OpenAI-호환 /chat/completions SSE 스트림(GLM coding plan·openai·vllm 공용). openai SDK 대신 raw fetch(deps 최소).
// UC1 per-chunk 스트리밍(delta.content) + UC5 slice 1b tool_calls(계약 §C: tools 전송 + delta.tool_calls 재조립).
// apiKey/baseUrl=주입(키는 wire 아님, env/CredentialPort). 실 검증=클라우드(GPU 불요).
import type { ProviderPort, ProviderChatOpts } from "../ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../domain/chat.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; statusText: string;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> | void } } | null;
}>;

/** ChatMessage[] → OpenAI wire messages (§C.1). assistant.toolCalls·tool role 매핑, content null 규약. */
function toWireMessages(systemPrompt: string | undefined, messages: readonly ChatMessage[]): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = [];
  if (systemPrompt) wire.push({ role: "system", content: systemPrompt });
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      wire.push({
        role: "assistant",
        content: m.content === "" ? null : m.content, // content "" + toolCalls → null (OpenAI 규약)
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      });
    } else if (m.role === "tool") {
      if (!m.toolCallId) throw new Error("tool message missing toolCallId"); // §C.1 — skip 금지(대응 깨짐)
      wire.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else {
      wire.push({ role: m.role, content: m.content });
    }
  }
  return wire;
}

interface ToolAcc { id?: string; name?: string; args: string; excluded: boolean; conflict: boolean; }

/**
 * baseUrl 예: https://api.z.ai/api/coding/paas/v4 (GLM coding plan). apiKey=Bearer.
 * model(옵션): config.model 이 백엔드 카탈로그에 없을 때 강제. 미지정 시 config.model.
 */
export function makeOpenAICompatProvider(deps: { baseUrl: string; apiKey: string; model?: string; fetch?: FetchLike }): ProviderPort {
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async *chat(config: ProviderConfig, messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      const wireMsgs = toWireMessages(opts.systemPrompt, messages); // tool 메시지 toolCallId 누락 시 throw(§C.1)
      const toolsBody = opts.tools && opts.tools.length > 0
        ? opts.tools.map((s) => ({ type: "function", function: { name: s.name, description: s.description, parameters: s.parameters } }))
        : undefined;

      const resp = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.apiKey}` },
        body: JSON.stringify({ model: deps.model ?? config.model, messages: wireMsgs, stream: true, stream_options: { include_usage: true }, ...(toolsBody ? { tools: toolsBody } : {}) }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`OpenAI-compat ${base} failed: ${resp.status} ${resp.statusText}`); // rejection→handler catch=error
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let inTok = 0, outTok = 0;
      const acc = new Map<number, ToolAcc>(); // index 별 tool_call 누적(§C.2)

      // SSE data json 1건 처리: content → 즉시 text chunk 반환. tool_calls/usage → 누적(side effect). error → throw.
      const parseData = (payload: string): ProviderChunk[] => {
        const t = payload.trim();
        if (!t || t === "[DONE]") return [];
        let evt: unknown;
        try { evt = JSON.parse(t); } catch { return []; } // 손상 SSE 줄 skip
        if (!evt || typeof evt !== "object") return [];
        const o = evt as {
          choices?: { delta?: { content?: string; tool_calls?: Array<{ index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }> } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: unknown;
        };
        if (o.error) throw new Error(`OpenAI-compat stream error: ${JSON.stringify(o.error)}`);
        const out: ProviderChunk[] = [];
        const delta = o.choices?.[0]?.delta;
        if (delta?.content) out.push({ kind: "text", text: delta.content });
        const tcs = delta?.tool_calls;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const idx = tc.index;
            if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0) throw new Error("invalid tool_call index"); // §C.2 누적 전 검증
            let a = acc.get(idx);
            if (!a) { a = { args: "", excluded: false, conflict: false }; acc.set(idx, a); }
            if (tc.type !== undefined && tc.type !== "function") a.excluded = true; // present 이면서 "function" 아님(null/number/타 문자열 포함) = 미지원

            if (a.excluded) continue; // excluded index = 이후 모든 필드 무시
            if (typeof tc.id === "string" && tc.id !== "") {
              if (a.id !== undefined && a.id !== tc.id) a.conflict = true; else a.id = tc.id; // 다른 nonempty id → conflict marker(finalize 평가)
            }
            const fn = tc.function;
            if (fn) {
              if (typeof fn.name === "string" && fn.name !== "") {
                if (a.name !== undefined && a.name !== fn.name) a.conflict = true; else a.name = fn.name;
              }
              if (typeof fn.arguments === "string") a.args += fn.arguments; // 조각 이어붙임
            }
          }
        }
        if (o.usage) { inTok = o.usage.prompt_tokens ?? inTok; outTok = o.usage.completion_tokens ?? outTok; } // 호출 누계 스냅샷
        return out;
      };

      // 단일 finalize(§C.2): abort commit-point → parse-all-then-yield 원자 → toolUse → usage → finish.
      const finalize = function* (): Generator<ProviderChunk> {
        if (opts.signal?.aborted) return; // commit point: abort 면 배치 전체 미yield
        const indices = [...acc.keys()].filter((i) => !acc.get(i)!.excluded).sort((x, y) => x - y);
        // 1차: provider 제공 id 중복 거부 + used 집합 구성(합성 id 충돌 회피용).
        const used = new Set<string>();
        for (const i of indices) {
          const a = acc.get(i)!;
          if (a.id !== undefined && a.id !== "") {
            if (used.has(a.id)) throw new Error("duplicate tool_call id"); // §C.2
            used.add(a.id);
          }
        }
        // 2차: 전부 검증해 완성 배열(이 단계 throw = yield 0건). 통과 후에만 일괄 yield.
        const built: { id: string; name: string; args: unknown }[] = [];
        for (const i of indices) {
          const a = acc.get(i)!;
          if (a.conflict) throw new Error("conflicting tool_call id/name"); // §C.2
          if (a.name === undefined || a.name === "") throw new Error("tool_call missing name"); // 빈 name = 손상
          let args: unknown;
          if (a.args === "") args = {}; // 인자 없는 도구
          else {
            let p: unknown;
            try { p = JSON.parse(a.args); } catch { throw new Error("malformed tool_call arguments"); }
            if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("tool_call arguments not an object"); // plain object 강제
            args = p;
          }
          let id = a.id;
          if (id === undefined || id === "") { // 빈 id → 배치 내 유일 합성
            let cand = `call_${i}`; let n = 1;
            while (used.has(cand)) cand = `call_${i}_${n++}`;
            used.add(cand); id = cand;
          }
          built.push({ id, name: a.name, args });
        }
        for (const b of built) yield { kind: "toolUse", id: b.id, name: b.name, args: b.args };
        if (inTok > 0 || outTok > 0) yield { kind: "usage", inputTokens: inTok, outputTokens: outTok };
        yield { kind: "finish" };
      };

      try {
        let sawDone = false;
        outer: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
            const s = line.trim();
            if (!s.startsWith("data:")) continue;
            if (s.slice(5).trim() === "[DONE]") { sawDone = true; break outer; } // [DONE]=종료(read 영구대기 방지)
            for (const c of parseData(s.slice(5))) yield c; // content text 즉시 방출
          }
        }
        if (!sawDone) { // [DONE] 없이 EOF → trailing 처리
          buffer += decoder.decode();
          const last = buffer.trim();
          if (last.startsWith("data:") && last.slice(5).trim() !== "[DONE]") { for (const c of parseData(last.slice(5))) yield c; }
        }
        yield* finalize(); // 단일 finalize(toolUse→usage→finish, abort-gated)
      } finally {
        try { await reader.cancel?.(); } catch { /* 격리 */ }
      }
    },
  };
}
