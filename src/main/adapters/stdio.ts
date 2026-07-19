// adapters/stdio — AgentIngressPort/AgentEgressPort 의 줄단위 stdio 구현 (계약 §B.4).
// os child-stdio 의 짝: stdin 줄→decodeRequest→AgentRequest / AgentEmit→encodeEmit→stdout 줄.
// ⚠️ 순수: Node 의존 없음(LineIO 추상). 실 process stdin/stdout 결선은 entry(.mjs)가 LineIO 주입.
import type { AgentRequest, AgentEmit } from "../domain/chat.js";
import type { AgentIngressPort, AgentEgressPort, Unsub } from "../ports/uc1.js";
import { decodeRequest, encodeEmit } from "./protocol.js";
import { validateSecurityWireRequest, type SecurityWireContext } from "../domain/security-wire.js";

export interface LineIO {
  writeLine(line: string): void;          // egress (stdout). no-throw 책임은 egress 래퍼
  onLine(cb: (line: string) => void): Unsub; // ingress (stdin)
}

/** 단일 구독 ingress: stdin 줄 → decodeRequest → cb. 미지(null)=무시+log(silent drop 금지). */
export function makeStdioIngress(
  io: LineIO,
  onMalformed?: (line: string) => void,
  resolveTrust?: (req: Extract<AgentRequest, { kind: "chat" }>) => SecurityWireContext,
): AgentIngressPort {
  return {
    onRequest(cb: (req: AgentRequest) => void): Unsub {
      return io.onLine((line) => {
        const req = decodeRequest(line);
        if (req === null) { onMalformed?.(line); return; } // 미지 type/파싱실패
        if (req.kind === "chat") {
          const checked = validateSecurityWireRequest(req, resolveTrust?.(req));
          if (!checked.ok) {
            if (checked.requestId) {
              try {
                io.writeLine(JSON.stringify({
                  type: "error",
                  requestId: checked.requestId,
                  message: "Request could not be processed.",
                  code: checked.error.code,
                }));
              } catch { /* no-throw */ }
            } else onMalformed?.("");
            return;
          }
        }
        cb(req);
      });
    },
  };
}

/** egress: AgentEmit → encodeEmit → wire JSON-line. ⚠️ no-throw(wire 실패=로그, throw 금지). */
export function makeStdioEgress(io: LineIO, onWriteError?: (err: unknown) => void): AgentEgressPort {
  return {
    emit(requestId: string, e: AgentEmit): void {
      try {
        io.writeLine(JSON.stringify(encodeEmit(requestId, e)));
      } catch (err) {
        try { onWriteError?.(err); } catch { /* observer 격리 */ }
      }
    },
  };
}
