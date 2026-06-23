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
      kill(sig?: NodeJS.Signals) { const s = sig ?? "SIGTERM"; killSignals.push(s); if (s === "SIGKILL") setTimeout(() => handlers.close?.(null, "SIGKILL"), 0); return true; },
    };
    return child as unknown as ChildProcess;
  };
  return {
    spawnFn,
    write: (s: string) => stdoutCb?.(Buffer.from(s, "utf8")),
    close: (code: number | null, signal: NodeJS.Signals | null = null) => handlers.close?.(code, signal),
    emitError: (msg: string) => handlers.error?.(new Error(msg)),
    get killSignals() { return killSignals; },
  };
}
async function drain(events: AsyncIterable<SubAgentEvent>): Promise<SubAgentEvent[]> {
  const out: SubAgentEvent[] = []; for await (const e of events) out.push(e); return out;
}
function mk(f: ReturnType<typeof fake>, opts: { lineToEvent?: LineToEvent; maxLineBytes?: number } = {}) {
  return spawnSubprocessSession({
    spawnFn: f.spawnFn, bin, args: [], cwd: "/tmp", hardKillMs: 50, lineToEvent: opts.lineToEvent ?? textLine, label: "x",
    ...(opts.maxLineBytes !== undefined ? { maxLineBytes: opts.maxLineBytes } : {}),
  });
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

  it("P1(적대리뷰 R2/codex) — lineToEvent throw 해도 머신 안 깨짐(해당 줄만 드롭, close 가 session_end 보장)", async () => {
    const f = fake();
    const throwingParser: LineToEvent = (line) => {
      if (line === "boom") throw new Error("parser bug");
      return line.length > 0 ? { kind: "text_delta", text: line } : null;
    };
    const s = mk(f, { lineToEvent: throwingParser });
    f.write("ok1\nboom\nok2\n"); f.close(0);
    const events = await drain(s.events);
    const texts = events.filter((e) => e.kind === "text_delta").map((e) => (e as Extract<SubAgentEvent, { kind: "text_delta" }>).text);
    expect(texts).toEqual(["ok1", "ok2"]);            // throw 한 줄만 드롭(나머지 정상)
    expect(events.at(-1)?.kind).toBe("session_end");  // terminal 여전히 발화(crash 없음)
  });

  it("P1/P2(적대리뷰 R2/codex) — 단일 줄 한도 초과 → child SIGKILL(좀비 방지) + session_end{ok:false}", async () => {
    const f = fake();
    const s = mk(f, { maxLineBytes: 16 }); // 작은 한도(테스트 seam)
    f.write("x".repeat(20)); // 개행 없는 20byte > 16 → 가드 발동
    const events = await drain(s.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(f.killSignals).toContain("SIGKILL"); // child 종료(좀비 방지)
    expect(events.at(-1)?.ok).toBe(false);
    expect(events.at(-1)?.reason).toContain("exceeded limit");
  });

  it("P3(적대리뷰 R2/codex) — cancel() 반복 호출 멱등(SIGTERM 정확히 1회)", async () => {
    const f = fake(); // SIGTERM 으론 안 죽음 → 유예 후 SIGKILL
    const s = mk(f);
    const c1 = s.cancel("stop"); const c2 = s.cancel("stop again"); // 동시 2회
    await Promise.all([c1, c2]);
    expect(f.killSignals.filter((x) => x === "SIGTERM")).toHaveLength(1); // 멱등 — SIGTERM 중복 없음
  });

  it("P3(R3/codex) — cancel() !alive(kill=false) 경로도 멱등(SIGTERM 중복 0)", async () => {
    const killSignals: Array<string | number> = [];
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const spawnFn: SpawnFn = () => ({
      stdout: { on: () => {} }, stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) { handlers[ev] = cb; return this as unknown; },
      kill(sig?: NodeJS.Signals) { killSignals.push(sig ?? "SIGTERM"); return false; }, // 이미 죽음
    } as unknown as ChildProcess);
    const s = spawnSubprocessSession({ spawnFn, bin, args: [], cwd: "/tmp", hardKillMs: 50, lineToEvent: textLine, label: "x" });
    await Promise.all([s.cancel("a"), s.cancel("b"), s.cancel("c")]);
    expect(killSignals.filter((x) => x === "SIGTERM")).toHaveLength(1); // !alive 경로 캐시 — 1회만
  });

  it("R3(codex) — 이미 종료(error) 후 close 가 buffered 줄 재파싱 안 함(late-guard 강화)", async () => {
    const parsed: string[] = [];
    const recording: LineToEvent = (line) => { parsed.push(line); return null; };
    const f = fake();
    const s = mk(f, { lineToEvent: recording });
    f.write("buffered-no-newline"); // 버퍼에만(개행 없음 → 미파싱)
    f.emitError("boom");            // error 로 종결(버퍼 미flush)
    f.close(1);                     // 종료 후 close — 버퍼 재파싱하면 안 됨
    await drain(s.events);
    expect(parsed).not.toContain("buffered-no-newline"); // close-after-ended 파싱 0
  });
});
