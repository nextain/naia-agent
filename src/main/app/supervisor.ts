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
import { emptyVerification } from "../domain/orchestration.js";
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

    // 2) 외부 abort → sub-agent cancel(semantic). adapter 가 SIGTERM→유예→SIGKILL 로 변환.
    //    이미 abort 된 채 진입해도 1회 트리거(once). cancel reject 는 흡수(취소가 supervisor 를 깨지 않음).
    const onAbort = () => { void session.cancel("supervisor: external abort").catch((e) => this.safeDiag("sub-agent cancel 실패(무시)", e)); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    try {
      // 3) workspace 변경 감시(주입 시) — sub-agent 이벤트와 N-way merge. 최신 변경 스냅샷을 누적(latest-wins).
      let latestWorkspace: WorkspaceChange | undefined;
      const wsStream = this.d.workspace ? this.d.workspace.changes(task.workdir, signal) : undefined;

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
          if (t.src === "ws") { latestWorkspace = t.c; continue; }
          // sub-agent 이벤트 forward(인과 순서 보존, AC3). emit no-throw 흡수.
          this.safeEvent(t.e);
          if (t.e.kind === "session_end") {
            sessionOk = t.e.ok;
            sawSessionEnd = true;
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
      const report: SupervisorReport = {
        filesChanged: workspaceFileCount(latestWorkspace),
        additions: latestWorkspace ? latestWorkspace.added.length + latestWorkspace.modified.length : 0,
        deletions: latestWorkspace ? latestWorkspace.deleted.length : 0,
        verification,
        sessionOk,
      };
      this.safeReport(report);
    } finally {
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
}
