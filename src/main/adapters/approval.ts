// adapters/approval — in-memory ApprovalPort (계약 §D.2). tier-gated 도구 승인 보류 관리.
// register-before-emit · abort check→listen→recheck · 단일 settlement(delete-before-settle) · dispose settle · 구조적 nested 키.
import type { ApprovalPort } from "../ports/uc1.js";

interface Pending {
  settled: boolean;
  approve: (d: "approve" | "reject") => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

export function makeInMemoryApproval(): ApprovalPort {
  // 구조적 키: requestId → (toolCallId → Pending). 문자열 concat 충돌 방지(§D.2).
  const pend = new Map<string, Map<string, Pending>>();
  const inner = (rid: string): Map<string, Pending> => {
    let m = pend.get(rid);
    if (!m) { m = new Map(); pend.set(rid, m); }
    return m;
  };

  return {
    prepareDecision(requestId, toolCallId, opts) {
      let res!: (d: "approve" | "reject") => void;
      let rej!: (e: Error) => void;
      const promise = new Promise<"approve" | "reject">((resolve, reject) => { res = resolve; rej = reject; });
      const sig = opts.signal;
      let onAbort: (() => void) | undefined;

      const entry: Pending = {
        settled: false,
        approve: (d) => settleOnce(() => res(d)),
        reject: (e) => settleOnce(() => rej(e)),
        cleanup: () => {
          const m = pend.get(requestId);
          if (m) { m.delete(toolCallId); if (m.size === 0) pend.delete(requestId); }
          if (onAbort && sig) sig.removeEventListener("abort", onAbort);
        },
      };
      function settleOnce(fire: () => void): void {
        if (entry.settled) return;        // 단일 settlement
        entry.settled = true;
        entry.cleanup();                  // delete-before-settle(+listener 해제)
        fire();
      }

      // ⚠️ 중복 (requestId,toolCallId) 미해소 entry 가 있으면 먼저 settle(superseded)+제거 — 덮어쓰기 누수·old cleanup 이 새 entry 삭제하는 것 방지(handler 는 turn-unique cid 라 정상엔 없음, 방어).
      const prev = pend.get(requestId)?.get(toolCallId);
      if (prev && !prev.settled) prev.reject(new Error("superseded"));
      inner(requestId).set(toolCallId, entry); // ⚠️ 등록 먼저(emit 전 — fast resolve 유실 방지). inner() 가 prev cleanup 으로 비워진 맵 재생성.

      // abort 원자성: check → listen → recheck.
      if (sig) {
        if (sig.aborted) { entry.reject(new Error("aborted")); }
        else {
          onAbort = () => entry.reject(new Error("aborted"));
          sig.addEventListener("abort", onAbort, { once: true });
          if (sig.aborted) entry.reject(new Error("aborted")); // recheck(listen 직후 abort 윈도우)
        }
      }

      return { promise, dispose: () => entry.reject(new Error("disposed")) }; // 미해소면 reject(settle), idempotent
    },

    resolve(requestId, toolCallId, decision) {
      const entry = pend.get(requestId)?.get(toolCallId);
      if (!entry || entry.settled) return; // 미등록/이미 해소 = no-op
      entry.approve(decision);
    },
  };
}
