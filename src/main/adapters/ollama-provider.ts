// adapters/ollama-provider — 실 ProviderPort (이식: old providers/ollama.ts, native /api/chat).
// ⚠️ UC1 = "스트리밍 응답"(scenario-authoritative) → old 의 buffer-then-emit 대신 **per-chunk 스트림**(content delta 마다 yield).
//    (old 가 버퍼한 건 한계였고 UC1 목표는 스트리밍.) eos-strip/recovery = 폴리시 후속.
// UC5 §H(slice 1c, FR-PROV-6): 실 tool_calls — tools 전송 + message.tool_calls 파싱 + tool-bearing 메시지 매핑.
//    ollama 는 tool_calls 를 **완성체**(arguments=파싱된 object)로 주므로 OpenAI-compat 의 조각 재조립 불요(실측 0.32.0).
//    tools 미지원 모델(400 "does not support tools")은 tools 제거 1회 재시도(graceful degrade — 순수 챗 유지).
// fetch 주입형(헤드리스 mock 테스트 — 실 ollama 없이). 실 검증 = ollama 기동 후(루크 환경/GPU).
import type { ProviderPort, ProviderChatOpts } from "../ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../domain/chat.js";

const DEFAULT_NUM_CTX = 8192;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; statusText: string;
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> | void } } | null;
}>;

interface OllamaToolCallWire { id?: unknown; function?: { index?: unknown; name?: unknown; arguments?: unknown } }
interface OllamaChunk {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCallWire[] };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string; // Ollama 는 HTTP 200 스트림 안에서 {"error":...} 로 실패 보고 가능
}

/** ChatMessage[] → ollama native messages (§H.1). system 합류 + tool-bearing 메시지 매핑. */
function toOllamaMessages(messages: readonly ChatMessage[], systemPrompt?: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  const callNames = new Map<string, string>(); // toolCallId → tool name (§H.1 — ollama 템플릿은 tool_name 으로 결과 결속, 실측)
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      for (const c of m.toolCalls) callNames.set(c.id, c.name);
      out.push({
        role: "assistant",
        content: m.content,
        // ⚠️ arguments = **object 그대로**(OpenAI 의 JSON.stringify 와 다름 — ollama native 규약, 실측 왕복 확인).
        //    args 는 parse 단계서 plain object 보장(§C.1 동일 근거)이라 변환 없음.
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.args } })),
      });
    } else if (m.role === "tool") {
      if (!m.toolCallId) throw new Error("tool message missing toolCallId"); // §C.1 동일 — skip 금지(대응 깨짐)
      const toolName = callNames.get(m.toolCallId);
      out.push({
        role: "tool",
        content: m.content,
        tool_call_id: m.toolCallId,
        ...(toolName !== undefined ? { tool_name: toolName } : {}), // 맵 미스 = 생략(degrade — 정상 경로 threadToolRound 는 항상 히트)
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

const ERROR_BODY_READ_TIMEOUT_MS = 2000;

/** !ok 응답 본문을 진단용으로 소비(cap 4096) — dangling reader 방지 겸(§H.2). 실패 무시(best-effort).
 *  ⚠️ deadline(적대리뷰 2026-07-15): 프록시/원격이 헤더만 보내고 소켓을 열어두면 read 가 영구 대기 —
 *  구 코드는 본문을 안 읽었으므로(즉시 throw) 진단 읽기가 행 회귀가 되면 안 된다. 타임아웃 시 그때까지 읽은 것만. */
async function readErrorBody(body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(): Promise<void> | void } }): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let s = "";
  const deadline = new Promise<{ done: true; value?: undefined }>((res) => {
    const t = setTimeout(() => res({ done: true }), ERROR_BODY_READ_TIMEOUT_MS);
    (t as { unref?: () => void }).unref?.(); // node 전용 — 타이머가 프로세스/테스트를 붙잡지 않게
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (value) s += decoder.decode(value, { stream: true });
      if (s.length > 4096) break;
    }
    s += decoder.decode();
  } catch { /* 진단용 — 읽기 실패 무시 */ }
  try { await reader.cancel?.(); } catch { /* 격리 */ }
  return s.slice(0, 4096);
}

export function makeOllamaProvider(deps?: { fetch?: FetchLike }): ProviderPort {
  const doFetch: FetchLike = deps?.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return {
    async *chat(config: ProviderConfig, messages: readonly ChatMessage[], opts: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      const baseUrl = (config.ollamaHost || "http://localhost:11434").replace(/\/+$/, "");
      const wireMsgs = toOllamaMessages(messages, opts.systemPrompt); // tool 메시지 toolCallId 누락 시 throw(§H.1)
      const toolsBody = opts.tools && opts.tools.length > 0
        ? opts.tools.map((s) => ({ type: "function", function: { name: s.name, description: s.description, parameters: s.parameters } }))
        : undefined;

      // §H.2 H-I3: tools 미지원 모델(400 "does not support tools") → tools 제거 1회 재시도(순수 챗 유지).
      let includeTools = toolsBody !== undefined;
      for (;;) {
        const body: Record<string, unknown> = {
          model: config.model,
          messages: wireMsgs,
          stream: true,
          options: { temperature: 0.7, num_ctx: config.ollamaNumCtx ?? DEFAULT_NUM_CTX },
          ...(includeTools ? { tools: toolsBody } : {}),
        };
        if (config.enableThinking !== undefined) body.think = config.enableThinking; // 명시 시만(미지원 모델 에러 방지)

        const resp = await doFetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!resp.ok || !resp.body) {
          const errText = resp.body ? await readErrorBody(resp.body) : ""; // 소비/취소(dangling 방지) + 진단
          if (includeTools && /does not support tools/i.test(errText)) {
            includeTools = false; // H-I3 graceful degrade — 재시도 딱 1회(다음 루프는 includeTools=false 라 이 분기 불가)
            continue;
          }
          throw new Error(`Ollama /api/chat failed: ${resp.status} ${resp.statusText}${errText ? ` — ${errText.slice(0, 300)}` : ""}`); // rejection → handler catch=error
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let inputTokens = 0, outputTokens = 0;
        // §H.2 — tool_calls 는 완성체로 도착: 수신 즉시 검증해 pending 누적, yield 는 finalize 에서만(원자성 — 누적 중 throw = 부분 방출 0).
        const pending: { id?: string; name: string; args: unknown }[] = [];

        const accumulateToolCalls = (tcs: OllamaToolCallWire[]): void => {
          for (const tc of tcs) {
            if (!tc || typeof tc !== "object") throw new Error("malformed tool_call entry");
            const fn = tc.function;
            const name = fn?.name;
            if (typeof name !== "string" || name === "") throw new Error("tool_call missing name"); // §C.2 동일 — name 없는 call 은 완전 toolUse 아님
            const rawArgs = fn?.arguments;
            let args: unknown;
            if (rawArgs === undefined || rawArgs === null) args = {}; // 인자 없는 도구 = 정상
            else if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) args = rawArgs; // ollama = 파싱된 object(실측)
            else if (typeof rawArgs === "string") { // 변종 방어: 문자열 JSON — §C.2 동일(정확히 "" 만 {}, 공백-only 는 malformed)
              if (rawArgs === "") args = {};
              else {
                let p: unknown;
                try { p = JSON.parse(rawArgs); } catch { throw new Error("malformed tool_call arguments"); }
                if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error("tool_call arguments not an object");
                args = p;
              }
            } else throw new Error("tool_call arguments not an object"); // 숫자/불리언/배열 = 규약 위반
            const rawId = tc.id;
            pending.push({ ...(typeof rawId === "string" && rawId !== "" ? { id: rawId } : {}), name, args });
          }
        };

        // NDJSON content delta → ProviderChunk 스트림(per-chunk). tool_calls → 누적(side effect).
        const parseLine = (line: string): ProviderChunk[] => {
          const t = line.trim();
          if (!t) return [];
          let parsed: unknown;
          try { parsed = JSON.parse(t); } catch { return []; } // 손상 NDJSON 줄 skip
          if (!parsed || typeof parsed !== "object") return []; // "null"/숫자/bool = TypeError 방지(R5)
          const evt = parsed as OllamaChunk;
          if (evt.error) throw new Error(`Ollama stream error: ${evt.error}`); // ⚠️ HTTP 200 스트림 내 오류=실패(rejection→handler catch=error, 성공 오인 방지 R4)
          const chunks: ProviderChunk[] = [];
          if (evt.message?.thinking) chunks.push({ kind: "thinking", text: evt.message.thinking });
          if (evt.message?.content) chunks.push({ kind: "text", text: evt.message.content });
          if (Array.isArray(evt.message?.tool_calls)) accumulateToolCalls(evt.message.tool_calls); // §H.2 누적(검증 포함)
          if (evt.done) {
            inputTokens = evt.prompt_eval_count ?? 0;
            outputTokens = evt.eval_count ?? 0;
          }
          return chunks;
        };

        // §H.2 단일 finalize — abort commit point → toolUse(수신 순) → usage → finish (§C.2 동형 모델).
        const finalize = function* (): Generator<ProviderChunk> {
          if (opts.signal?.aborted) return; // commit point: abort 면 배치 전체 미yield
          const used = new Set<string>();
          for (const p of pending) {
            if (p.id !== undefined) {
              if (used.has(p.id)) throw new Error("duplicate tool_call id"); // §C.2 동일 — 결과 결속 모호
              used.add(p.id);
            }
          }
          for (let i = 0; i < pending.length; i++) {
            const p = pending[i]!;
            let id = p.id;
            if (id === undefined) { // 빈/누락 id → 배치 내 유일 합성(§C.2 동일)
              let cand = `call_${i}`; let n = 1;
              while (used.has(cand)) cand = `call_${i}_${n++}`;
              used.add(cand); id = cand;
            }
            yield { kind: "toolUse", id, name: p.name, args: p.args };
          }
          if (inputTokens > 0 || outputTokens > 0) yield { kind: "usage", inputTokens, outputTokens };
          yield { kind: "finish" };
        };

        try {
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
          buffer += decoder.decode(); // ⚠️ flush — 분할된 멀티바이트 UTF-8 마지막 문자 유실 방지(R3)
          if (buffer) { for (const c of parseLine(buffer)) yield c; } // trailing line
          yield* finalize();
        } finally {
          // ⚠️ 소비자 중도 종료(generator.return — handler abort/finish closeIt)·정상 종료 모두 reader 정리(HTTP/lock 누수 방지, R1)
          try { await reader.cancel?.(); } catch { /* 동기 throw·비동기 reject 모두 격리(R2) */ }
        }
        return; // 성공 attempt 1회로 종료(재시도 루프는 H-I3 degrade 경로 전용)
      }
    },
  };
}
