#!/usr/bin/env node
// Long-running Discord-only host. The shared composition reads the bot token
// from its dedicated stdin pipe and never binds the Shell gRPC listener.
import process from "node:process";
import { startAgentHost } from "../scripts/builds/agent-stdio-entry.mjs";

const HELP = `naia-agent serve — 독립 Discord 수신 호스트

사용법:
  naia-agent serve

필수 환경 설정:
  NAIA_ADK_PATH                 naia-settings/config.json(provider/model)이 있는 workspace
  NAIA_DISCORD_TOKEN_PIPE=stdin   봇 토큰은 stdin 전용 pipe로 전달
  NAIA_DISCORD_BINDINGS_JSON     허용 guild/channel/user와 processing profile JSON
  NAIA_DISCORD_GENERATION        상태·authority 파일의 generation ID
  NAIA_DISCORD_STATUS_PATH       상태 JSON의 절대 경로
  NAIA_DISCORD_AUTHORITY_PATH    현재 generation authority JSON의 절대 경로

선택 환경 설정:
  NAIA_DISCORD_LEASE_PATH        lease 파일 접두사의 절대 경로 (기본값: authority 경로)

SIGTERM/SIGINT를 받으면 Discord 입력을 멈추고 진행 중인 턴을 정리합니다.
`;

const args = process.argv.slice(2);
if (args.length && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.length) {
  process.stderr.write("serve는 추가 인자를 받지 않습니다. --help를 확인하세요.\n");
  process.exit(64);
}

try {
  await startAgentHost({ mode: "discord-standalone" });
} catch {
  process.stderr.write("naia-agent serve 시작에 실패했습니다. 상태 파일의 오류 코드를 확인하세요.\n");
  process.exitCode = 1;
}
