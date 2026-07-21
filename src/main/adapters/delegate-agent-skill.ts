// adapters/delegate-agent-skill — ToolExecutorPort: 메인 LLM 이 sub-agent(외부 코딩 에이전트)를 부리는 도구.
// UC-014 오케스트레이션 확장(2026-06-29) — "메인 LLM 이 2+ sub-agent 를 위임·감독·취합" 시나리오(UC-015 후보).
//
// `delegate_agent(agent, task, workdir?)` → supervisor 구동 → 정직 보고(sessionOk/변경수/검증 + sub-agent 출력 텍스트)
// 를 tool 결과로 반환. 메인 LLM 은 이 결과를 읽고 다음 행동(취합/재지시/보고)을 결정.
//
// ⚠️ import-boundary: adapter 는 composition 을 import 금지 → supervisor runner(`run`)를 **의존성 주입**받는다.
//    host(bin/naia-agent-chat.mjs 등)가 wireSupervisor(composition) 로 run 을 조립해 넘김. 계약 §헥사고날.
// ⚠️ no-throw(ToolExecutorPort 계약): 러너 실패/인자오류/abort = {output, isError:true}(throw 금지 — 루프 안정).
// ⚠️ tier="none": 본 도구는 opt-in(env NAIA_DELEGATE_AGENT=1 등)으로 host 가 활성화 → operator 사전 승인 전제.
//    외부 에이전트 spawn + 워크스페이스 파일 변경을 수반하므로, 기본 toolExecutor 에는 포함되지 않는다.
import type { ToolExecutorPort, DiagnosticLog } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";
import type { TaskSpec, SupervisorReport } from "../domain/orchestration.js";
import type { SupervisorEgressPort } from "../ports/orchestration.js";
import { isAborted } from "./signal-util.js";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** host 가 주입하는 supervisor runner — agent 이름별로 roster+supervisor 를 조립해 1작업 구동.
 *  adapter 는 composition 을 모르므로(import-boundary), 이 함수로 캡슐화해 받는다. */
export type DelegateRunner = (
  agent: string,
  task: TaskSpec,
  signal: AbortSignal,
  egress: SupervisorEgressPort,
) => Promise<void>;

export interface DelegateAgentDeps {
  /** supervisor 구동 함수(composition wireSupervisor 주입). */
  readonly run: DelegateRunner;
  /** workdir 미지정 시 기본 작업 디렉터리. */
  readonly defaultWorkdir: string;
  readonly diag?: DiagnosticLog;
  /** 허용 agent 화이트리스트(미주입 = roster 전체). */
  readonly allowedAgents?: readonly string[];
  /** 지정 시 workdir는 이 실경로 아래로 제한한다(심볼릭 링크 탈출 포함 차단). */
  readonly allowedWorkdirRoot?: string;
}

/** roster 전체 agent(문서용 enum — host 가 화이트리스트 좁힐 수도). */
export const DELEGATE_AGENTS = ["gemini", "opencode", "pi", "claude-code", "codex", "shell"] as const;

/** ToolCall.args(unknown) → 문자열 필드 안전 추출. */
function readArg(call: ToolCall, name: string): string | undefined {
  const a = call.args as Record<string, unknown> | undefined;
  if (!a) return undefined;
  const v = a[name];
  return typeof v === "string" ? v : undefined;
}

/** ToolExecutorPort 구현. 메인 LLM 이 sub-agent 위임용으로 사용. */
export function makeDelegateAgentSkill(deps: DelegateAgentDeps): ToolExecutorPort {
  const allowed = deps.allowedAgents ?? DELEGATE_AGENTS;
  const TOOLS: readonly ToolSpec[] = [
    {
      name: "delegate_agent",
      description:
        "sub-agent(외부 코딩 에이전트)에게 작업을 위임하고 정직 보고를 받는다. agent: " +
        allowed.join(" | ") +
        ". task: 작업 지시. workdir: 작업 디렉터리(기본 현재 워크스페이스). 반환: sessionOk/변경수/검증 + sub-agent 출력 텍스트.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: [...allowed], description: "부릴 sub-agent" },
          task: { type: "string", description: "sub-agent 에게 줄 작업 지시" },
          workdir: { type: "string", description: "작업 디렉터리(기본: 현재 워크스페이스)" },
        },
        required: ["agent", "task"],
      },
      tier: "none",
    },
  ];

  return {
    specs: () => TOOLS,
    async execute(call, opts) {
      const agent = readArg(call, "agent");
      const task = readArg(call, "task");
      let workdir = readArg(call, "workdir") ?? deps.defaultWorkdir;
      if (!agent) return { output: "delegate_agent: 'agent' 인자 누락", isError: true };
      if (!allowed.includes(agent)) return { output: `delegate_agent: 지원 안 하는 agent '${agent}' (가능: ${allowed.join(", ")})`, isError: true };
      if (!task) return { output: "delegate_agent: 'task' 인자 누락", isError: true };
      if (deps.allowedWorkdirRoot) {
        try {
          const root = realpathSync(deps.allowedWorkdirRoot);
          if (!isAbsolute(workdir)) workdir = resolve(root, workdir);
          workdir = realpathSync(workdir);
          const rel = relative(root, workdir);
          if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            return { output: `delegate_agent: workdir가 허용 워크스페이스 밖입니다`, isError: true };
          }
        } catch {
          return { output: "delegate_agent: workdir 실경로를 확인할 수 없습니다", isError: true };
        }
      }
      if (isAborted(opts.signal)) return { output: "delegate_agent: 중단됨(abort)" };

      let text = "";
      let report: SupervisorReport | undefined;
      const egress: SupervisorEgressPort = {
        event(e) {
          if (e.kind === "text_delta") text += e.text;
        },
        report(r) {
          report = r;
        },
      };

      try {
        await deps.run(agent, { prompt: task, workdir }, opts.signal ?? new AbortController().signal, egress);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.diag?.log("delegate_agent runner 실패", msg);
        return { output: `delegate_agent(${agent}): 러너 실패 — ${msg}`, isError: true };
      }

      const r = report;
      const head = r
        ? `agent=${agent} sessionOk=${r.sessionOk} filesChanged=${r.filesChanged} (+${r.additions}/-${r.deletions}) verification=${r.verification.ok ? "pass" : "fail"}${
            r.verification.checks.length ? "(" + r.verification.checks.map((c) => c.name + ":" + (c.pass ? "ok" : "X")).join(", ") + ")" : ""
          }`
        : `agent=${agent} sessionOk=(보고 없음)`;
      const body = text.trim().length > 0 ? `\n[sub-agent 출력]\n${text.trim()}` : "";
      return { output: `[delegate_agent] ${head}${body}` };
    },
  };
}
