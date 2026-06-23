// adapters/verifier-commands — VerifierPort 의 **실 어댑터**(구 verification/orchestrator.ts + runners/ 이식, 단계 2c).
//
// 주입된 check 목록(각 {name, command, args})을 child_process 로 **병렬** 실행 → 각 결과를 {name, pass, details}
// 로 정규화. verify() 는 ok=allPass + checks 를 반환. **NEVER-THROWS(AC2)** 가 헤드라인 계약 —
//   실패 exit code · 없는 바이너리(ENOENT) · 타임아웃 · spawn 동기 throw 등 모든 비정상은 throw 가 아니라
//   pass:false + details 로 흡수한다. 어떤 경로로도 verify() 가 reject 되지 않는다.
//
// ⚠️ child_process 는 adapter 안에서만(import-boundary 강제). exit code/SIGTERM/wall-clock 타이머는 여기서 끝난다.
//    구 orchestrator 의 D27 3중 방어(abort/메모리/wall-clock) 중 여기선 wall-clock 타임아웃 + try/catch 만 가져온다
//    (supervisor 가 이미 verify() 전체에 deadline 가드를 두므로 — supervisor.ts VERIFY_DEADLINE_MS).
import { spawn, type ChildProcess } from "node:child_process";
import type { VerificationReport } from "../domain/orchestration.js";
import type { VerifierPort } from "../ports/orchestration.js";

const DEFAULT_CHECK_TIMEOUT_MS = 60_000; // 구 orchestrator 기본(per-runner 60s). check 당 wall-clock 마감.
const HARD_KILL_DEADLINE_MS = 500;       // SIGTERM 후 이 유예 내 미종료 시 SIGKILL(좀비 방지).
const DEFAULT_DETAIL_TAIL_BYTES = 4 * 1024; // details 에 담는 출력 꼬리 상한(stdout+stderr).

/** 단일 check 명세 — opaque name(domain 은 runner enum 모름) + 실행할 command/args. host 가 주입. */
export interface CommandCheck {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** spawn 시그니처(subprocess-session.ts 의 IO-주입 패턴과 동형) — 기본 = 실 spawn; 테스트가 fake child 주입. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

const defaultSpawn: SpawnFn = (command, args, o) => spawn(command, [...args], o);

export interface CommandVerifierOptions {
  /** 실행할 check 목록(host 주입). 빈 목록 = ok:true + checks:[](검증 생략과 동치). */
  readonly checks: readonly CommandCheck[];
  /** check 당 wall-clock 타임아웃(ms). 기본 60s. */
  readonly timeoutMs?: number;
  /** SIGTERM 후 SIGKILL 유예(ms). 기본 500. */
  readonly hardKillMs?: number;
  /** details 출력 꼬리 상한(bytes). 기본 4KiB. */
  readonly detailTailBytes?: number;
  /** spawn 주입(테스트). 미주입 = node:child_process.spawn. */
  readonly spawnFn?: SpawnFn;
}

/** VerifierPort 실 어댑터. check 목록을 병렬 실행, never-throws 로 구조화 리포트 반환(AC2). */
export function makeCommandVerifier(opts: CommandVerifierOptions): VerifierPort {
  const checks = opts.checks ?? []; // null/undefined 방어(타입상 non-nullable 이나 verify() reject 0 보장 — 적대리뷰 P2-a)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const hardKillMs = opts.hardKillMs ?? HARD_KILL_DEADLINE_MS;
  const tailBytes = opts.detailTailBytes ?? DEFAULT_DETAIL_TAIL_BYTES;
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  return {
    async verify(workdir: string): Promise<VerificationReport> {
      // 병렬 실행 — 각 check 는 독립적으로 never-throws(runOneCheck 가 흡수). Promise.all 은
      // runOneCheck 가 절대 reject 하지 않으므로 안전(reject 0 = verify() reject 0).
      const results = await Promise.all(
        checks.map((c) => runOneCheck(spawnFn, c, workdir, timeoutMs, hardKillMs, tailBytes)),
      );
      const ok = results.every((r) => r.pass);
      return { ok, checks: results };
    },
  };
}

interface CheckResult {
  readonly name: string;
  readonly pass: boolean;
  readonly details?: string;
}

/** 단일 check 실행 → {name, pass, details}. **절대 throw/reject 안 함**(AC2 핵심). 모든 비정상 = pass:false + details. */
async function runOneCheck(
  spawnFn: SpawnFn,
  check: CommandCheck,
  workdir: string,
  timeoutMs: number,
  hardKillMs: number,
  tailBytes: number,
): Promise<CheckResult> {
  try {
    const r = await runCommand(spawnFn, check.command, check.args, workdir, timeoutMs, hardKillMs, tailBytes);
    if (r.spawnError !== undefined) {
      // 없는 바이너리(ENOENT) · spawn 동기/비동기 실패 → 정직한 실패(throw 아님).
      return { name: check.name, pass: false, details: `spawn failed: ${r.spawnError}` };
    }
    if (r.timedOut) {
      return { name: check.name, pass: false, details: `timeout >${timeoutMs}ms${tail(r)}` };
    }
    if (r.code === 0) {
      return { name: check.name, pass: true };
    }
    return { name: check.name, pass: false, details: `exit code ${r.code}${tail(r)}` };
  } catch (e) {
    // runCommand 는 reject 하지 않도록 작성됐으나(paranoid backstop) — 어떤 예기치 못한 throw 도 흡수.
    return { name: check.name, pass: false, details: errMessage(e) };
  }
}

function tail(r: CommandResult): string {
  const combined = (r.stdout + r.stderr).trim();
  return combined.length > 0 ? `: ${combined}` : "";
}

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** 설정 시 spawn 자체가 실패(동기 throw 또는 'error' 이벤트) — code/stdout 무의미. */
  readonly spawnError?: string;
}

/**
 * command 를 workdir 에서 실행하고 {code, stdout, stderr, timedOut, spawnError?} 로 resolve.
 * **절대 reject 안 함** — 동기 spawn throw 와 비동기 'error' 이벤트(ENOENT 등)를 spawnError 로,
 * wall-clock 초과를 timedOut(+SIGTERM→유예→SIGKILL)으로 흡수. stdout/stderr 는 꼬리(tailBytes)만 보존.
 */
function runCommand(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  hardKillMs: number,
  tailBytes: number,
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnFn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      // 동기 spawn throw(드묾) → 정직한 실패(never-throws — resolve, reject 아님).
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: errMessage(e) });
      return;
    }

    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let stderr = "";

    const append = (which: "out" | "err", chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      if (which === "out") stdout = (stdout + s).slice(-tailBytes);
      else stderr = (stderr + s).slice(-tailBytes);
    };
    child.stdout?.on("data", (c: Buffer) => append("out", c));
    child.stderr?.on("data", (c: Buffer) => append("err", c));

    const wallClock = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* 이미 종료 */ }
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ } }, hardKillMs);
    }, timeoutMs);

    const finish = (r: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClock);
      if (killTimer) clearTimeout(killTimer);
      resolve(r);
    };

    // ENOENT 등 비동기 spawn 실패 → spawnError(throw 아님). close 가 안 와도 여기서 종결.
    child.on("error", (err: Error) => {
      finish({ code: null, stdout, stderr, timedOut, spawnError: err.message });
    });
    child.on("close", (code: number | null) => {
      finish({ code, stdout, stderr, timedOut });
    });
  });
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
