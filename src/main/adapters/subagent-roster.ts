// adapters/subagent-roster — 이름 → SubAgentPort 선택(구 bin/naia-agent.ts buildSupervisorAdapter 이식, 단계 2b).
//
// "타 AI 오케스트레이터"의 선택 지점: 사용자가 어떤 코딩 에이전트를 sub-agent 로 쓸지 이름으로 고른다.
// 구현됨: pi · opencode · shell · claude-code · codex · gemini(claude-code/codex/gemini 는 2026-06-29 추가,
// UC-014/SPEC-010 확장). 미지(unknown) = **정직한 unsupported**(throw 아님 — spawn 시 session_end{ok:false}
// 1회, AC6). 호스트/CLI 가 이 결과를 그대로 표면화.
//
// ⚠️ gemini 어댑터는 runtime-unverified(auth IneligibleTierError) — schema=docs@0.47.0 기반 방어 파싱.
//    auth 복원 시 runtime smoke 필요. 자세한 정직 표기 = subagent-gemini.ts 헤더.
import type { SubAgentPort } from "../ports/orchestration.js";
import { endedSession } from "./subprocess-session.js";
import { makePiSubAgent, type SubAgentPiOptions } from "./subagent-pi.js";
import { makeOpencodeSubAgent, type SubAgentOpencodeOptions } from "./subagent-opencode-cli.js";
import { makeShellSubAgent, type SubAgentShellOptions } from "./subagent-shell.js";
import { makeClaudeCodeSubAgent, type SubAgentClaudeCodeOptions } from "./subagent-claude-code.js";
import { makeCodexSubAgent, type SubAgentCodexOptions } from "./subagent-codex.js";
import { makeGeminiSubAgent, type SubAgentGeminiOptions } from "./subagent-gemini.js";

/** 실제 구현된 어댑터(선택 가능). claude-code/codex/gemini 는 2026-06-29 추가(SPEC-010 확장). */
export const SUPPORTED_SUBAGENTS = ["pi", "opencode", "shell", "claude-code", "codex", "gemini"] as const;
/** 로스터 전체 대상(선언) — 현재 SUPPORTED 와 동일(전원 구현됨). */
export const DECLARED_SUBAGENTS = ["pi", "opencode", "shell", "claude-code", "codex", "gemini"] as const;

export interface RosterOptions {
  readonly pi?: SubAgentPiOptions;
  readonly opencode?: SubAgentOpencodeOptions;
  /** shell 은 임의 명령을 sub-agent 로 spawn → command 필수(SubAgentShellOptions). 미주입 시 정직 unsupported. */
  readonly shell?: SubAgentShellOptions;
  readonly claudeCode?: SubAgentClaudeCodeOptions;
  readonly codex?: SubAgentCodexOptions;
  readonly gemini?: SubAgentGeminiOptions;
}

/** 이름 → SubAgentPort. 미지(unknown) = 정직 unsupported(spawn 시 session_end{ok:false} 1회, throw 금지). */
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
      return makeClaudeCodeSubAgent(opts.claudeCode);
    case "codex":
      return makeCodexSubAgent(opts.codex);
    case "gemini":
      return makeGeminiSubAgent(opts.gemini);
    default:
      return unsupportedSubAgent(`unsupported sub-agent: ${name} (unknown — supported: ${SUPPORTED_SUBAGENTS.join(", ")})`);
  }
}

/** 미지 이름용 정직 SubAgentPort — spawn 시 즉시 session_end{ok:false, reason}. throw 하지 않는다(AC6). */
function unsupportedSubAgent(reason: string): SubAgentPort {
  return { spawn: () => endedSession(reason) };
}
