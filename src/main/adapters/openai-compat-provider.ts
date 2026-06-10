// adapters/openai-compat-provider — 실 ProviderPort (이식: old providers/zai.ts·openai.ts).
// OpenAI-호환 /chat/completions SSE 스트림(GLM coding plan·openai·vllm 공용). openai SDK 대신 raw fetch(deps 최소).
// UC1 per-chunk 스트리밍(delta.content). apiKey/baseUrl=주입(키는 wire 아님, env/CredentialPort). 실 검증=클라우드(GPU 불요).
import type { ProviderPort, ProviderChatOpts } from "../ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../domain/chat.js";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; statusText: string;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> | void } } | null;
}>;

/**
 * baseUrl 예: https://api.z.ai/api/coding/paas/v4 (GLM coding plan). apiKey=Bearer.
 * model(옵션): 셸이 보낸 config.model 이 이 백엔드 카탈로그에 없을 때(예: UI=naia-local
 *   → GLM 거부) 강제할 모델 id. 미지정 시 config.model 그대로(계약 기본 동작 불변).
 */
export function makeOpenAICompatProvider(deps: { baseUrl: string; apiKey: string; model?: string; fetch?: FetchLike }): ProviderPort {
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = deps.baseUrl.replace(/\/+$/, "");
  return {
    async *chat(config: ProviderConfig, messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      const msgs: { role: string; content: string }[] = [];
      if (opts.systemPrompt) msgs.push({ role: "system", content: opts.systemPrompt });
      for (const m of messages) msgs.push({ role: m.role, content: m.content });

      const resp = await doFetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.apiKey}` },
        body: JSON.stringify({ model: deps.model ?? config.model, messages: msgs, stream: true, stream_options: { include_usage: true } }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`OpenAI-compat ${base} failed: ${resp.status} ${resp.statusText}`); // rejection→handler catch=error
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let inTok = 0, outTok = 0;

      // SSE: "data: {json}\n\n" ... "data: [DONE]". delta.content → text chunk. usage(final)·finish.
      const parseData = (payload: string): ProviderChunk[] => {
        const t = payload.trim();
        if (!t || t === "[DONE]") return [];
        let evt: unknown;
        try { evt = JSON.parse(t); } catch { return []; } // 손상 SSE skip
        if (!evt || typeof evt !== "object") return [];
        const o = evt as { choices?: { delta?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: unknown };
        if (o.error) throw new Error(`OpenAI-compat stream error: ${JSON.stringify(o.error)}`);
        const out: ProviderChunk[] = [];
        const content = o.choices?.[0]?.delta?.content;
        if (content) out.push({ kind: "text", text: content });
        if (o.usage) { inTok = o.usage.prompt_tokens ?? inTok; outTok = o.usage.completion_tokens ?? outTok; }
        return out;
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
            if (s.slice(5).trim() === "[DONE]") { sawDone = true; break outer; } // ⚠️ [DONE]=종료(서버 연결 유지해도 read 영구대기 방지, R1)
            for (const c of parseData(s.slice(5))) yield c;
          }
        }
        if (!sawDone) { // 스트림이 [DONE] 없이 끝남(EOF) → trailing 처리
          buffer += decoder.decode();
          const last = buffer.trim();
          if (last.startsWith("data:") && last.slice(5).trim() !== "[DONE]") { for (const c of parseData(last.slice(5))) yield c; }
        }
        if (inTok > 0 || outTok > 0) yield { kind: "usage", inputTokens: inTok, outputTokens: outTok };
        yield { kind: "finish" };
      } finally {
        try { await reader.cancel?.(); } catch { /* 격리 */ }
      }
    },
  };
}
