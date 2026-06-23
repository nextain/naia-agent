// UC-CLI verifier-commands 어댑터 계약(2c) — VerifierPort 실 어댑터를 FAKE spawn 으로 결정론 검증.
// 헤드라인 계약 = **NEVER-THROWS(AC2)**: 실패 exit · 없는 바이너리(ENOENT) · 타임아웃 · spawn 동기 throw 가
//   전부 {pass:false, details} 로 흡수되고 verify() 는 절대 reject 하지 않는다. + 병렬 집계 ok=allPass.
// 패턴: subagent-shell 계약 거울(fake child via spawnFn) + stub-detector.
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { makeCommandVerifier, type CommandCheck, type SpawnFn } from "../main/adapters/verifier-commands.js";

/** fake child — close/error/stdout/stderr 를 스크립트대로 발화. kill 호출 기록. */
interface FakeChildSpec {
  /** close 시 exit code(null=signal kill). 미설정 + emitError 면 error 만. */
  readonly code?: number | null;
  /** stdout 으로 흘릴 텍스트(close 직전 emit). */
  readonly stdout?: string;
  /** stderr 으로 흘릴 텍스트. */
  readonly stderr?: string;
  /** true = 'error' 이벤트 발화(ENOENT 시뮬레이션) — close 안 함. */
  readonly emitError?: string;
  /** true = close/error 둘 다 안 함(hang) — 타임아웃 유도. */
  readonly hang?: boolean;
  /** 동기 throw(spawn 자체 실패). */
  readonly throwSync?: string;
}

function fakeSpawn(spec: FakeChildSpec, killLog?: string[]): SpawnFn {
  return () => {
    if (spec.throwSync !== undefined) throw new Error(spec.throwSync);
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = stderr;
    // kill — 실 프로세스처럼 SIGKILL 에 close(signal) 를 발화(어댑터의 finish 가 풀리도록). hang 케이스의 타임아웃 종결.
    (child as unknown as { kill: (s?: string) => boolean }).kill = (s?: string) => {
      const sig = s ?? "SIGTERM";
      killLog?.push(sig);
      if (sig === "SIGKILL") setTimeout(() => child.emit("close", null), 0); // hard-kill → close(null, SIGKILL)
      return true;
    };
    // 다음 tick 에 스크립트대로 발화(spawn 동기 반환 후 리스너 부착 보장).
    setTimeout(() => {
      if (spec.stdout) stdout.emit("data", Buffer.from(spec.stdout, "utf8"));
      if (spec.stderr) stderr.emit("data", Buffer.from(spec.stderr, "utf8"));
      if (spec.emitError !== undefined) { child.emit("error", new Error(spec.emitError)); return; }
      if (spec.hang) return; // close/error 안 옴 → 타임아웃 가드가 SIGTERM→SIGKILL 로 풀어야 함
      child.emit("close", spec.code ?? 0);
    }, 0);
    return child;
  };
}

const check = (name: string): CommandCheck => ({ name, command: "x", args: [] });

describe("UC-CLI verifier-commands 어댑터 계약 (2c, fake spawn — never-throws)", () => {
  it("통과 check(exit 0) → pass:true", async () => {
    const v = makeCommandVerifier({ checks: [check("test")], spawnFn: fakeSpawn({ code: 0 }) });
    const r = await v.verify("/w");
    expect(r.ok).toBe(true);
    expect(r.checks).toEqual([{ name: "test", pass: true }]);
  });

  it("실패 check(exit≠0) → pass:false + details(exit code + 출력 꼬리)", async () => {
    const v = makeCommandVerifier({ checks: [check("build")], spawnFn: fakeSpawn({ code: 2, stderr: "tsc: 2 errors" }) });
    const r = await v.verify("/w");
    expect(r.ok).toBe(false);
    expect(r.checks[0].pass).toBe(false);
    expect(r.checks[0].details).toContain("exit code 2");
    expect(r.checks[0].details).toContain("tsc: 2 errors"); // 출력 꼬리가 details 로
  });

  it("AC2 — 없는 바이너리('error' 이벤트/ENOENT) → pass:false(throw 아님)", async () => {
    const v = makeCommandVerifier({ checks: [check("lint")], spawnFn: fakeSpawn({ emitError: "spawn eslint ENOENT" }) });
    await expect(v.verify("/w")).resolves.toBeDefined(); // reject 안 함
    const r = await v.verify("/w");
    expect(r.ok).toBe(false);
    expect(r.checks[0].pass).toBe(false);
    expect(r.checks[0].details).toContain("ENOENT");
  });

  it("AC2 — spawn 동기 throw → pass:false(throw 아님)", async () => {
    const v = makeCommandVerifier({ checks: [check("typecheck")], spawnFn: fakeSpawn({ throwSync: "EACCES boom" }) });
    await expect(v.verify("/w")).resolves.toBeDefined();
    const r = await v.verify("/w");
    expect(r.ok).toBe(false);
    expect(r.checks[0].details).toContain("spawn failed");
    expect(r.checks[0].details).toContain("EACCES boom");
  });

  it("AC2 — hang(close/error 미발생) → 타임아웃 → pass:false + SIGTERM/SIGKILL 에스컬레이션", async () => {
    vi.useFakeTimers();
    try {
      const killLog: string[] = [];
      const v = makeCommandVerifier({
        checks: [check("test")],
        timeoutMs: 1000,
        hardKillMs: 200,
        spawnFn: fakeSpawn({ hang: true }, killLog),
      });
      const done = v.verify("/w");
      // 인터벌 없음(단발 타이머 체인: spawn tick → wall-clock → kill 유예 → SIGKILL close). runAll 이 체인을 끝까지 소진.
      await vi.runAllTimersAsync();
      const r = await done;
      expect(r.ok).toBe(false);
      expect(r.checks[0].pass).toBe(false);
      expect(r.checks[0].details).toContain("timeout");
      expect(killLog).toEqual(["SIGTERM", "SIGKILL"]); // 좀비 방지 에스컬레이션
    } finally {
      vi.useRealTimers();
    }
  });

  it("AC2 — verify() 는 어떤 경로로도 reject 하지 않는다(.resolves 단언)", async () => {
    // 모든 비정상 종류를 한 번에: 실패 + ENOENT + 동기 throw 혼합. verify() 자체는 resolve.
    const flakySpawn: SpawnFn = (command, args, o) => {
      // command 무시 — 인덱스로 분기 불가하므로 args[0] 로 시나리오 라우팅(테스트 스크립팅).
      const scenario = args[0];
      if (scenario === "throw") return fakeSpawn({ throwSync: "boom" })(command, args, o);
      if (scenario === "enoent") return fakeSpawn({ emitError: "ENOENT" })(command, args, o);
      return fakeSpawn({ code: 1 })(command, args, o);
    };
    const v = makeCommandVerifier({
      checks: [
        { name: "a", command: "x", args: ["throw"] },
        { name: "b", command: "x", args: ["enoent"] },
        { name: "c", command: "x", args: ["fail"] },
      ],
      spawnFn: flakySpawn,
    });
    await expect(v.verify("/w")).resolves.toBeDefined(); // never rejects
    const r = await v.verify("/w");
    expect(r.checks.every((c) => c.pass === false)).toBe(true);
  });

  it("여러 check 병렬 실행 → ok = all pass (하나라도 실패하면 ok:false)", async () => {
    const mixedSpawn: SpawnFn = (command, args, o) =>
      fakeSpawn({ code: args[0] === "fail" ? 1 : 0 })(command, args, o);
    const allPass = makeCommandVerifier({
      checks: [{ name: "a", command: "x", args: ["ok"] }, { name: "b", command: "x", args: ["ok"] }],
      spawnFn: mixedSpawn,
    });
    expect((await allPass.verify("/w")).ok).toBe(true);

    const oneFail = makeCommandVerifier({
      checks: [{ name: "a", command: "x", args: ["ok"] }, { name: "b", command: "x", args: ["fail"] }, { name: "c", command: "x", args: ["ok"] }],
      spawnFn: mixedSpawn,
    });
    const r = await oneFail.verify("/w");
    expect(r.ok).toBe(false);
    expect(r.checks.map((c) => `${c.name}:${c.pass}`)).toEqual(["a:true", "b:false", "c:true"]); // 순서·개별 결과 보존
  });

  it("빈 check 목록 → ok:true + checks:[](검증 생략과 동치, crash 없음)", async () => {
    const v = makeCommandVerifier({ checks: [], spawnFn: fakeSpawn({ code: 0 }) });
    expect(await v.verify("/w")).toEqual({ ok: true, checks: [] });
  });

  it("P2-a(적대리뷰) — checks=null/undefined 여도 verify() reject 없이 ok:true(?? [] 방어, never-throws)", async () => {
    const v = makeCommandVerifier({ checks: null as unknown as CommandCheck[], spawnFn: fakeSpawn({ code: 0 }) });
    await expect(v.verify("/w")).resolves.toEqual({ ok: true, checks: [] }); // reject 0
  });

  // ── stub-detector: spawn 이 실제로 어댑터 결과를 좌우하는가(빈 통과/항상참 방지) ──
  it("stub-detector — fake spawn 의 exit code 가 pass 를 실제로 결정한다(seam 살아있음)", async () => {
    let spawnCalls = 0;
    const countingSpawn: SpawnFn = (command, args, o) => {
      spawnCalls++;
      return fakeSpawn({ code: 7 })(command, args, o); // 비-0 → pass:false 여야 함
    };
    const v = makeCommandVerifier({ checks: [check("z")], spawnFn: countingSpawn });
    const r = await v.verify("/w");
    expect(spawnCalls).toBe(1);                  // spawn 이 실제로 불림(어댑터가 fake 를 구동)
    expect(r.checks[0].pass).toBe(false);        // exit 7 → fail(항상참 아님)
    expect(r.checks[0].details).toContain("exit code 7"); // fake 의 code 가 리포트로 관통
  });
});
