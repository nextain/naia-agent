// adapters/ollama-provider — 실 ProviderPort (이식: old providers/ollama.ts, native /api/chat).
// ⚠️ UC1 = "스트리밍 응답"(scenario-authoritative) → old 의 buffer-then-emit 대신 **per-chunk 스트림**(content delta 마다 yield).
//    (old 가 버퍼한 건 한계였고 UC1 목표는 스트리밍.) tools/eos-strip/recovery = UC5/폴리시 후속.
// fetch 주입형(헤드리스 mock 테스트 — 실 ollama 없이). 실 검증 = ollama 기동 후(루크 환경/GPU).
import type { ProviderPort, ProviderChatOpts } from "../ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../domain/chat.js";

const DEFAULT_NUM_CTX = 8192;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; statusText: string;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}>;

interface OllamaChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** old toOllamaMessages 의 UC1 부분(system 합류 + role/content). tool 메시지=UC5. */
function toOllamaMessages(messages: readonly ChatMessage[], systemPrompt?: string): { role: string; content: string }[] {
  const out: { role: string; content: string }[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of messages) out.push({ role: m.role, content: m.content });
  return out;
}

export function makeOllamaProvider(deps?: { fetch?: FetchLike }): ProviderPort {
  const doFetch: FetchLike = deps?.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return {
    async *chat(config: ProviderConfig, messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      const baseUrl = (config.ollamaHost || "http://localhost:11434").replace(/\/+$/, "");
      const body: Record<string, unknown> = {
        model: config.model,
        messages: toOllamaMessages(messages, opts.systemPrompt),
        stream: true,
        options: { temperature: 0.7, num_ctx: config.ollamaNumCtx ?? DEFAULT_NUM_CTX },
      };
      if (config.enableThinking !== undefined) body.think = config.enableThinking; // 명시 시만(미지원 모델 에러 방지)

      const resp = await doFetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!resp.ok || !resp.body) {
        throw new Error(`Ollama /api/chat failed: ${resp.status} ${resp.statusText}`); // rejection → handler catch=error
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let inputTokens = 0, outputTokens = 0;

      // NDJSON content delta → ProviderChunk 스트림(per-chunk).
      const parseLine = (line: string): ProviderChunk[] => {
        const t = line.trim();
        if (!t) return [];
        let evt: OllamaChunk;
        try { evt = JSON.parse(t) as OllamaChunk; } catch { return []; } // 손상 NDJSON 줄 skip
        const chunks: ProviderChunk[] = [];
        if (evt.message?.thinking) chunks.push({ kind: "thinking", text: evt.message.thinking });
        if (evt.message?.content) chunks.push({ kind: "text", text: evt.message.content });
        if (evt.done) {
          inputTokens = evt.prompt_eval_count ?? 0;
          outputTokens = evt.eval_count ?? 0;
        }
        return chunks;
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          for (const c of parseLine(buffer.slice(0, nl))) yield c;
          buffer = buffer.slice(nl + 1);
        }
      }
      if (buffer) { for (const c of parseLine(buffer)) yield c; } // trailing line

      if (inputTokens > 0 || outputTokens > 0) yield { kind: "usage", inputTokens, outputTokens };
      yield { kind: "finish" };
    },
  };
}
