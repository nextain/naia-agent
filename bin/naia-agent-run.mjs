#!/usr/bin/env node
// naia-agent-run — UC-CLI(S2 supervisor mode) **host 진입점**. naia-os 없이 터미널에서 단독으로
// naia-agent 오케스트레이션을 구동한다: 작업 지시 → sub-agent(shell/pi/opencode) spawn → 이벤트 스트림 +
// (옵션)워크스페이스 감시 + (옵션)검증 → 정직한 숫자 리포트. Ctrl+C = 안전 중단(SIGTERM→유예→SIGKILL).
//
// 순수 로직(argv 파싱·이벤트/리포트 렌더·exit code)은 dist/main/app/cli-supervise. 여기선 process I/O·
// SIGINT·platform shell 매핑만 배선(host 관심사). 오케스트레이션 코어는 wireSupervisor(composition).
import process from "node:process";
import {
  parseSuperviseArgs,
  renderEvent,
  renderReport,
  reportExitCode,
} from "../dist/main/app/cli-supervise.js";
import { wireSupervisor } from "../dist/main/composition/index.js";

const argv = process.argv.slice(2);
// "run" 서브커맨드는 관용(생략 가능 — 첫 토큰이 프롬프트/옵션이면 바로 supervise).
const rest = argv[0] === "run" ? argv.slice(1) : argv;

const parsed = parseSuperviseArgs(rest);
if (!parsed.ok) {
  process.stderr.write(parsed.error + "\n");
  process.exit(64); // EX_USAGE
}
const a = parsed.args;
const workdir = a.workdir === "." ? process.cwd() : a.workdir;

// shell sub-agent 는 command 가 필요(roster 계약) — host 가 platform 셸을 주입(`/bin/sh -c <prompt>` / `cmd /c`).
// pi/opencode 는 roster 기본(미주입). 미지/deferred 이름은 supervisor 가 정직 unsupported 로 표면화(AC6).
const shellOpts =
  a.agent === "shell"
    ? process.platform === "win32"
      ? { shell: { command: "cmd", args: (t) => ["/c", t.prompt] } }
      : { shell: { command: "/bin/sh", args: (t) => ["-c", t.prompt] } }
    : undefined;

const controller = new AbortController();
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) {
    // 2회차 Ctrl+C = 강제 탈출. 1회차 graceful cancel(SIGTERM→유예→SIGKILL)이 멈춰도 사용자가 빠져나갈 수 있게.
    process.stderr.write("\n강제 종료.\n");
    process.exit(130); // 128 + SIGINT(2)
  }
  interrupted = true;
  process.stderr.write("\n중단 요청(Ctrl+C) — sub-agent 안전 종료 중… (한 번 더 누르면 강제 종료)\n");
  controller.abort();
});

// SupervisorEgressPort — sub-agent 이벤트는 stderr(진행), text_delta 원문은 stdout, 최종 리포트는 정직 보고.
// no-throw 계약(이벤트 처리 중 throw 금지).
let reported = false;
const egress = {
  event: (e) => {
    try {
      if (e.kind === "text_delta") {
        process.stdout.write(e.text);
        return;
      }
      const line = renderEvent(e);
      if (line) process.stderr.write(line + "\n");
    } catch {
      /* egress no-throw */
    }
  },
  report: (r) => {
    reported = true;
    try {
      if (a.json) process.stdout.write(JSON.stringify(r) + "\n");
      else process.stderr.write("\n" + renderReport(r) + "\n");
      process.exitCode = reportExitCode(r);
    } catch {
      process.exitCode = 1;
    }
  },
};

const sup = wireSupervisor({
  subAgentName: a.agent,
  ...(shellOpts ? { subAgentOpts: shellOpts } : {}),
  ...(a.watch ? { watchWorkspace: true } : {}),
  ...(a.pollMs !== undefined ? { pollMs: a.pollMs } : {}),
  ...(a.checks.length > 0 ? { verifierChecks: a.checks } : {}),
});

try {
  await sup.run(
    { prompt: a.prompt, workdir, ...(a.model !== undefined ? { model: a.model } : {}) },
    controller.signal,
    egress,
  );
  // supervisor 불변식 I1: report 가 정확히 1회 방출되어 exitCode 를 설정. run 이 report 없이 resolve 하면
  // (계약상 불가하나 방어) **침묵의 exit 0 금지** — fail-closed 로 실패 처리.
  if (!reported) {
    process.stderr.write("\n오케스트레이션이 리포트 없이 종료됨(예상치 못한 상태) — 실패로 처리.\n");
    process.exitCode = 1;
  }
} catch (err) {
  process.stderr.write(`\n오케스트레이션 실패: ${err?.stack ?? err?.message ?? err}\n`);
  process.exit(1);
}
