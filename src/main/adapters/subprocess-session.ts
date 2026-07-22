// adapters/subprocess-session — sub-agent CLI(pi·opencode 등)를 subprocess 로 감싸는 **공유 세션 머신**.
//
// pi/opencode 어댑터(줄단위 NDJSON 모델)가 동형(同型) 구조를 가져 중복을 한 곳으로: child stdout 줄단위 파싱 →
// SubAgentEvent 스트림(큐+waiter 백프레셔), session_end 정확히 1회, late-stdout race 가드, 64MiB 단일줄 가드,
// cancel=SIGTERM→유예→SIGKILL. 어댑터별로 다른 것은 (1) bin/args (2) `lineToEvent`(줄 → 이벤트) (3) 라벨뿐.
// (subagent-shell 은 raw-chunk 모델의 독립 레퍼런스 — 줄 모델로의 통합은 동작변경이라 후속 검토 대상.)
//
// ⚠️ child_process 는 adapters 안에서만(import-boundary 강제). PID·SIGTERM·exit code 는 여기서 끝난다.
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentSession } from "../ports/orchestration.js";

export const DEFAULT_HARD_KILL_DEADLINE_MS = 500; // 구 contract C12 — SIGTERM 후 이 유예 내 미종료 시 SIGKILL.
const MAX_LINE_BYTES = 64 * 1024 * 1024; // 단일 줄 상한(>64MiB = 비정상/DoS) — 구판 P0-3.

/** spawn 시그니처. 기본 = 실 spawn; 테스트가 관측·대체 wrapper 주입(fake child). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  opts: { cwd: string; stdio: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv },
) => ChildProcess;

export const defaultSpawn: SpawnFn = (command, args, o) => spawn(command, [...args], o);

/** bin 해석 결과 — command + npx fallback 용 prefixArgs. */
export interface ResolvedBin {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

/**
 * `where`/`which` 결과 목록에서 spawn 가능한 바이너리 경로 선택.
 * **Windows**: Node 의 child_process.spawn 은 확장자 없는 파일(npm 전역 sh-script shim)을 직접 실행 못 함
 *   → ENOENT. 그래서 `.cmd`/`.exe`/`.bat` 확장자 경로를 **우선**. 없으면 첫 결과(테스트/비-Windows 호환).
 * **non-Windows**: 첫 결과(shebang 으로 실행 가능).
 * 어댑터들의 findXxxInPath 가 공유 — Windows bin-해석 회귀(2026-06-29 codex smoke 로 발견)의 공통 해결.
 */
export function pickSpawnableBin(lines: readonly string[]): string | null {
  const trimmed = lines.map((s) => s.trim()).filter((s) => s.length > 0);
  if (trimmed.length === 0) return null;
  if (process.platform === "win32") {
    const spawnable = trimmed.find((p) => /\.(cmd|exe|bat)$/i.test(p));
    if (spawnable) return spawnable;
  }
  return trimmed[0];
}

/**
 * Windows npm-global `.cmd`/`.bat` shim → spawn 가능한 ResolvedBin 추출. **injection-safe**(shell 없이 spawn
 * → CVE-2024-27980 EINVAL + 프롬프트 주입 회피). shim 이 가리키는 대상에 따라:
 *   - `.js`  → `node <pkg/bin/x.js>`(process.execPath + script 를 prefixArgs 로)
 *   - `.exe` → 네이티브 바이너리를 직접 spawn(Node 가 .exe 실행엔 문제없음 = EINVAL 해당 X)
 * npm cmd-shim 포맷(구 `node "..."` / 신 `"%_prog%" "..."`) 모두 수용 — node_modules 내 경로 자체 캡처.
 * 못 찾으면 null(호출처 폴백). %dp0%/%~dp0/$basedir → shim dir 치환. 절대경로·널바이트 검증(주입 가드).
 */
export function resolveNpmShim(cmdPath: string): ResolvedBin | null {
  try {
    const dir = dirname(cmdPath);
    // 전체 텍스트에서 환경변수 치환 후 경로 추출(npx.cmd 처럼 SET "VAR=%~dp0\...js" 동적 참조도 커버).
    const text = readFileSync(cmdPath, "utf8")
      .replace(/%dp0%/gi, dir).replace(/%~dp0/gi, dir).replace(/\$basedir/gi, dir);
    const safe = (p: string): boolean => isAbsolute(p) && !p.includes("\0") && !p.includes("%");
    // 드라이브문자 앵커 — 경로 내 공백("Program Files") 허용, 따옴표/줄바꿈 으로 경계. .js → node wrapper.
    const jsM = text.match(/([A-Za-z]:\\[^"]*node_modules[^"]*\.js)/i);
    if (jsM && safe(jsM[1])) return { command: process.execPath, prefixArgs: [jsM[1]] };
    // .exe → 직접 spawn
    const exeM = text.match(/([A-Za-z]:\\[^"]*node_modules[^"]*\.exe)/i);
    if (exeM && safe(exeM[1])) return { command: exeM[1], prefixArgs: [] };
    return null;
  } catch {
    return null;
  }
}

/**
 * PATH 에서 찾은 CLI 경로를 spawn 가능한 ResolvedBin 으로 정규화. Windows 의 .cmd/.bat shim 은
 * resolveNpmShim 로 node+script 또는 .exe 직접 spawn 으로 변환(실패/비-Windows 는 경로 그대로).
 * 어댑터 resolveXxxBin 공용.
 */
export function resolveSpawnableBin(picked: string): ResolvedBin {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(picked)) {
    const shim = resolveNpmShim(picked);
    if (shim) return shim;
  }
  return { command: picked, prefixArgs: [] };
}

/**
 * `"npx"` 같은 fallback 명령을 spawn 가능한 ResolvedBin 으로 해석. CLI 미설치 시 어댑터들이 npx fallback
 * 을 쓰는데, Windows 에선 `npx` 가 확장자 없어 spawn 불가(ENOENT/EINVAL). `where` 로 찾아 shim 해석
 * (npx.cmd → node + npx-cli.js). non-Windows / 해석 실패 시 명령 그대로.
 */
export function resolveFallbackCommand(command: string): ResolvedBin {
  if (process.platform === "win32" && !/\.[a-z0-9]+$/i.test(command)) {
    try {
      const r = execSync(`where ${command}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const picked = pickSpawnableBin(r.split(/\r?\n/));
      if (picked) return resolveSpawnableBin(picked);
    } catch {
      /* fall through — 명령 그대로 반환(호출처가 정직 unsupported 로 처리) */
    }
  }
  return { command, prefixArgs: [] };
}

/** 단일 stdout 줄 → SubAgentEvent 0~1개(malformed/무관 = null 드롭). 어댑터별 파서. */
export type LineToEvent = (line: string) => SubAgentEvent | null;

export interface SpawnSessionSpec {
  readonly spawnFn: SpawnFn;
  readonly bin: ResolvedBin;
  /** prefixArgs 뒤에 붙는 어댑터 인자(bin.prefixArgs 는 자동 prepend). */
  readonly args: readonly string[];
  readonly cwd: string;
  /** Optional child-only environment. Adapters use this to avoid inheriting a host CLI session. */
  readonly env?: NodeJS.ProcessEnv;
  readonly hardKillMs: number;
  readonly lineToEvent: LineToEvent;
  /** 미가용/실패 메시지 prefix(예: "pi unavailable", "opencode unavailable"). */
  readonly label: string;
  /** Opt-in, redacted process-exit facts for a user-visible runner diagnostic. */
  readonly diagnostics?: boolean;
  /** 단일 줄 상한(테스트 override). 기본 64MiB. 초과 시 child kill + fail-safe 종료. */
  readonly maxLineBytes?: number;
}

/** bin/args 로 subprocess 세션 생성. 동기 spawn throw(드묾) = 정직한 session_end{ok:false}(throw 금지, AC6). */
export function spawnSubprocessSession(spec: SpawnSessionSpec): SubAgentSession {
  const fullArgs = [...spec.bin.prefixArgs, ...spec.args];
  let child: ChildProcess;
  try {
    child = spec.spawnFn(spec.bin.command, fullArgs, {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(spec.env ? { env: spec.env } : {}),
    });
  } catch (e) {
    return endedSession(`${spec.label} unavailable: ${(e as Error).message}`);
  }
  return new SubprocessSession(child, spec.hardKillMs, spec.lineToEvent, spec.label, spec.maxLineBytes ?? MAX_LINE_BYTES, spec.diagnostics === true);
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
  readonly #maxLineBytes: number;
  readonly #diagnostics: boolean;
  #queue: SubAgentEvent[] = [];
  #waiters: Array<(r: IteratorResult<SubAgentEvent>) => void> = [];
  #ended = false;
  #stdoutBuf = "";
  #stderrBytes = 0;
  #stderrText = "";
  #closeListeners: Array<() => void> = [];
  #cancelPromise: Promise<void> | undefined; // 진행 중 취소(멱등 — 적대리뷰 P3)

  constructor(child: ChildProcess, hardKillMs: number, lineToEvent: LineToEvent, label: string, maxLineBytes: number, diagnostics: boolean) {
    this.#child = child;
    this.#hardKillMs = hardKillMs;
    this.#lineToEvent = lineToEvent;
    this.#label = label;
    this.#maxLineBytes = maxLineBytes;
    this.#diagnostics = diagnostics;

    child.stdout?.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.#onStderr(chunk));

    // spawn 비동기 실패(ENOENT 등) → 정직한 비정상 종료. close 없어도 여기서 종결.
    child.on("error", (err: Error) => this.#emitEnd(false, `${label} unavailable: ${err.message}`));

    // 종료 → session_end. 잔여 partial 줄 flush. SIGTERM/SIGKILL=취소, code 0=성공, 그 외=실패.
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.#ended) return; // 이미 종료(error/maxline 가드) → 추가 파싱/종료 안 함(적대리뷰 R3)
      if (this.#stdoutBuf.length > 0) {
        this.#processLine(this.#stdoutBuf);
        this.#stdoutBuf = "";
      }
      const processFact = this.#diagnostics ? this.#processFact(code, signal) : undefined;
      if (signal === "SIGKILL" || signal === "SIGTERM") this.#emitEnd(false, [`cancelled (${signal})`, processFact].filter(Boolean).join("; "));
      else if (code === 0) this.#emitEnd(true, processFact);
      else this.#emitEnd(false, [`exit code ${code}`, processFact].filter(Boolean).join("; "));
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
    // 병적 단일 줄(>한도) = 비정상/DoS → 버퍼 폐기 + child kill(좀비 방지, 적대리뷰 P1/P2) + fail-safe 종료(구 P0-3).
    if (this.#stdoutBuf.length > this.#maxLineBytes) {
      this.#stdoutBuf = "";
      try { this.#child.kill("SIGKILL"); } catch { /* 이미 종료 */ }
      this.#emitEnd(false, `${this.#label}: stdout line exceeded limit`);
    }
  }

  #onStderr(chunk: Buffer): void {
    if (!this.#diagnostics || this.#ended) return;
    this.#stderrBytes += chunk.length;
    // Keep a bounded local sample solely to classify known CLI failures. The
    // raw output is never emitted: it can contain prompt echoes or credentials.
    if (this.#stderrText.length < 4096) {
      this.#stderrText += chunk.toString("utf8").slice(0, 4096 - this.#stderrText.length);
    }
  }

  #processFact(code: number | null, signal: NodeJS.Signals | null): string {
    const exit = signal ? `signal=${signal}` : `exit=${code ?? "unknown"}`;
    return `${this.#label} process ${exit}; stderr=${classifyStderr(this.#stderrText, this.#stderrBytes)}`;
  }

  #processLine(line: string): void {
    let e: SubAgentEvent | null;
    try {
      e = this.#lineToEvent(line);
    } catch {
      return; // 파서 throw = 해석불가 줄(드롭). 머신 불변식 보호 — session_end 는 close 가 보장(적대리뷰 P1).
    }
    if (e?.kind === "session_end") this.#emitEnd(e.ok, e.reason);
    else if (e) this.#emit(e);
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
    if (this.#cancelPromise) return this.#cancelPromise; // 멱등(적대리뷰 P3/R3) — !alive 경로 포함 캐시(중복 신호/타이머 0)
    this.#cancelPromise = this.#runCancel();
    return this.#cancelPromise;
  }

  /** SIGTERM → 유예 → SIGKILL. !alive(이미 종료) = 즉시 resolve(close 리스너가 session_end). */
  #runCancel(): Promise<void> {
    const alive = this.#child.kill("SIGTERM"); // false = 이미 종료
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

/** Never expose raw child stderr to users: only a small, action-oriented class. */
function classifyStderr(stderr: string, bytes: number): string {
  if (bytes === 0) return "none";
  const text = stderr.toLowerCase();
  if (/auth|login|credential|unauthori[sz]ed/.test(text)) return "authentication";
  if (/unknown option|unexpected argument|usage:\s*codex/.test(text)) return "argument_parse";
  if (/model.+(not found|unavailable)|unknown model/.test(text)) return "model";
  if (/permission|access denied|sandbox/.test(text)) return "permission";
  if (/rate.?limit|quota/.test(text)) return "rate_limited";
  return "present";
}
