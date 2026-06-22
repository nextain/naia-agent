// ports/orchestration — UC-CLI sub-agent supervisor 의 **semantic 포트**(계약 §헥사고날 이식 표). domain 만 의존.
//
// 구 `SubAgentAdapter`/`SubAgentSession`/`WorkspaceWatcher`/`Verifier` 를 신 arch 직교 원칙으로 재정의:
//   포트는 SEMANTICS 만 노출한다 — spawn/세션이벤트/취소요청/워크스페이스변경요약/검증리포트.
//   PID·SIGTERM·stdout chunk·exit code·git diff 포맷·runner 이름 등 **메커니즘은 adapter 안에만**(import-boundary 강제).
import type { TaskSpec, SubAgentEvent, WorkspaceChange, VerificationReport, SupervisorReport } from "../domain/orchestration.js";

/** 한 sub-agent 세션 — semantic 이벤트 스트림 + 취소. 구 SubAgentSession 의 핵(id/status/pause/resume/inject 는 2a 비범위).
 *  events 는 **세션당 정확히 1회 session_end** 로 끝나는 단일 패스 async iterable(adapter 계약). */
export interface SubAgentSession {
  readonly events: AsyncIterable<SubAgentEvent>;
  /** 취소 요청(semantic) — adapter 가 메커니즘(SIGTERM→유예→SIGKILL)으로 변환. resolve = 세션 종료 관측 또는 hard-kill 마감. */
  cancel(reason: string): Promise<void>;
}

/** driven — supervisor 가 외부 코딩 에이전트를 sub-agent 로 spawn. 구 SubAgentAdapter.spawn 의 semantic 화.
 *  ⚠️ 구판은 `Promise<SubAgentSession>`(비동기 spawn) — 2a 골격은 동기 반환(세션 객체 즉시·이벤트는 그 안에서 흐름)
 *  으로 단순화(Karpathy: 요청된 최소). 실 subprocess 라도 핸들/스트림은 동기 생성 가능. */
export interface SubAgentPort {
  spawn(task: TaskSpec): SubAgentSession;
}

/** driven — 워크스페이스 변경 감시(semantic). 구 WorkspaceWatcher.watch 의 정규화 — diff()/stats() 메커니즘 제거,
 *  변경 *요약* 스냅샷 스트림만. signal.aborted 시 종료. 2a 는 fake 만 주입(실 chokidar/git 어댑터 = 2c). */
export interface WorkspacePort {
  changes(workdir: string, signal: AbortSignal): AsyncIterable<WorkspaceChange>;
}

/** driven — 작업 후 검증(semantic, **never-throws**). 구 Verifier/VerificationOrchestrator 의 통합 façade —
 *  test/lint/build/typecheck runner 메커니즘은 adapter 안에. supervisor 는 단일 verify(workdir)→리포트만 본다.
 *  ⚠️ 구현은 실패/타임아웃/도구부재도 *구조화 리포트*(ok:false)로 반환해야 함(throw 금지). supervisor 도 방어적으로 래핑(AC2). */
export interface VerifierPort {
  verify(workdir: string): Promise<VerificationReport>;
}

/** driven-out — supervisor 가 바깥(CLI/host)으로 내보내는 semantic 산출물(forwarded sub-agent 이벤트 + 단일 terminal 리포트).
 *  chat-turn 의 AgentEgressPort 와 **별개 채널**(직교) — 오케스트레이션 도메인 타입만 운반. ⚠️ no-throw(실패=로그, throw 금지). */
export interface SupervisorEgressPort {
  /** sub-agent 세션 이벤트를 그대로 전달(인과 순서 보존). */
  event(e: SubAgentEvent): void;
  /** 세션 종료 시 정직 보고를 정확히 1회 방출(terminal). */
  report(r: SupervisorReport): void;
}
