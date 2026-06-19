// adapters/conversation-log-store — ConversationLogPort 파일영속 구현(FR-CONV.1/5).
// `{conversationsDir}/{sessionId}.jsonl` 에 append(1줄 = 1메시지 JSONL). append-only(crash-safe, 버퍼링 없음 = close 불요).
// ⚠️ 코어 순수 — node:fs 직접 import 안 함. FsLike + join 주입(entry 가 node:fs/path, 테스트는 fake). file-memo-store 패턴.
// no-throw 격리(FR-CONV.1): 모든 실패 swallow — transcript 누락이 turn/finish/memory 를 안 깨뜨린다.
import type { ConversationLogPort, ConversationTurnRecord } from "../ports/conversation-log.js";

export interface ConversationLogFsLike {
  appendFileSync(path: string, data: string): void;
  mkdirSync(path: string, opts: { recursive: true }): void;
}

export interface ConversationLogDeps {
  /** transcript 디렉터리(= `{adkPath}/conversations`). entry 가 해석·주입. */
  readonly conversationsDir: string;
  readonly fs: ConversationLogFsLike;
  /** path.join 동등(크로스플랫폼 sep). entry 가 node:path.join 주입; 테스트는 fake. */
  readonly join: (dir: string, file: string) => string;
  /** 테스트 주입(미주입 = Date.now). */
  readonly now?: () => number;
}

/**
 * sessionId → 안전 파일명. 경로 traversal·인젝션 차단(영숫자/`_`/`-` 외 치환, 선행 `_`/`.` 제거, 길이 cap).
 * 빈/비정상 = "default"(FR-CONV.2: sessionId 누락 = 단일 fallback 세션, 크래시 금지).
 * ⚠️ 한계: 전부 비-ASCII(순수 한글 등) sessionId 는 "default" 합류 — 실 client localSessionId 는 ASCII(`chat-<ts>-<rand>`)라
 *    미발생. Rust safe_session_base(os lib.rs) 와 **동치 유지 필수**(agent write 파일명 = shell read 파일명). 비-ASCII 다중 client 시 hash 폴백(Phase2).
 */
export function sessionFileName(sessionId: string): string {
  const safe = String(sessionId ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^[_.]+/, "")
    .slice(0, 128);
  return `${safe || "default"}.jsonl`;
}

/** 한 메시지 → JSONL 한 줄. modality/audioRef 필드는 Phase1 미포함(text) — reader 가 optional 로 관용(FR-CONV.5 forward-compat). */
function messageLine(role: "user" | "assistant", content: string, timestamp: number): string {
  return `${JSON.stringify({ role, content, timestamp })}\n`;
}

export function makeFileConversationLog(d: ConversationLogDeps): ConversationLogPort {
  const now = d.now ?? (() => Date.now());
  return {
    async append(turn: ConversationTurnRecord): Promise<void> {
      try {
        // recursive mkdir = 기존이면 no-op(매 턴 호출해도 싸다). dir 이 중간에 지워져도 복원(dirReady 캐시 대신 견고성 우선).
        d.fs.mkdirSync(d.conversationsDir, { recursive: true });
        const ts = now();
        const file = d.join(d.conversationsDir, sessionFileName(turn.sessionId));
        // user → assistant 순(naia-memory.encode 와 동일 provenance). 한 번의 append 로 두 줄(부분쓰기 노출 최소).
        d.fs.appendFileSync(file, messageLine("user", turn.userText, ts) + messageLine("assistant", turn.assistantText, ts));
      } catch {
        /* no-throw 격리(FR-CONV.1): transcript 실패(권한/디스크/경로)가 turn/finish/memory 를 안 깨뜨린다. */
      }
    },
  };
}
