// composition root — UC1 agent(brain) 와이어링 (계약 §B.5). 단일 root.
import { makeStderrDiagnostic } from "../adapters/diagnostic.js";
import type { DiagnosticLog } from "../ports/uc1.js";
import { Supervisor } from "../app/supervisor.js";
import { selectSubAgent, type RosterOptions } from "../adapters/subagent-roster.js";
import { makeGitWorkspace } from "../adapters/workspace-git.js";
import { makeCommandVerifier, type CommandCheck } from "../adapters/verifier-commands.js";
import type { SubAgentPort, WorkspacePort, VerifierPort, SupervisorEgressPort } from "../ports/orchestration.js";
import type { TaskSpec } from "../domain/orchestration.js";

export { makeInMemoryCredentials, wireAgentUC1 } from "./uc1-wiring.js";

/**
 * UC-CLI 오케스트레이션 와이어링 — sub-agent supervisor(2a) + roster(2b) + 실 Workspace/Verifier(2c)를
 * 하나의 실행 가능한 supervisor 로 조립. 호스트(CLI/gRPC)가 `run(task, signal, egress)` 로 1작업을 구동한다.
 * workspace/verifier 는 *요청 시에만*(watchWorkspace / verifierChecks) 활성 — 기본은 sub-agent 오케스트레이션만
 * (git 폴링·검증 부작용 없음). egress 는 per-run(호스트가 이벤트/리포트를 받을 곳).
 */
export function wireSupervisor(opts?: {
  subAgent?: SubAgentPort;          // 직접 주입(우선). 미주입 = roster 선택.
  subAgentName?: string;            // roster 이름(기본 "shell"). pi/opencode/claude-code/codex/gemini/grok.
  subAgentOpts?: RosterOptions;     // roster 어댑터 옵션(pi/opencode/shell).
  workspace?: WorkspacePort;        // 직접 주입.
  watchWorkspace?: boolean;         // true + workspace 미주입 = makeGitWorkspace(git status 폴링).
  pollMs?: number;                  // workspace 폴링 간격.
  verifier?: VerifierPort;          // 직접 주입.
  verifierChecks?: readonly CommandCheck[]; // 주입 시 makeCommandVerifier(검증 활성). 미주입 = 검증 생략(ok:true).
  verifyRetries?: number;           // T1 verify-on-stop nudge: 검증 실패 시 재spawn 횟수. 미주입 = verifier 있으면 1, 없으면 0.
  diag?: DiagnosticLog;
}): { run: (task: TaskSpec, signal: AbortSignal, egress: SupervisorEgressPort) => Promise<void> } {
  const diag: DiagnosticLog = opts?.diag ?? makeStderrDiagnostic();
  const subAgent: SubAgentPort = opts?.subAgent ?? selectSubAgent(opts?.subAgentName ?? "shell", opts?.subAgentOpts ?? {});
  const workspace: WorkspacePort | undefined =
    opts?.workspace ?? (opts?.watchWorkspace ? makeGitWorkspace(opts?.pollMs !== undefined ? { pollMs: opts.pollMs } : {}) : undefined);
  const verifier: VerifierPort | undefined =
    opts?.verifier ?? (opts?.verifierChecks ? makeCommandVerifier({ checks: opts.verifierChecks }) : undefined);
  // T1: verifier 가 있을 때만 기본 1회 재시도(검증 없으면 retry 무의미 → 0). 호스트가 명시 override 가능.
  const maxVerifyRetries = opts?.verifyRetries ?? (verifier ? 1 : 0);
  return {
    run: (task, signal, egress) => {
      // egress 는 per-run 이므로 run 마다 Supervisor 조립(나머지 포트는 공유). workspace/verifier 미정 시 supervisor 가 생략.
      const supervisor = new Supervisor({
        subAgent,
        ...(workspace ? { workspace } : {}),
        ...(verifier ? { verifier } : {}),
        egress,
        diag,
        maxVerifyRetries,
      });
      return supervisor.run(task, signal);
    },
  };
}

export { wireDurableSupervisorRuntime } from "./durable-supervisor.js";
export type { DurableSupervisorRuntimeOptions } from "./durable-supervisor.js";
export { makeIssueWorkerRouter, makeProfiledIssueWorker } from "./profiled-issue-worker.js";
