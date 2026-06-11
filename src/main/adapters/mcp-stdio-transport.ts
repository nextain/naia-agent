// adapters/mcp-stdio-transport — McpTransport 의 JSON-RPC 2.0 over 줄단위 채널 구현(MCP stdio).
// ⚠️ 코어 순수(Node 의존 없음 — LineChannel 추상). 실 subprocess spawn 은 entry(.mjs)가 LineChannel 주입.
// stdio MCP = JSON-RPC 메시지를 newline-구분 1줄씩 교환. request=id 상관, notify=id 없음.
import type { McpTransport } from "./mcp-skills.js";

export interface LineChannel {
  send(line: string): void;                       // 자식 stdin 으로 1줄(개행 자동) 전송
  onLine(cb: (line: string) => void): () => void; // 자식 stdout 줄 수신(unsub 반환)
  close?(): void;
}

const DEFAULT_BYTE_LIMIT = 1024 * 1024; // 응답 1줄 최대(디코드 전 강제 — 메모리 폭발 차단)

interface Pending { resolve: (v: unknown) => void; reject: (e: unknown) => void; cleanup: () => void; }

/**
 * McpTransport(request/notify) over LineChannel. id 상관·JSON-RPC error 매핑·abort·바이트한도.
 * dispose()=구독 해제 + 미결 요청 reject + 채널 close. (T2: 실 subprocess 결선은 entry.)
 */
export function makeMcpJsonRpcClient(channel: LineChannel, opts: { byteLimit?: number } = {}): McpTransport & { dispose: () => void } {
  const byteLimit = opts.byteLimit && opts.byteLimit > 0 ? opts.byteLimit : DEFAULT_BYTE_LIMIT;
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;

  const rejectAll = (msg: string) => {
    for (const [, p] of pending) { try { p.cleanup(); } catch { /* noop */ } try { p.reject(new Error(msg)); } catch { /* noop */ } } // cleanup=abort 리스너 제거(누수 방지)
    pending.clear();
  };

  const unsub = channel.onLine((line) => {
    if (disposed) return;
    if (typeof line !== "string" || line.length === 0) return;
    if (line.length > byteLimit) { rejectAll("mcp: response exceeds byte limit"); return; } // 디코드 전 한도(상관 불가→전체 reject 방어)
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { return; } // 파싱 실패 = 무시(부분/비-JSON 줄)
    if (msg === null || typeof msg !== "object") return;
    const m = msg as { id?: unknown; result?: unknown; error?: unknown };
    if (typeof m.id !== "number") return; // 알림(서버→클라, id 없음) 또는 비대상 = 무시
    const p = pending.get(m.id);
    if (!p) return; // 미지/중복 id = 무시
    pending.delete(m.id);
    p.cleanup();
    if (m.error !== undefined && m.error !== null) {
      const em = (m.error as { message?: unknown }).message;
      p.reject(new Error(typeof em === "string" ? em : "mcp: JSON-RPC error"));
    } else {
      p.resolve(m.result);
    }
  });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try { unsub(); } catch { /* noop */ }
    rejectAll("mcp: transport disposed");
    try { channel.close?.(); } catch { /* noop */ }
  };

  return {
    dispose,
    request(method: string, params: unknown, o: { signal?: AbortSignal }): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        if (disposed) { reject(new Error("mcp: transport disposed")); return; }
        const sig = o?.signal;
        if (sig?.aborted) { reject(new Error("aborted")); return; } // 전송 전 abort
        const id = nextId++;
        let onAbort: (() => void) | undefined;
        const cleanup = () => { if (onAbort && sig) { try { sig.removeEventListener("abort", onAbort); } catch { /* noop */ } } };
        if (sig) {
          onAbort = () => { if (pending.delete(id)) { cleanup(); reject(new Error("aborted")); } };
          try { sig.addEventListener("abort", onAbort, { once: true }); } catch { /* noop */ }
        }
        pending.set(id, { resolve, reject, cleanup });
        try {
          channel.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        } catch (e) {
          if (pending.delete(id)) { cleanup(); reject(e instanceof Error ? e : new Error("mcp: send failed")); }
        }
      });
    },
    notify(method: string, params: unknown, o?: { signal?: AbortSignal }): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (disposed) { reject(new Error("mcp: transport disposed")); return; }
        if (o?.signal?.aborted) { reject(new Error("aborted")); return; }
        try {
          const body: Record<string, unknown> = { jsonrpc: "2.0", method };
          if (params !== undefined) body.params = params; // 무파라미터 알림은 params 생략
          channel.send(JSON.stringify(body));
          resolve(); // 전송 완료(동기 write) — 순서 보장
        } catch (e) {
          reject(e instanceof Error ? e : new Error("mcp: notify failed"));
        }
      });
    },
  };
}
