// UC-CLI host 진입점(S2 supervisor mode) 순수 로직 계약테스트 — argv 파싱·이벤트/리포트 렌더·exit code.
// host 셸(bin/naia-agent-run.mjs)은 이 순수 함수 + wireSupervisor(별도 통합테스트 커버)의 얇은 배선이므로,
// 분기/형식/exit-code 결정 로직을 여기서 결정론적으로 잠근다(SPEC-011 / TEST-F-011).
import { describe, it, expect } from "vitest";
import {
  parseSuperviseArgs,
  renderEvent,
  renderReport,
  reportExitCode,
  superviseUsage,
} from "../main/app/cli-supervise.js";
import type { SupervisorReport, SubAgentEvent } from "../main/domain/orchestration.js";

describe("parseSuperviseArgs — 기본/직교", () => {
  it("프롬프트만 주면 기본값(agent=shell, workdir='.', watch=false, json=false, checks=[])", () => {
    const r = parseSuperviseArgs(["버그 고쳐줘"]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args).toMatchObject({
      prompt: "버그 고쳐줘",
      agent: "shell",
      workdir: ".",
      watch: false,
      json: false,
    });
    expect(r.args.checks).toEqual([]);
    expect(r.args.model).toBeUndefined();
    expect(r.args.pollMs).toBeUndefined();
  });

  it("여러 positional 토큰은 프롬프트로 합쳐진다", () => {
    const r = parseSuperviseArgs(["X", "함수", "추가"]);
    expect(r.ok && r.args.prompt).toBe("X 함수 추가");
  });

  it("모든 옵션을 파싱한다", () => {
    const r = parseSuperviseArgs([
      "작업",
      "--workdir",
      "/tmp/w",
      "--agent",
      "pi",
      "--model",
      "gpt-x",
      "--watch",
      "--poll",
      "250",
      "--json",
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args).toMatchObject({
      prompt: "작업",
      workdir: "/tmp/w",
      agent: "pi",
      model: "gpt-x",
      watch: true,
      pollMs: 250,
      json: true,
    });
  });

  it("--check name=cmd 를 {name,command,args} 로 파싱(반복 가능)", () => {
    const r = parseSuperviseArgs(["t", "--check", "test=pnpm test", "--check", "lint=eslint ."]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args.checks).toEqual([
      { name: "test", command: "pnpm", args: ["test"] },
      { name: "lint", command: "eslint", args: ["."] },
    ]);
  });
});

describe("parseSuperviseArgs — 정직한 에러(throw 없음)", () => {
  it("빈 task = 에러", () => {
    const r = parseSuperviseArgs([]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/비어있음/);
  });

  it("옵션만 있고 task 없음 = 에러", () => {
    const r = parseSuperviseArgs(["--agent", "pi"]);
    expect(r.ok).toBe(false);
  });

  it("--help = usage(ok:false)", () => {
    const r = parseSuperviseArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe(superviseUsage());
  });

  it("알 수 없는 옵션 = 에러", () => {
    const r = parseSuperviseArgs(["t", "--nope"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/알 수 없는 옵션/);
  });

  it("--poll 비양수/비숫자 = 에러", () => {
    expect(parseSuperviseArgs(["t", "--poll", "0"]).ok).toBe(false);
    expect(parseSuperviseArgs(["t", "--poll", "-5"]).ok).toBe(false);
    expect(parseSuperviseArgs(["t", "--poll", "abc"]).ok).toBe(false);
  });

  it("--check 형식 오류(= 없음) = 에러", () => {
    expect(parseSuperviseArgs(["t", "--check", "pnpm test"]).ok).toBe(false);
  });

  it("값이 필요한 플래그의 값 누락 = 에러", () => {
    expect(parseSuperviseArgs(["t", "--workdir"]).ok).toBe(false);
    expect(parseSuperviseArgs(["t", "--agent"]).ok).toBe(false);
  });
});

describe("reportExitCode — UC-CLI S4", () => {
  const base = (over: Partial<SupervisorReport>): SupervisorReport => ({
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    verification: { ok: true, checks: [] },
    sessionOk: true,
    ...over,
  });

  it("세션 성공 + 검증 통과 = 0", () => {
    expect(reportExitCode(base({}))).toBe(0);
  });

  it("검증 실패 = 2", () => {
    expect(
      reportExitCode(base({ verification: { ok: false, checks: [{ name: "test", pass: false }] } })),
    ).toBe(2);
  });

  it("세션 실패/중단 = 3 (검증 통과여도 세션 우선)", () => {
    expect(reportExitCode(base({ sessionOk: false }))).toBe(3);
    expect(
      reportExitCode(base({ sessionOk: false, verification: { ok: true, checks: [] } })),
    ).toBe(3);
  });
});

describe("renderReport — 정직 숫자", () => {
  it("변경 수치 + 세션 + 검증 미수행을 표시", () => {
    const out = renderReport({
      filesChanged: 3,
      additions: 12,
      deletions: 4,
      verification: { ok: true, checks: [] },
      sessionOk: true,
    });
    expect(out).toContain("변경 파일: 3");
    expect(out).toContain("+12");
    expect(out).toContain("-4");
    expect(out).toContain("세션: 성공");
    expect(out).toContain("검증: 미수행");
  });

  it("검증 체크 결과를 줄별로 표시", () => {
    const out = renderReport({
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      verification: { ok: false, checks: [{ name: "test", pass: false, details: "1 failed" }] },
      sessionOk: true,
    });
    expect(out).toContain("검증: 실패");
    expect(out).toContain("test: fail — 1 failed");
  });
});

describe("renderEvent — sub-agent 이벤트 → 줄", () => {
  it("text_delta 는 null(host 가 raw stdout)", () => {
    expect(renderEvent({ kind: "text_delta", text: "hi" })).toBeNull();
  });

  it("planning/tool/session_end 는 사람이 읽는 줄", () => {
    expect(renderEvent({ kind: "planning", note: "계획중" })).toMatch(/계획.*계획중/);
    expect(renderEvent({ kind: "tool_use_start", tool: "bash" })).toMatch(/도구 bash 시작/);
    expect(renderEvent({ kind: "tool_use_end", tool: "bash", ok: true })).toMatch(/도구 bash 완료/);
    const end: SubAgentEvent = { kind: "session_end", ok: false, reason: "exit code 1" };
    expect(renderEvent(end)).toMatch(/세션 종료 \(실패\): exit code 1/);
  });
});
