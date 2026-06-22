// adapters/subagent-shell — SubAgentPort 의 **레퍼런스 구현**(구 adapter-shell/shell-adapter.ts 이식).
//
// 셸 명령을 sub-agent 로 spawn(node:child_process) → stdout/stderr 줄 → text_delta, close → session_end{ok: code===0}.
// cancel() = SIGTERM → 500ms 유예 → SIGKILL(구 InterruptManager + ShellSession.cancel 의 hard-kill 마감 메커니즘).
//
// ⚠️ 이 파일이 **유일하게** child_process 를 import 한다(계약 — 메커니즘은 adapter 안에만). domain/ports/app 은
//    semantic 만 본다(import-boundary 가 child_process 누수를 RED 처리). PID/SIGTERM/exit code 는 여기서 끝난다.
//
// 구판과의 차이(2a 골격, Karpathy 최소화):
//   - 구 ShellSession 의 session_start/interrupt/workspace_change/status/pause/resume/inject 제거 — 2a semantic
//     이벤트(planning/tool_use_*/text_delta/session_end)만. 셸은 LLM 처럼 계획/도구를 안 내므로 text_delta + session_end 만 실제 발화.
//   - 구 redactString(@nextain/agent-observability) 제거 — 2a 비범위(시크릿 리댁션 정책은 후속). 셸 출력은 그대로 text_delta.
//   - spawn 동기 반환(SubAgentPort 계약) — 구판 Promise<Session> 대신 세션 객체 즉시.
import { spawn, type ChildProcess } from "node:child_process";
import type { TaskSpec, SubAgentEvent } from "../domain/orchestration.js";
import type { SubAgentPort, SubAgentSession } from "../ports/orchestration.js";

const HARD_KILL_DEADLINE_MS = 500; // 구 contract C12 / P0-7 — SIGTERM 후 이 유예 내 미종료 시 SIGKILL.

/** spawn 시그니처(node:child_process.spawn 의 우리가 쓰는 부분). 기본 = 실 spawn; 테스트가 관측용 wrapper 주입.
 *  이 codebase 의 어댑터 IO-주입 패턴(FsLike/LineChannel/now)과 동형 — 메커니즘은 adapter 안, 단위 테스트 가능. */
export type SpawnFn = (command: string, args: readonly string[], opts: { cwd: string; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcess;

export interface SubAgentShellOptions {
  /** spawn 할 실행 파일(예: "node", "/usr/bin/echo"). */
  readonly command: string;
  /** 인자 빌더. 기본 = [task.prompt]. */
  readonly args?: (task: TaskSpec) => readonly string[];
  /** hard-kill 유예(ms) override. 기본 500. 테스트가 단축. */
  readonly hardKillDeadlineMs?: number;
  /** spawn 주입(테스트 관측/대체). 미주입 = node:child_process.spawn. */
  readonly spawnFn?: SpawnFn;
}

const defaultSpawn: SpawnFn = (command, args, o) => spawn(command, [...args], o);

/** SubAgentPort 의 셸 레퍼런스 구현. 셸 명령 1개를 sub-agent 로 spawn. */
export function makeShellSubAgent(opts: SubAgentShellOptions): SubAgentPort {
  const hardKillMs = opts.hardKillDeadlineMs ?? HARD_KILL_DEADLINE_MS;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  return {
    spawn(task: TaskSpec): SubAgentSession {
      const args = opts.args ? opts.args(task) : [task.prompt];
      const child = spawnFn(opts.command, args, { cwd: task.workdir, stdio: ["ignore", "pipe", "pipe"] });
      return new ShellSession(child, hardKillMs);
    },
  };
}

/** 단일 셸 세션 — child_process 의 stdout/stderr/close 를 SubAgentEvent 스트림으로 변환 + hard-kill cancel.
 *  큐+waiter 백프레셔(구 ShellSession 보존): consumer 가 느려도 이벤트 순서·종결(session_end 1회) 보장. */
class ShellSession implements SubAgentSession {
  readonly events: AsyncIterable<SubAgentEvent>;

  readonly #child: ChildProcess;
  readonly #hardKillMs: number;
  #queue: SubAgentEvent[] = [];
  #waiters: Array<(r: IteratorResult<SubAgentEvent>) => void> = [];
  #ended = false;
  #closeListeners: Array<() => void> = [];

  constructor(child: ChildProcess, hardKillMs: number) {
    this.#child = child;
    this.#hardKillMs = hardKillMs;

    child.stdout?.on("data", (chunk: Buffer) => this.#emitText(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.#emitText(chunk));

    // spawn 자체 실패(ENOENT 등) — 비정상 종료(ok:false). close 가 안 와도 여기서 종결.
    child.on("error", (err: Error) => this.#emitEnd(false, `spawn error: ${err.message}`));

    // 정상/비정상 종료 → session_end. signal 종료(SIGTERM/SIGKILL)=취소, code===0=성공, 그 외=실패.
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal === "SIGKILL" || signal === "SIGTERM") this.#emitEnd(false, `cancelled (${signal})`);
      else if (code === 0) this.#emitEnd(true);
      else this.#emitEnd(false, `exit code ${code}`);
    });

    // 단일 패스 async iterable — 큐 우선, ended 면 done, 아니면 waiter 등록.
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

  #emitText(buf: Buffer): void {
    if (this.#ended) return;
    const text = buf.toString("utf8");
    if (text.length === 0) return;
    this.#emit({ kind: "text_delta", text });
  }

  /** session_end 를 정확히 1회 — 이후 모든 emit/late stdout 무시(드롭/중복 0). waiter drain + cancel 대기자 해제. */
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

  /** semantic cancel → 메커니즘. SIGTERM 후 hardKillMs 유예 내 미종료 시 SIGKILL. resolve = close 관측 또는 hard-kill 마감.
   *  구 InterruptManager(SIGINT→abort)는 supervisor 의 AbortSignal 로 대체 — 여기선 그 신호를 받아 kill 로 변환. */
  cancel(_reason: string): Promise<void> {
    if (this.#ended) return Promise.resolve();
    const alive = this.#child.kill("SIGTERM"); // false = 이미 종료 → close 리스너가 session_end
    if (!alive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!this.#ended) this.#child.kill("SIGKILL"); // C12 — 유예 초과 hard-kill
        resolve();
      }, this.#hardKillMs);
      this.#closeListeners.push(() => { clearTimeout(t); resolve(); }); // close 가 먼저 오면 즉시 해제
    });
  }
}
