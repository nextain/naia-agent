// adapters/stdio — AgentIngressPort/AgentEgressPort 의 줄단위 stdio 구현 (계약 §B.4).
// os child-stdio 의 짝: stdin 줄→decodeRequest→AgentRequest / AgentEmit→encodeEmit→stdout 줄.
// ⚠️ 순수: Node 의존 없음(LineIO 추상). 실 process stdin/stdout 결선은 entry(.mjs)가 LineIO 주입.
import type { AgentRequest, AgentEmit, ChannelContext } from "../domain/chat.js";
import type { AgentIngressPort, AgentEgressPort, Unsub } from "../ports/uc1.js";
import type { ProviderSessionStorePort, WireTrustResolverPort } from "../ports/uc1.js";
import { decodeRequest, encodeEmit } from "./protocol.js";
import { validateWireChatRequest } from "../domain/wire-v1.js";

export interface LineIO {
  writeLine(line: string): void;          // egress (stdout). no-throw 책임은 egress 래퍼
  /** 중요 frame의 실제 기록/flush acknowledgement. 일반 writeLine 성공을 ack로 간주하지 않는다. */
  writeLineAck?(line: string): Promise<boolean>;
  onLine(cb: (line: string) => void): Unsub; // ingress (stdin)
}

interface RequestAdmissionRegistry {
  tryAdmit(requestId: string): boolean;
  release(requestId: string): void;
}

const ADMISSIONS = new WeakMap<LineIO, RequestAdmissionRegistry>();
function admissionFor(io: LineIO): RequestAdmissionRegistry {
  const existing = ADMISSIONS.get(io);
  if (existing) return existing;
  const active = new Set<string>();
  const registry: RequestAdmissionRegistry = {
    tryAdmit(requestId) {
      if (active.has(requestId)) return false;
      active.add(requestId);
      return true;
    },
    release(requestId) { active.delete(requestId); },
  };
  ADMISSIONS.set(io, registry);
  return registry;
}

export interface StdioIngressOptions {
  /** raw line을 받지 않는다. 비밀·ref 반향 방지를 위한 고정 redacted 관찰 seam. */
  readonly onMalformed?: (event: { readonly reason: "malformed-or-unsupported" }) => void;
  readonly trustResolver?: WireTrustResolverPort;
  readonly providerSessionStore?: ProviderSessionStorePort;
}

/** 단일 구독 ingress: stdin 줄 → decodeRequest → cb. 미지(null)=redacted 관찰 후 드롭. */
export function makeStdioIngress(io: LineIO, options: StdioIngressOptions = {}): AgentIngressPort {
  const admission = admissionFor(io);
  return {
    onRequest(cb: (req: AgentRequest) => void): Unsub {
      return io.onLine((line) => {
        const req = decodeRequest(line);
        if (req === null) { options.onMalformed?.({ reason: "malformed-or-unsupported" }); return; }
        if (req.kind === "chat") {
          // gRPC와 동형: validation보다 먼저 active correlation을 선점한다. 활성 중복은 기존 stream을
          // terminal error로 오염시키지 않고 드롭한다.
          if (!admission.tryAdmit(req.requestId)) return;
          let baseContext;
          try { baseContext = options.trustResolver?.resolve(req) ?? {}; }
          catch {
            admission.release(req.requestId);
            if (req.requestId.length > 0 && req.requestId.length <= 128 && !/[\u0000-\u001f\u007f]/.test(req.requestId)) {
              try { io.writeLine(JSON.stringify({ type: "error", requestId: req.requestId, message: "Request could not be processed.", code: "WIRE_SCOPE_FORBIDDEN" })); } catch { /* no-throw */ }
            } else options.onMalformed?.({ reason: "malformed-or-unsupported" });
            return;
          }
          const checked = validateWireChatRequest(req, {
            ...baseContext,
            ...(req.providerSession?.mode === "resume" ? {
              providerSessionLookup: options.providerSessionStore?.lookup(req.providerSession.providerSessionRef),
            } : {}),
          });
          if (!checked.ok) {
            admission.release(req.requestId);
            if (checked.requestId) {
              try { io.writeLine(JSON.stringify({ type: "error", requestId: checked.requestId, message: "Request could not be processed.", code: checked.error.code })); } catch { /* no-throw */ }
            } else options.onMalformed?.({ reason: "malformed-or-unsupported" });
            return;
          }
        }
        try { cb(req); }
        catch (error) {
          if (req.kind === "chat") admission.release(req.requestId);
          throw error;
        }
      });
    },
  };
}

/** egress: AgentEmit → encodeEmit → wire JSON-line. ⚠️ no-throw(wire 실패=로그, throw 금지). */
export function makeStdioEgress(
  io: LineIO,
  onWriteError?: (err: unknown) => void,
  options: { readonly channelForRequest?: (requestId: string) => ChannelContext | undefined } = {},
): AgentEgressPort {
  const admission = admissionFor(io);
  const MAX_TERMINAL_LATCHES = 1024;
  const terminal = new Set<string>();
  const latchTerminal = (requestId: string): void => {
    if (terminal.has(requestId)) return;
    terminal.add(requestId);
    if (terminal.size > MAX_TERMINAL_LATCHES) {
      const oldest = terminal.values().next().value as string | undefined;
      if (oldest !== undefined) terminal.delete(oldest);
    }
  };
  return {
    beginRequest(requestId: string): void {
      terminal.delete(requestId);
    },
    emit(requestId: string, e: AgentEmit): void {
      if (terminal.has(requestId)) return;
      try {
        const encoded = encodeEmit(requestId, e, options.channelForRequest?.(requestId));
        io.writeLine(JSON.stringify(encoded));
        if (encoded.type === "error" || encoded.type === "finish") {
          latchTerminal(requestId);
          admission.release(requestId);
        }
      } catch (err) {
        try { onWriteError?.(err); } catch { /* observer 격리 */ }
      }
    },
    async emitCritical(requestId, e): Promise<boolean> {
      if (terminal.has(requestId) || !io.writeLineAck) return false;
      try {
        const encoded = encodeEmit(requestId, e, options.channelForRequest?.(requestId));
        if (encoded.type !== "processing_disclosure") return false;
        return await io.writeLineAck(JSON.stringify(encoded)) === true;
      } catch (err) {
        try { onWriteError?.(err); } catch { /* observer 격리 */ }
        return false;
      }
    },
    endRequest(requestId: string): void {
      terminal.delete(requestId);
      admission.release(requestId);
    },
  };
}
