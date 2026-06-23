// adapters/subagent-roster — 이름 → SubAgentPort 선택(구 bin/naia-agent.ts buildSupervisorAdapter 이식, 단계 2b).
//
// "타 AI 오케스트레이터"의 선택 지점: 사용자가 어떤 코딩 에이전트를 sub-agent 로 쓸지 이름으로 고른다.
// 구현됨(2b): pi · opencode · shell. 선언됐으나 후속(claude-code · codex · gemini) + 미지(unknown) = **정직한
// unsupported**(throw 아님 — spawn 시 session_end{ok:false} 1회, AC6). 호스트/CLI 가 이 결과를 그대로 표면화.
import type { SubAgentPort } from "../ports/orchestration.js";
import { endedSession } from "./subprocess-session.js";
import { makePiSubAgent, type SubAgentPiOptions } from "./subagent-pi.js";
import { makeOpencodeSubAgent, type SubAgentOpencodeOptions } from "./subagent-opencode-cli.js";
import { makeShellSubAgent, type SubAgentShellOptions } from "./subagent-shell.js";

/** 2b 에 실제 구현된 어댑터(선택 가능). */
export const SUPPORTED_SUBAGENTS = ["pi", "opencode", "shell"] as const;
/** 구 로스터가 노린 전체 대상(선언) — claude-code/codex/gemini 는 후속 stage(현재 정직 unsupported). */
export const DECLARED_SUBAGENTS = ["pi", "opencode", "shell", "claude-code", "codex", "gemini"] as const;

export interface RosterOptions {
  readonly pi?: SubAgentPiOptions;
  readonly opencode?: SubAgentOpencodeOptions;
  /** shell 은 임의 명령을 sub-agent 로 spawn → command 필수(SubAgentShellOptions). 미주입 시 정직 unsupported. */
  readonly shell?: SubAgentShellOptions;
}

/** 이름 → SubAgentPort. 미구현/미지 = 정직 unsupported(spawn 시 session_end{ok:false} 1회, throw 금지). */
export function selectSubAgent(name: string, opts: RosterOptions = {}): SubAgentPort {
  switch (name) {
    case "pi":
      return makePiSubAgent(opts.pi);
    case "opencode":
      return makeOpencodeSubAgent(opts.opencode);
    case "shell":
      return opts.shell
        ? makeShellSubAgent(opts.shell)
        : unsupportedSubAgent(`unsupported sub-agent: shell (command 미지정 — RosterOptions.shell 필요)`);
    case "claude-code":
    case "codex":
    case "gemini":
      return unsupportedSubAgent(`unsupported sub-agent: ${name} (deferred — 후속 stage)`);
    default:
      return unsupportedSubAgent(`unsupported sub-agent: ${name} (unknown — supported: ${SUPPORTED_SUBAGENTS.join(", ")})`);
  }
}

/** 미구현/미지 이름용 정직 SubAgentPort — spawn 시 즉시 session_end{ok:false, reason}. throw 하지 않는다(AC6). */
function unsupportedSubAgent(reason: string): SubAgentPort {
  return { spawn: () => endedSession(reason) };
}
