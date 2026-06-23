// app/cli-supervise — UC-CLI(S2 supervisor mode) host 진입점의 **순수** 로직.
//
// argv 파싱 + sub-agent 이벤트/정직 리포트 렌더 + exit code 산정. process/Node/transport 의존 0 —
// 실 I/O·SIGINT·platform shell 배선은 host 셸(bin/naia-agent-run.mjs)이 주입한다(직교).
// 이 모듈이 UC-CLI 의 "🔌 배선대기" host 진입점을 순수·테스트 가능 형태로 채운다(SPEC-011).
// import-boundary: domain 만 의존(adapter CommandCheck 는 구조 호환 ParsedCheck 로 분리 — 메커니즘 미import).
import type { SubAgentEvent, SupervisorReport } from "../domain/orchestration.js";

/** --check 로 받은 검증 명령 — adapter `CommandCheck`(name/command/args)와 **구조 호환**(직교: adapter import 안 함). */
export interface ParsedCheck {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
}

/** 파싱된 supervise 인자 — host 가 이걸로 TaskSpec + wireSupervisor opts 를 조립. workdir="." = host 가 cwd 로 해석. */
export interface SuperviseArgs {
  readonly prompt: string;
  readonly workdir: string;
  readonly agent: string;
  readonly model?: string;
  readonly watch: boolean;
  readonly pollMs?: number;
  readonly checks: readonly ParsedCheck[];
  readonly json: boolean;
}

export type ParseResult =
  | { readonly ok: true; readonly args: SuperviseArgs }
  /** help=true = 사용자가 도움말을 명시 요청(에러 아님) → host 는 stdout 출력 + exit 0. help 미설정 = 인자 오류 → stderr + exit 64. */
  | { readonly ok: false; readonly error: string; readonly help?: boolean };

const USAGE = `naia-agent run <task> [options]

  <task>              작업 지시(필수, 따옴표로 감싸기)
  --workdir <dir>     작업 디렉터리(기본: 현재 디렉터리)
  --agent <name>      sub-agent (shell | pi | opencode | claude-code | codex | gemini, 기본: shell)
  --model <id>        모델 힌트(옵션)
  --watch             워크스페이스 변경 감시(git status 폴링). 변경 수치는 폴 간격마다 샘플 —
                      폴 간격보다 빨리 끝나는 작업은 변경이 안 잡힐 수 있음(권위적 결과는 --check 사용).
  --poll <ms>         감시 폴링 간격(ms)
  --check <name=cmd>  완료 후 검증 명령(반복 가능). 명령은 공백으로 분리(따옴표 인자 미지원).
                      예: --check test="pnpm test"
  --json              리포트를 JSON 으로 출력
  -h, --help          이 도움말

exit code: 0=세션 성공+검증 통과, 2=검증 실패, 3=세션 실패/중단, 64=인자 오류`;

export function superviseUsage(): string {
  return USAGE;
}

/**
 * `run` 서브커맨드 이후의 토큰을 파싱. 순수 — cwd/platform 모름(workdir 기본 "." sentinel = host 가 cwd 로 해석).
 * 미지 옵션·빈 task·잘못된 --check/--poll = 정직한 error(throw 없음).
 */
export function parseSuperviseArgs(argv: readonly string[]): ParseResult {
  const positionals: string[] = [];
  let workdir = ".";
  let agent = "shell";
  let model: string | undefined;
  let watch = false;
  let pollMs: number | undefined;
  let json = false;
  const checks: ParsedCheck[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    switch (a) {
      case "-h":
      case "--help":
        return { ok: false, error: USAGE, help: true };
      case "--workdir": {
        const v = argv[++i];
        if (v === undefined) return { ok: false, error: "--workdir 값 누락" };
        workdir = v;
        break;
      }
      case "--agent": {
        const v = argv[++i];
        if (v === undefined) return { ok: false, error: "--agent 값 누락" };
        agent = v;
        break;
      }
      case "--model": {
        const v = argv[++i];
        if (v === undefined) return { ok: false, error: "--model 값 누락" };
        model = v;
        break;
      }
      case "--watch":
        watch = true;
        break;
      case "--poll": {
        const v = argv[++i];
        const n = Number(v);
        if (v === undefined || !Number.isFinite(n) || n <= 0) {
          return { ok: false, error: "--poll 은 양수 ms 여야 함" };
        }
        pollMs = n;
        break;
      }
      case "--json":
        json = true;
        break;
      case "--check": {
        const v = argv[++i];
        if (v === undefined) return { ok: false, error: "--check 값 누락" };
        const eq = v.indexOf("=");
        if (eq <= 0) return { ok: false, error: `--check 형식은 name=command (받음: ${v})` };
        const name = v.slice(0, eq);
        const toks = v
          .slice(eq + 1)
          .trim()
          .split(/\s+/)
          .filter((t) => t.length > 0);
        if (toks.length === 0) return { ok: false, error: `--check ${name} 의 명령이 비어있음` };
        checks.push({ name, command: toks[0]!, args: toks.slice(1) });
        break;
      }
      default:
        if (a.startsWith("-")) return { ok: false, error: `알 수 없는 옵션: ${a}` };
        positionals.push(a);
    }
  }

  const prompt = positionals.join(" ").trim();
  if (prompt === "") return { ok: false, error: `작업 지시(<task>)가 비어있음\n\n${USAGE}` };

  return {
    ok: true,
    args: {
      prompt,
      workdir,
      agent,
      ...(model !== undefined ? { model } : {}),
      watch,
      ...(pollMs !== undefined ? { pollMs } : {}),
      checks,
      json,
    },
  };
}

/** sub-agent 이벤트 → 한 줄(진행 표시). text_delta 는 null(원문은 host 가 raw 로 흘림). */
export function renderEvent(e: SubAgentEvent): string | null {
  switch (e.kind) {
    case "planning":
      return e.note ? `· 계획: ${e.note}` : "· 계획…";
    case "tool_use_start":
      return `· 도구 ${e.tool} 시작`;
    case "tool_use_end":
      return `· 도구 ${e.tool} ${e.ok ? "완료" : "실패"}`;
    case "text_delta":
      return null;
    case "session_end":
      return `· 세션 종료 (${e.ok ? "성공" : "실패"})${e.reason ? `: ${e.reason}` : ""}`;
  }
}

/** SupervisorReport → 정직 보고 블록(꾸미지 않은 숫자). */
export function renderReport(r: SupervisorReport): string {
  const lines: string[] = [];
  lines.push("── 결과 (정직 보고) ──");
  lines.push(`변경 파일: ${r.filesChanged}  (+${r.additions} / -${r.deletions})`);
  lines.push(`sub-agent 세션: ${r.sessionOk ? "성공" : "실패"}`);
  if (r.verification.checks.length === 0) {
    lines.push("검증: 미수행(검증 명령 없음)");
  } else {
    lines.push(`검증: ${r.verification.ok ? "통과" : "실패"}`);
    for (const c of r.verification.checks) {
      lines.push(`  - ${c.name}: ${c.pass ? "pass" : "fail"}${c.details ? ` — ${c.details}` : ""}`);
    }
  }
  return lines.join("\n");
}

/** exit code (UC-CLI S4): 0=세션 성공+검증 통과, 2=검증 실패, 3=세션 실패/중단. */
export function reportExitCode(r: SupervisorReport): number {
  if (!r.sessionOk) return 3;
  if (!r.verification.ok) return 2;
  return 0;
}
