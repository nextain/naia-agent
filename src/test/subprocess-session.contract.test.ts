// 공유 subprocess-session 머신 직접 계약(2b) — pi/opencode 가 공유하는 고위험 동시성 로직을 어댑터 무관하게 검증.
// passthrough 텍스트 lineToEvent 로 머신 자체를 시험: CRLF 정규화·session_end 1회·partial-line flush·late-stdout 드롭.
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { spawnSubprocessSession, endedSession, type SpawnFn, type ResolvedBin, type LineToEvent } from "../main/adapters/subprocess-session.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const bin: ResolvedBin = { command: "x", prefixArgs: [] };
const textLine: LineToEvent = (line) => (line.length > 0 ? { kind: "text_delta", text: line } : null);

function fake() {
  let stdoutCb: ((b: Buffer) => void) | undefined;
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const killSignals: Array<string | number> = [];
  const spawnFn: SpawnFn = () => {
    const child = {
      stdout: { on: (_e: string, cb: (b: Buffer) => void) => { stdoutCb = cb; } },
      stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) { handlers[ev] = cb; return this as unknown; },
      kill(sig?: NodeJS.Signals) { killSignals.push(sig ?? "SIGTERM"); return true; },
    };
    return child as unknown as ChildProcess;
  };
  return {
    spawnFn,
    write: (s: string) => stdoutCb?.(Buffer.from(s, "utf8")),
    close: (code: number | null, signal: NodeJS.Signals | null = null) => handlers.close?.(code, signal),
    get killSignals() { return killSignals; },
  };
}
async function drain(events: AsyncIterable<SubAgentEvent>): Promise<SubAgentEvent[]> {
  const out: SubAgentEvent[] = []; for await (const e of events) out.push(e); return out;
}
function mk(f: ReturnType<typeof fake>, lineToEvent: LineToEvent = textLine) {
  return spawnSubprocessSession({ spawnFn: f.spawnFn, bin, args: [], cwd: "/tmp", hardKillMs: 50, lineToEvent, label: "x" });
}

describe("subprocess-session 공유 머신 계약 (2b)", () => {
  it("CRLF 정규화 — 후행 \\r 가 텍스트로 새지 않음(적대리뷰 P2)", async () => {
    const f = fake();
    const s = mk(f);
    f.write("hello\r\nworld\r\n"); f.close(0);
    const texts = (await drain(s.events)).filter((e) => e.kind === "text_delta").map((e) => (e as Extract<SubAgentEvent, { kind: "text_delta" }>).text);
    expect(texts).toEqual(["hello", "world"]); // \r 없음
  });

  it("partial line flush on close — 개행 없이 끝난 잔여 버퍼가 close 시 1줄로 발화", async () => {
    const f = fake();
    const s = mk(f);
    f.write("a\nparti"); f.write("al"); f.close(0); // 'partial' 은 개행 없음 → close flush
    const events = await drain(s.events);
    const texts = events.filter((e) => e.kind === "text_delta").map((e) => (e as Extract<SubAgentEvent, { kind: "text_delta" }>).text);
    expect(texts).toEqual(["a", "partial"]);
    expect(events.at(-1)?.kind).toBe("session_end");
  });

  it("session_end 정확히 1회 — close 두 번 와도 중복/throw 없음", async () => {
    const f = fake();
    const s = mk(f);
    f.write("x\n"); f.close(0); f.close(0); // 두 번째 close = 무시
    const ends = (await drain(s.events)).filter((e) => e.kind === "session_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("late-stdout 드롭 — session_end 이후 도착한 stdout 은 이벤트화 안 됨", async () => {
    const f = fake();
    const s = mk(f);
    f.write("first\n"); f.close(0);
    const events = await drain(s.events); // 종결까지 소진
    f.write("late\n");                    // 종결 후 stdout(드롭돼야)
    expect(events.filter((e) => e.kind === "text_delta").map((e) => (e as Extract<SubAgentEvent, { kind: "text_delta" }>).text)).toEqual(["first"]);
  });

  it("endedSession — 즉시 session_end{ok:false} 1회(bin 미해결/honest-unsupported 공용)", async () => {
    const events = await drain(endedSession("x unavailable: nope").events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(events).toHaveLength(1);
    expect(events[0].ok).toBe(false);
    expect(events[0].reason).toBe("x unavailable: nope");
  });
});
