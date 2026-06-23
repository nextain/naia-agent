// adapters/subprocess-session — sub-agent CLI(pi·opencode 등)를 subprocess 로 감싸는 **공유 세션 머신**.
//
// pi/opencode 어댑터(줄단위 NDJSON 모델)가 동형(同型) 구조를 가져 중복을 한 곳으로: child stdout 줄단위 파싱 →
// SubAgentEvent 스트림(큐+waiter 백프레셔), session_end 정확히 1회, late-stdout race 가드, 64MiB 단일줄 가드,
// cancel=SIGTERM→유예→SIGKILL. 어댑터별로 다른 것은 (1) bin/args (2) `lineToEvent`(줄 → 이벤트) (3) 라벨뿐.
// (subagent-shell 은 raw-chunk 모델의 독립 레퍼런스 — 줄 모델로의 통합은 동작변경이라 후속 검토 대상.)
//
// ⚠️ child_process 는 adapters 안에서만(import-boundary 강제). PID·SIGTERM·exit code 는 여기서 끝난다.
import { spawn, type ChildProcess } from "node:child_process";
import type { SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentSession } from "../ports/orchestration.js";

export const DEFAULT_HARD_KILL_DEADLINE_MS = 500; // 구 contract C12 — SIGTERM 후 이 유예 내 미종료 시 SIGKILL.
const MAX_LINE_BYTES = 64 * 1024 * 1024; // 단일 줄 상한(>64MiB = 비정상/DoS) — 구판 P0-3.

/** spawn 시그니처. 기본 = 실 spawn; 테스트가 관측·대체 wrapper 주입(fake child). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcess;

export const defaultSpawn: SpawnFn = (command, args, o) => spawn(command, [...args], o);

/** bin 해석 결과 — command + npx fallback 용 prefixArgs. */
export interface ResolvedBin {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/** 단일 stdout 줄 → SubAgentEvent 0~1개(malformed/무관 = null 드롭). 어댑터별 파서. */
export type LineToEvent = (line: string) => SubAgentEvent | null;

export interface SpawnSessionSpec {
  readonly spawnFn: SpawnFn;
  readonly bin: ResolvedBin;
  /** prefixArgs 뒤에 붙는 어댑터 인자(bin.prefixArgs 는 자동 prepend). */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly hardKillMs: number;
  readonly lineToEvent: LineToEvent;
  /** 미가용/실패 메시지 prefix(예: "pi unavailable", "opencode unavailable"). */
  readonly label: string;
}

/** bin/args 로 subprocess 세션 생성. 동기 spawn throw(드묾) = 정직한 session_end{ok:false}(throw 금지, AC6). */
export function spawnSubprocessSession(spec: SpawnSessionSpec): SubAgentSession {
  const fullArgs = [...spec.bin.prefixArgs, ...spec.args];
  let child: ChildProcess;
  try {
    child = spec.spawnFn(spec.bin.command, fullArgs, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return endedSession(`${spec.label} unavailable: ${(e as Error).message}`);
  }
  return new SubprocessSession(child, spec.hardKillMs, spec.lineToEvent, spec.label);
}

/** 이미 종료된 세션(즉시 session_end{ok:false}) — bin 미해결/spawn 동기실패용 정직 응답. terminal 정확히 1회. */
export function endedSession(reason: string): SubAgentSession {
  const ev: SubAgentEvent = { kind: "session_end", ok: false, reason };
  return {
    events: {
      [Symbol.asyncIterator](): AsyncIterator<SubAgentEvent> {
        let done = false;
        return {
          next(): Promise<IteratorResult<SubAgentEvent>> {
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            done = true;
            return Promise.resolve({ value: ev, done: false });
          },
        };
      },
    },
    cancel(): Promise<void> {
      return Promise.resolve();
    },
  };
}

/** child stdout 줄 → SubAgentEvent 스트림 + hard-kill cancel. session_end 1회·late-stdout/64MiB 가드. */
class SubprocessSession implements SubAgentSession {
  readonly events: AsyncIterable<SubAgentEvent>;

  readonly #child: ChildProcess;
  readonly #hardKillMs: number;
  readonly #lineToEvent: LineToEvent;
  readonly #label: string;
  #queue: SubAgentEvent[] = [];
  #waiters: Array<(r: IteratorResult<SubAgentEvent>) => void> = [];
  #ended = false;
  #stdoutBuf = "";
  #closeListeners: Array<() => void> = [];

  constructor(child: ChildProcess, hardKillMs: number, lineToEvent: LineToEvent, label: string) {
    this.#child = child;
    this.#hardKillMs = hardKillMs;
    this.#lineToEvent = lineToEvent;
    this.#label = label;

    child.stdout?.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr?.on("data", () => {}); // 진행/디버그 출력은 무시(text 아님).

    // spawn 비동기 실패(ENOENT 등) → 정직한 비정상 종료. close 없어도 여기서 종결.
    child.on("error", (err: Error) => this.#emitEnd(false, `${label} unavailable: ${err.message}`));

    // 종료 → session_end. 잔여 partial 줄 flush. SIGTERM/SIGKILL=취소, code 0=성공, 그 외=실패.
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.#stdoutBuf.length > 0) {
        this.#processLine(this.#stdoutBuf);
        this.#stdoutBuf = "";
      }
      if (signal === "SIGKILL" || signal === "SIGTERM") this.#emitEnd(false, `cancelled (${signal})`);
      else if (code === 0) this.#emitEnd(true);
      else this.#emitEnd(false, `exit code ${code}`);
    });

    const self = this;
    this.events = {
      [Symbol.asyncIterator](): AsyncIterator<SubAgentEvent> {
        return {
          next(): Promise<IteratorResult<SubAgentEvent>> {
            if (self.#queue.length > 0) return Promise.resolve({ value: self.#queue.shift()!, done: false });
            if (self.#ended) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => self.#waiters.push(resolve));
          },
        };
      },
    };
  }

  #onStdout(chunk: Buffer): void {
    if (this.#ended) return;
    this.#stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.#stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.#stdoutBuf.slice(0, nl).replace(/\r$/, ""); // CRLF 정규화 — 후행 \r 가 텍스트로 새지 않게(적대리뷰 P2).
      this.#stdoutBuf = this.#stdoutBuf.slice(nl + 1);
      this.#processLine(line);
    }
    // 병적 단일 줄(>64MiB) = 비정상/DoS → 버퍼 폐기 + fail-safe 종료(구 P0-3).
    if (this.#stdoutBuf.length > MAX_LINE_BYTES) {
      this.#stdoutBuf = "";
      this.#emitEnd(false, `${this.#label}: stdout line exceeded limit`);
    }
  }

  #processLine(line: string): void {
    const e = this.#lineToEvent(line);
    if (e) this.#emit(e);
  }

  /** session_end 정확히 1회 — 이후 emit/late stdout 무시(드롭/중복 0). waiter drain + cancel 대기자 해제. */
  #emitEnd(ok: boolean, reason?: string): void {
    if (this.#ended) return;
    this.#emit(reason !== undefined ? { kind: "session_end", ok, reason } : { kind: "session_end", ok });
    this.#ended = true;
    this.#drainWaiters();
    for (const cb of this.#closeListeners.splice(0)) cb();
  }

  #emit(e: SubAgentEvent): void {
    if (this.#ended) return; // session_end 이후 late stdout race 가드(구 P0-2)
    const w = this.#waiters.shift();
    if (w) w({ value: e, done: false });
    else this.#queue.push(e);
  }

  #drainWaiters(): void {
    for (const w of this.#waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  /** semantic cancel → 메커니즘. SIGTERM 후 hardKillMs 유예 내 미종료 시 SIGKILL. resolve = close 관측 또는 hard-kill 마감. */
  cancel(_reason: string): Promise<void> {
    if (this.#ended) return Promise.resolve();
    const alive = this.#child.kill("SIGTERM"); // false = 이미 종료 → close 리스너가 session_end
    if (!alive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!this.#ended) this.#child.kill("SIGKILL"); // C12 — 유예 초과 hard-kill
        resolve();
      }, this.#hardKillMs);
      this.#closeListeners.push(() => {
        clearTimeout(t);
        resolve();
      }); // close 가 먼저 오면 즉시 해제
    });
  }
}
