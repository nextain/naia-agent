// UC-CLI subagent-shell 어댑터 계약(2a) — SubAgentPort 셸 레퍼런스를 **실 short-lived 자식 프로세스**로 검증.
// AC1(인터럽트 에스컬레이션): cancel → SIGTERM → 유예 후 SIGKILL, terminal(session_end) 정확히 1회.
// 크로스플랫폼: node -e 짧은 명령(셸 무관, Windows/POSIX 동일). 타이밍은 CI-safe(관대) 하되 에스컬레이션 발생은 단언.
import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { makeShellSubAgent, type SpawnFn } from "../main/adapters/subagent-shell.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const NODE = process.execPath; // 현재 node 바이너리(크로스플랫폼).
const isWindows = process.platform === "win32";

async function drain(events: AsyncIterable<SubAgentEvent>): Promise<SubAgentEvent[]> {
  const out: SubAgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("subagent-shell 어댑터 계약 (2a, 실 자식 프로세스)", () => {
  it("빠른 명령: stdout → text_delta, code 0 → session_end{ok:true} (terminal 1회)", async () => {
    const port = makeShellSubAgent({ command: NODE, args: () => ["-e", "process.stdout.write('hi')"] });
    const session = port.spawn({ prompt: "ignored", workdir: process.cwd() });
    const events = await drain(session.events);

    const text = events.filter((e) => e.kind === "text_delta").map((e) => (e as Extract<SubAgentEvent, { kind: "text_delta" }>).text).join("");
    expect(text).toContain("hi");                          // stdout → text_delta 매핑
    const ends = events.filter((e) => e.kind === "session_end");
    expect(ends).toHaveLength(1);                          // terminal 정확히 1회
    expect((ends[0] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true); // exit 0 → ok
  });

  it("P3b(재감사 2026-06-23) — 대량 멀티바이트 출력이 chunk 경계서 안 깨짐(StringDecoder)", async () => {
    // 600KB 의 '가'(3바이트 UTF-8) → ~64KiB 파이프 chunk 다수로 쪼개짐 → 경계에 멀티바이트가 걸린다.
    // chunk 단위 toString("utf8") 였다면 U+FFFD 손상. StringDecoder 가 경계를 이어 무손상이어야 한다.
    const N = 100000;
    const port = makeShellSubAgent({ command: NODE, args: () => ["-e", `process.stdout.write('가'.repeat(${N}))`] });
    const session = port.spawn({ prompt: "ignored", workdir: process.cwd() });
    const events = await drain(session.events);
    const text = events
      .filter((e) => e.kind === "text_delta")
      .map((e) => (e as Extract<SubAgentEvent, { kind: "text_delta" }>).text)
      .join("");
    expect(text).not.toContain("�");   // 손상 문자(replacement) 0
    expect(text.length).toBe(N);            // 정확히 N개(누락/중복 0)
    expect(text).toBe("가".repeat(N));
  });

  it("비정상 종료: exit code≠0 → session_end{ok:false}", async () => {
    const port = makeShellSubAgent({ command: NODE, args: () => ["-e", "process.exit(2)"] });
    const session = port.spawn({ prompt: "ignored", workdir: process.cwd() });
    const events = await drain(session.events);
    const ends = events.filter((e) => e.kind === "session_end") as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(ends).toHaveLength(1);
    expect(ends[0].ok).toBe(false);
    expect(ends[0].reason).toContain("exit code 2");
  });

  it("spawn 실패(없는 명령): session_end{ok:false} 1회(crash 없음)", async () => {
    const port = makeShellSubAgent({ command: "definitely-not-a-real-binary-zzz", args: () => [] });
    const session = port.spawn({ prompt: "x", workdir: process.cwd() });
    const events = await drain(session.events);
    const ends = events.filter((e) => e.kind === "session_end") as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(ends).toHaveLength(1);
    expect(ends[0].ok).toBe(false);
  });

  it("AC1 — 장수 프로세스에 cancel(): SIGTERM → 유예 → SIGKILL 에스컬레이션, session_end 정확히 1회", async () => {
    // child.kill 을 spy 로 감싸 *어댑터가 실제로 보낸 신호 시퀀스*를 boundary 에서 관측(타이밍 무관 결정론).
    // POSIX: SIGTERM 을 트랩(무시)하는 장수 프로세스 → SIGTERM 으론 안 죽고 유예 후 SIGKILL 이 *반드시* 발사.
    // Windows: SIGTERM 은 catch 불가(즉시 종료) → kill('SIGTERM') 1회로 끝나고 SIGKILL 미발사. 에스컬레이션 코드경로는
    //   동일하나(유예 타이머 설치 후 close 가 먼저 옴), 신호 시퀀스가 플랫폼별로 다름 → 플랫폼별 단언.
    const script = isWindows
      ? "setInterval(() => {}, 1000);"
      : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    const grace = 200; // hard-kill 유예 단축(테스트, CI-safe). 기본 500ms.

    // 어댑터의 spawnFn 주입(이 codebase 의 IO-주입 패턴)으로 *실제 보낸 신호 시퀀스*를 boundary 에서 결정론 관측.
    const killSignals: Array<string | number> = [];
    const observingSpawn: SpawnFn = (command, args, o) => {
      const cp: ChildProcess = spawn(command, [...args], o);
      const origKill = cp.kill.bind(cp);
      cp.kill = ((sig?: string | number) => { killSignals.push(sig ?? "SIGTERM"); return origKill(sig as NodeJS.Signals); }) as typeof cp.kill;
      return cp;
    };

    const port = makeShellSubAgent({ command: NODE, args: () => ["-e", script], hardKillDeadlineMs: grace, spawnFn: observingSpawn });
    const session = port.spawn({ prompt: "long", workdir: process.cwd() });
    const events: SubAgentEvent[] = [];
    const drained = (async () => { for await (const e of session.events) events.push(e); })();

    await new Promise((r) => setTimeout(r, 150)); // 프로세스 기동 + (POSIX) SIGTERM 트랩 설치 대기
    await session.cancel("user stop");            // SIGTERM → grace → SIGKILL
    await drained;

    expect(killSignals[0]).toBe("SIGTERM"); // 항상 SIGTERM 먼저(에스컬레이션 1단계) — 모든 플랫폼
    if (!isWindows) {
      // POSIX: SIGTERM 트랩 → 유예 후 SIGKILL 이 *반드시* 발사(에스컬레이션 2단계).
      expect(killSignals).toContain("SIGKILL");
    }
    const ends = events.filter((e) => e.kind === "session_end") as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(ends).toHaveLength(1);   // terminal 정확히 1회(중복/드롭 0)
    expect(ends[0].ok).toBe(false); // 취소 종료 = 실패(ok:false)
  }, 10_000);

  it("AC1 — (결정론) SIGTERM 무시 fake 자식: 유예 초과 → SIGKILL 발사 → session_end 1회 (모든 플랫폼)", async () => {
    // 실 OS 신호 의미 차이를 배제하고 *에스컬레이션 로직 자체*를 결정론으로 검증: fake child 가 SIGTERM 엔 안 죽고
    // (close 미발생) SIGKILL 에만 close 를 발사. → 어댑터가 유예 후 SIGKILL 을 보내야만 종료한다.
    const grace = 80;
    const killSignals: Array<string | number> = [];
    let emitClose: ((signal: NodeJS.Signals) => void) | undefined;
    const fakeSpawn: SpawnFn = () => {
      const handlers: Record<string, (...a: unknown[]) => void> = {};
      const child = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on(ev: string, cb: (...a: unknown[]) => void) { handlers[ev] = cb; return this; },
        kill(sig?: NodeJS.Signals) {
          const s = sig ?? "SIGTERM";
          killSignals.push(s);
          if (s === "SIGKILL") setTimeout(() => handlers.close?.(null, "SIGKILL"), 0); // SIGKILL 만 실제 종료
          return true; // 살아있음(SIGTERM 으론 안 죽음)
        },
      };
      emitClose = (signal) => handlers.close?.(null, signal);
      return child as unknown as ChildProcess;
    };

    const port = makeShellSubAgent({ command: "fake", hardKillDeadlineMs: grace, spawnFn: fakeSpawn });
    const session = port.spawn({ prompt: "p", workdir: process.cwd() });
    const events: SubAgentEvent[] = [];
    const drained = (async () => { for await (const e of session.events) events.push(e); })();

    void emitClose; // (참조 보존 — 이 케이스는 SIGKILL 경로만 사용)
    await session.cancel("stop"); // SIGTERM(무시) → grace → SIGKILL → close
    await drained;

    expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]); // 정확한 에스컬레이션 시퀀스
    const ends = events.filter((e) => e.kind === "session_end") as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(ends).toHaveLength(1);
    expect(ends[0].ok).toBe(false);
  });

  it("AC1 — 이미 종료된 세션에 cancel(): no-op(즉시 resolve, terminal 추가 없음)", async () => {
    const port = makeShellSubAgent({ command: NODE, args: () => ["-e", "process.stdout.write('done')"] });
    const session = port.spawn({ prompt: "x", workdir: process.cwd() });
    const events = await drain(session.events); // 먼저 완주(session_end 수신)
    const endsBefore = events.filter((e) => e.kind === "session_end").length;
    await expect(session.cancel("late")).resolves.toBeUndefined(); // 종료 후 cancel = no-op
    expect(endsBefore).toBe(1); // 추가 terminal 없음
  });
});
