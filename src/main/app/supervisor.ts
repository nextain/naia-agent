// app/supervisor — UC-CLI Supervisor(구 Phase1Supervisor 의 신 arch 이식). 포트만 사용. domain 만.
//
// 책임(semantic, 메커니즘 0): sub-agent 를 spawn → 그 이벤트를 forward(워크스페이스 변경 스트림과 merge)
//   → session_end 관측 시 verifier 실행(주입 시) → **정직 보고(SupervisorReport) 정확히 1회** 방출.
// ⚠️ 이 파일은 `../domain/*` + `../ports/*` 만 import — child_process/git/transport 누수 금지(import-boundary 강제).
//   취소(SIGTERM→유예→SIGKILL) 메커니즘은 adapter(subagent-shell)에 산다. supervisor 는 cancel(reason) semantic 만 호출.
//
// 불변식:
//   (I1) session_end 후 정확히 1개의 report(terminal) — 드롭/중복 0.
//   (I2) session_end.ok 와 무관하게 verifier 가 주입돼 있으면 항상 verify(AC4 — 실패/중단 세션 포함).
//   (I3) verifier 가 throw/hang(reject) 해도 supervisor 는 throw 하지 않고 ok:false 리포트로 흡수(AC2 — never-throws 래핑).
//   (I4) emit(event/report) 은 no-throw 로 호출(egress 가 throw 해도 supervisor 진행) — diag 로 흡수.
import type {
  TaskSpec, SubAgentEvent, WorkspaceChange, VerificationReport, SupervisorReport,
} from "../domain/orchestration.js";
import { emptyVerification, diffWorkspaceChange } from "../domain/orchestration.js";
import type {
  SubAgentPort, WorkspacePort, VerifierPort, SupervisorEgressPort,
} from "../ports/orchestration.js";
import type { DiagnosticLog } from "../ports/uc1.js";

export interface SupervisorDeps {
  readonly subAgent: SubAgentPort;
  /** 옵셔널 — 주입 시 sub-agent 이벤트와 merge 해 변경 수치를 집계(2c 실 어댑터). 미주입 = 변경 수치 0. */
  readonly workspace?: WorkspacePort;
  /** 옵셔널 — 주입 시 session_end 후 검증(2c 실 어댑터). 미주입 = 검증 생략(emptyVerification, ok:true). */
  readonly verifier?: VerifierPort;
  readonly egress: SupervisorEgressPort;
  readonly diag: DiagnosticLog;
}

/** verifier wall-clock 마감(ms) — never-throws 계약을 보강하는 *liveness* 가드. verifier 가 hang 해도
 *  supervisor 가 영구 정지하지 않고 ok:false 리포트로 진행(AC2). 실 검증 타임아웃 정책은 2c 어댑터 소관. */
const VERIFY_DEADLINE_MS = 60_000;

export class Supervisor {
  constructor(private readonly d: SupervisorDeps) {}

  /**
   * 1개 작업을 sub-agent 로 수행하고 정직 보고를 낸다. terminal=report(정확히 1회). throw 하지 않는다.
   * @param signal 외부 취소(Ctrl+C/stop) — abort 시 workspace 스트림 종료 + 이후 verify/report 진행(부분 리포트).
   */
  async run(task: TaskSpec, signal: AbortSignal): Promise<void> {
    // 1) sub-agent spawn(동기 — 세션 핸들 즉시, 이벤트는 그 안에서 흐름).
    const session = this.d.subAgent.spawn(task);

    // workspace 폴러(setInterval 등)를 **정상완료·에러·취소 모든 경로**에서 확실히 종료시키는 내부 컨트롤러.
    // 외부 signal 과 링크(외부 abort → 내부 abort)하고, run() 종료 시 finally 에서 abort → workspace.changes 가
    // 받은 signal 이 abort 되어 어댑터가 폴러를 정리한다(workspace-git: signal abort → close()→clearInterval).
    // ⚠️ mergeStreams 의 소스 return() 전파만으론 부족(async-gen 이 await 에 suspend 된 경우 inner return() 이
    //    안 불림 — 적대감사 2026-06-23 M3 실측). 그래서 teardown 은 이 signal 경로로 **결정론적** 보장.
    const wsAbort = new AbortController();

    // 2) 외부 abort → sub-agent cancel(semantic) + workspace 폴러 종료. adapter 가 SIGTERM→유예→SIGKILL 로 변환.
    //    이미 abort 된 채 진입해도 1회 트리거(once). cancel reject 는 흡수(취소가 supervisor 를 깨지 않음).
    const onAbort = () => {
      wsAbort.abort();
      void session.cancel("supervisor: external abort").catch((e) => this.safeDiag("sub-agent cancel 실패(무시)", e));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    // 실제 sub-agent session_end 를 관측했나(합성 terminal 제외). finally 에서 읽으므로 **try 밖**(함수 스코프)에 선언
    //   (try-블록 let 은 finally 에서 안 보임). true = 자식 스스로 종료 → 고아 없음 → finally cancel 불요(P3).
    //   false = 자식 alive 가능 → finally 가 cancel(F1, 재감사 2026-06-23).
    let realSessionEnd = false;

    try {
      // 3) workspace 변경 감시(주입 시) — sub-agent 이벤트와 N-way merge. 최신 변경 스냅샷을 누적(latest-wins).
      //    wsAbort.signal 주입(외부 signal 아님) — 정상완료 시에도 finally 가 abort 해 폴러를 끊는다.
      let latestWorkspace: WorkspaceChange | undefined;
      // 감시 시작 시점의 dirty 상태(첫 스냅샷) — 작업 *전부터* 더러웠던 파일을 "바꿈"으로 세지 않기 위한 baseline(P2).
      let baselineWorkspace: WorkspaceChange | undefined;
      const wsStream = this.d.workspace ? this.d.workspace.changes(task.workdir, wsAbort.signal) : undefined;

      // 두 스트림을 태깅해 단일 패스로 merge — sub-agent 이벤트는 forward, workspace 변경은 집계.
      // session_end 가 terminal: 관측 즉시 break(workspace 스트림은 abort/소진으로 정리).
      type Tagged = { readonly src: "agent"; readonly e: SubAgentEvent } | { readonly src: "ws"; readonly c: WorkspaceChange };
      const tagAgent = async function* (it: AsyncIterable<SubAgentEvent>): AsyncIterable<Tagged> { for await (const e of it) yield { src: "agent", e }; };
      const tagWs = async function* (it: AsyncIterable<WorkspaceChange>): AsyncIterable<Tagged> { for await (const c of it) yield { src: "ws", c }; };

      const merged = wsStream
        ? mergeStreams<Tagged>(tagAgent(session.events), tagWs(wsStream))
        : tagAgent(session.events);

      let sessionOk = false;
      let sawSessionEnd = false;
      // ⚠️ 입력 스트림(sub-agent/workspace iterable) reject 를 흡수(P1, 적대리뷰 2026-06-23): 어떤 입력
      //    어댑터가 iteration 중 throw 해도 run() 이 깨지거나 리포트 0회가 되면 안 됨(I1·AC2). 합성 session_end
      //    로 종결 처리 후 verify+report 로 진행 → exactly-one-report 불변식 보존. (오늘 shell 은 미reject 이나
      //    2b pi/opencode transport·2c chokidar/git 권한 에러가 reject 경로를 실제로 친다.)
      try {
        for await (const t of merged) {
          if (t.src === "ws") { if (baselineWorkspace === undefined) baselineWorkspace = t.c; latestWorkspace = t.c; continue; }
          // sub-agent 이벤트 forward(인과 순서 보존, AC3). emit no-throw 흡수.
          this.safeEvent(t.e);
          if (t.e.kind === "session_end") {
            sessionOk = t.e.ok;
            sawSessionEnd = true;
            realSessionEnd = true; // 실제 종료 관측 — 자식이 스스로 끝남(finally cancel 불요)
            break; // terminal 관측 — merge 종료(workspace 는 abort/GC 로 정리, supervisor 는 다음 단계로)
          }
        }
      } catch (streamErr) {
        this.safeDiag("입력 스트림 오류(ok:false 리포트로 흡수)", streamErr);
        this.safeEvent({ kind: "session_end", ok: false, reason: `stream error: ${errMessage(streamErr)}` });
        sessionOk = false;
        sawSessionEnd = true; // 합성 terminal 발화함 — 아래 안전망 중복 방지
      }
      if (!sawSessionEnd) {
        // 잘 동작하는 adapter 라면 발생 안 함(세션당 session_end 1회 계약). 안전망 — 비정상 종료로 간주하고 forward.
        const synthetic: SubAgentEvent = { kind: "session_end", ok: false, reason: "stream ended without session_end" };
        this.safeEvent(synthetic);
        sessionOk = false;
      }

      // P3(적대리뷰 round2/codex): terminal 도달 *즉시* abort 리스너 해제 — verify/report 창에서의 abort 가
      //   이미-종료된 세션에 stale cancel 을 걸지 않도록(비-idempotent 어댑터 대비). finally 는 backstop(중복 무해).
      signal.removeEventListener("abort", onAbort);

      // 4) session_end 후 검증 — ok 여부 무관 항상 수행(AC4). never-throws 래핑(AC2/I3).
      const verification = await this.runVerifierSafe(task.workdir);

      // 5) 정직 보고 — 정확히 1회(terminal, I1). workspace 미주입/무변경 = 수치 0.
      //    ⚠️ baseline(작업 시작 dirty) 을 빼 **sub-agent 가 유발한 변경만** 센다(P2 — 기존 dirty 파일 over-count 방지).
      const changes = latestWorkspace ? diffWorkspaceChange(latestWorkspace, baselineWorkspace) : undefined;
      const report: SupervisorReport = {
        filesChanged: workspaceFileCount(changes),
        additions: changes ? changes.added.length + changes.modified.length : 0,
        deletions: changes ? changes.deleted.length : 0,
        verification,
        sessionOk,
      };
      this.safeReport(report);
    } finally {
      // ★ workspace 폴러 종료 — 정상완료·에러 포함 **모든** 경로에서 wsAbort 를 abort 해 어댑터가 인터벌을
      //   정리하게 한다(--watch hang 회귀, 적대감사 2026-06-23 M3). idempotent(이미 abort 면 무해).
      wsAbort.abort();
      // ★ sub-agent 자식 프로세스 종료 — wsAbort 의 형제(F1, 재감사 2026-06-23). **실제 session_end 미관측 시에만**
      //   cancel(스트림 reject / no-session-end / 합성 terminal) — 이 경로들은 onAbort 가 안 불려 자식(shell/pi/
      //   opencode subprocess)이 고아로 잔존했다. 실제 종료를 봤으면(realSessionEnd) 자식은 이미 죽었으니 cancel
      //   생략(P3 stale-cancel 회피). cancel 은 idempotent 라 안전하지만, 정상경로 무호출이 계약상 더 깔끔.
      if (!realSessionEnd) {
        void session.cancel("supervisor: teardown").catch((e) => this.safeDiag("sub-agent teardown cancel 실패(무시)", e));
      }
      // P2(적대리뷰 2026-06-23): 정상완료 경로에서도 abort 리스너 해제 — 공유/재사용 signal 누수 +
      //   완료된 세션에 대한 stale-cancel 방지. (abort 가 이미 fire 됐으면 once 로 자동 제거됨 → 무해 중복 호출.)
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** verifier 미주입=검증 생략(ok:true 중립). 주입 시 verify 를 deadline 과 race + try/catch 로 감싸 never-throws 보장(AC2). */
  private async runVerifierSafe(workdir: string): Promise<VerificationReport> {
    const verifier = this.d.verifier;
    if (!verifier) return emptyVerification();
    try {
      const r = await raceDeadline(verifier.verify(workdir), VERIFY_DEADLINE_MS);
      if (r === DEADLINE) {
        this.safeDiag("verifier 시간초과(ok:false 리포트로 진행)", new Error(`>${VERIFY_DEADLINE_MS}ms`));
        return { ok: false, checks: [{ name: "verify", pass: false, details: `timeout >${VERIFY_DEADLINE_MS}ms` }] };
      }
      return r;
    } catch (e) {
      // verifier 가 계약 위반으로 throw — supervisor 는 흡수하고 구조화 실패 리포트(AC2).
      this.safeDiag("verifier throw(ok:false 리포트로 흡수)", e);
      return { ok: false, checks: [{ name: "verify", pass: false, details: errMessage(e) }] };
    }
  }

  private safeEvent(e: SubAgentEvent): void {
    try { this.d.egress.event(e); } catch (err) { this.safeDiag("egress.event 실패(무시)", err); }
  }
  private safeReport(r: SupervisorReport): void {
    try { this.d.egress.report(r); } catch (err) { this.safeDiag("egress.report 실패(무시)", err); }
  }
  private safeDiag(message: string, e: unknown): void {
    try { this.d.diag.log(message, errMessage(e)); } catch { /* 로거 throw 흡수 — supervisor 유지 */ }
  }
}

/** workspace 변경 스냅샷 → 변경 파일 수(중복 경로는 add/modify/delete 별 집계 합 — 단순 골격). */
function workspaceFileCount(c: WorkspaceChange | undefined): number {
  if (!c) return 0;
  return c.added.length + c.modified.length + c.deleted.length;
}

function errMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** deadline 센티넬 — verify 결과와 구분(VerificationReport 가 어떤 형태든 충돌 없음). */
const DEADLINE = Symbol("deadline");

/** p 를 deadline 과 race. timeout=DEADLINE, 아니면 p 값. p reject 는 전파(호출부 try/catch). p 는 dangling 가능(void-catch). */
function raceDeadline<T>(p: Promise<T>, timeoutMs: number): Promise<T | typeof DEADLINE> {
  void p.catch(() => {}); // race 패배 시 reject 흡수(unhandled 방지)
  return new Promise<T | typeof DEADLINE>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(DEADLINE); } }, timeoutMs);
    p.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } },
    );
  });
}

/**
 * 순수 N→1 async iterable merger(구 cli-app/stream-merger.ts 의 이식). 정책:
 *   (A) 단일 소스 내부: 순차 await 로 순서 엄격 보존.
 *   (B) N 소스 간: round-robin Promise.race — 먼저 산출한 소스가 이김(타임스탬프 재정렬 없음 = 인과순서 보존).
 * terminal 드롭 0(AC3): 각 소스가 done 될 때까지 race, 어느 슬롯도 누락 없이 yield 후 다음을 다시 큐잉.
 * ⚠️ race 도중 다른 winner 가 같은 슬롯을 정리했을 수 있어 재확인(paranoid) — 구판 P0-1 fix 보존.
 */
export async function* mergeStreams<T>(...sources: Array<AsyncIterable<T>>): AsyncIterable<T> {
  if (sources.length === 0) return;
  const iters = sources.map((s) => s[Symbol.asyncIterator]());
  type Pending = { iter: AsyncIterator<T>; index: number; promise: Promise<{ index: number; result: IteratorResult<T> }> };
  const pending: (Pending | null)[] = iters.map((iter, index) => ({
    iter, index,
    promise: iter.next().then((result) => ({ index, result })),
  }));

  try {
    while (pending.some((p) => p !== null)) {
      const live = pending.filter((p): p is Pending => p !== null);
      if (live.length === 0) break;
      const winner = await Promise.race(live.map((p) => p.promise));
      const { index, result } = winner;
      const currentSlot = pending[index];
      if (!currentSlot) continue; // 다른 race winner 가 settle 함 — 재확인(P0-1)
      if (result.done) { pending[index] = null; continue; }
      yield result.value;
      const slot = pending[index];
      if (slot) slot.promise = slot.iter.next().then((r) => ({ index, result: r }));
    }
  } finally {
    // ⚠️ 소비자가 terminal 관측 후 break(또는 throw)로 일찍 빠지면 — JS 가 이 generator 를 return() 하고 finally 가
    //    돈다 — 아직 **live**(소진 안 됨) 소스 iterator 를 return() 해 하위 자원을 정리한다(예: workspace-git 폴링
    //    인터벌). 누락 시 폴러 타이머가 살아 프로세스가 종료되지 않음(--watch hang, 적대감사 2026-06-23 M3).
    //    - done 슬롯(pending[i]=null)은 제외(불필요 return 부작용 표면 축소, codex #2).
    //    - return() 을 **await 하지 않음**(fire-and-forget): 어떤 소스의 return() 이 pending next() 뒤에 큐잉돼
    //      settle 안 되더라도 merger 가 재-hang 하지 않게(codex #1). 실 어댑터(workspace-git)는 return() 이
    //      동기 close()→clearInterval 이라 타이머가 즉시 정리된다 — best-effort 로 충분. 거부는 swallow.
    for (const p of pending) {
      if (p?.iter.return) {
        try { void Promise.resolve(p.iter.return()).catch(() => {}); } catch { /* 비표준 iterator 의 동기 throw 흡수 */ }
      }
    }
  }
}
