#!/usr/bin/env node
// naia-agent — 단일 통합 CLI 디스패처. 모든 서브커맨드를 한 명령으로.
//   naia-agent [chat] [...]          대화(기본) — naia-agent-chat.mjs
//   naia-agent run <task> [...]      sub-agent 감독 — naia-agent-run.mjs
//   naia-agent workspace [<path>]    워크스페이스 설정/조회
//   naia-agent login --provider <p>  provider 키 저장
//   naia-agent auth|config|models|doctor|session ...  first-class CLI 관리
//   naia-agent -h | --help           이 도움말
//
// 각 서브호스트는 self-contained → 디스패처는 stdio 를 inherit 한 자식으로 위임(중복 로직 없음).
// 'run' 만 run-host 로, 그 외(chat/workspace/login/flags/기본)는 chat-host 로 라우팅.
import process from "node:process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT = join(HERE, "naia-agent-chat.mjs");
const RUN = join(HERE, "naia-agent-run.mjs");
const MANAGE = join(HERE, "naia-agent-manage.mjs");
const LOOP = join(HERE, "naia-agent-loop.mjs");

const HELP = `naia-agent — naia 단일 CLI (naia-os 없이 독립 실행)

사용법:
  naia-agent [chat] [--provider <p>] [--model <id>] [--system <p>] [--no-tools]
                     [--workspace <ws>] [--once <msg>]      대화(기본, 멀티턴 REPL)
  naia-agent run <task> [--agent <name>] [--model <id>] [--no-tools] [--workdir <dir>] [--check <n=cmd>] [--watch] [--json]
                     sub-agent(gemini/opencode/pi/...) 감독 + 정직 보고
  naia-agent loop <serve|start|list|show|answer|cancel|pump|budget|reservations> --config <json> [...]
                     내장 Pi 전용 지속 다중 이슈/역할 루프
  naia-agent workspace [<path>]   워크스페이스 설정(전역 고정)/조회 — 1기기=1설정
  naia-agent auth status|login|logout [...]      OS credential store 계정 관리
  naia-agent config list|get|set|reset [...]     workspace·코딩 기본값 관리
  naia-agent models [provider] [--json]          모델/도구 지원 목록
  naia-agent doctor [--json]                     계정·workspace·Pi·gateway 진단
  naia-agent session list|show|resume [...]      기존 대화 세션 관리
  naia-agent login --provider <p> [--key <v>]    auth login 호환 alias
  naia-agent -h | --help          이 도움말

첫 실행 시 워크스페이스·provider 가 없으면 인터랙티브 온보딩이 채웁니다(값 있으면 자동 로딩).
상세: naia-agent chat --help / naia-agent run --help
`;

const sub = process.argv[2];

if (sub === "-V" || sub === "--version") {
  const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (sub === "-h" || sub === "--help" || sub === "help") {
  process.stdout.write(HELP);
  process.exit(0);
}

const manageCommands = new Set(["auth", "config", "models", "doctor", "session"]);
const target = sub === "run" ? RUN : sub === "loop" ? LOOP : (sub === "login" || manageCommands.has(sub) ? MANAGE : CHAT);
const args = sub === "run"
  ? process.argv.slice(3)
  : sub === "loop"
    ? process.argv.slice(3)
  : sub === "login"
    ? ["auth", "login", ...process.argv.slice(3)]
    : process.argv.slice(2);

const child = spawn(process.execPath, [target, ...args], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
child.on("error", (e) => {
  process.stderr.write(`naia-agent 디스패치 실패: ${e.message}\n`);
  process.exit(1);
});
