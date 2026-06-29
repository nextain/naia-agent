#!/usr/bin/env node
// naia-agent-chat — UC-CLI S1(대화) **host 진입점**: naia-os 없이 터미널에서 멀티턴 대화(REPL) + 로그인.
// ⚠️ 같은 파이프라인(NFR-CLI-shared): gRPC host(agent-stdio-entry)와 **동일 compose-agent-deps + 동일 wireAgentUC1**,
//    ingress/egress 만 stdio/readline(cli-chat 의 makeReplConversation). 별도 대화 엔진/도구루프/creds 경로 없음.
// 순수 로직(파싱·history·provider 선택·.env upsert)=dist/main/app/cli-chat. 여기선 process I/O·readline·fs·SIGINT 만.
import process from "node:process";
import { createInterface } from "node:readline";
import * as nodeFs from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseChatArgs, makeReplConversation, chooseProviderConfig, upsertEnvLine, apiKeyEnvFor, CHAT_USAGE,
} from "../dist/main/app/cli-chat.js";
import { wireAgentUC1, wireSupervisor } from "../dist/main/composition/index.js";
import { makeCompositeToolExecutor } from "../dist/main/adapters/composite-tool-executor.js";
import { makeDelegateAgentSkill } from "../dist/main/adapters/delegate-agent-skill.js";
import { composeAgentRuntimeDeps } from "../scripts/builds/compose-agent-deps.mjs";

const ENV_PATH = join(homedir(), ".naia-agent", ".env");

// ~/.naia-agent/.env → process.env(기존 값 우선, 미설정만 채움). dotenv 무의존 미니 파서.
function loadEnvFile() {
  let text;
  try { text = nodeFs.readFileSync(ENV_PATH, "utf8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

async function readLineFromStdin(promptText) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise((res) => rl.question(promptText, (ans) => res(ans))); }
  finally { rl.close(); }
}

async function doLogin(args) {
  const envName = apiKeyEnvFor(args.provider);
  if (!envName) { process.stderr.write(`알 수 없는 provider: ${args.provider}\n`); process.exit(64); }
  let key = args.key;
  if (key === undefined) key = (await readLineFromStdin(`${args.provider} API 키 입력(⚠️ 입력값이 화면에 표시됨): `)).trim();
  if (!key) { process.stderr.write("키가 비어 있습니다 — 저장하지 않음.\n"); process.exit(64); }
  let existing = "";
  try { existing = nodeFs.readFileSync(ENV_PATH, "utf8"); } catch { /* 신규 */ }
  const next = upsertEnvLine(existing, envName, key);
  nodeFs.mkdirSync(dirname(ENV_PATH), { recursive: true, mode: 0o700 });
  nodeFs.writeFileSync(ENV_PATH, next, { mode: 0o600 });
  try { nodeFs.chmodSync(ENV_PATH, 0o600); } catch { /* best-effort(Windows 무시) */ }
  // ⚠️ POSIX mode 0600 은 Windows/NTFS 에서 적용되지 않는다(파일 보호는 OS ACL 의존) — 정직하게 표기(적대리뷰 M3).
  const permNote = process.platform === "win32" ? "Windows: 권한은 OS ACL 의존, POSIX 0600 미적용" : "mode 0600";
  process.stderr.write(`✓ ${args.provider} 키 저장 → ${ENV_PATH} (${envName}, ${permNote})\n  이제 'naia-agent-chat' 로 대화하세요.\n`);
  process.exit(0);
}

async function doChat(args) {
  const deps = await composeAgentRuntimeDeps();
  const cleanup = () => { for (const fn of deps.cleanupFns) { try { fn(); } catch { /* best-effort */ } } };

  // delegate_agent 도구(opt-in: env NAIA_DELEGATE_AGENT=1) — 메인 LLM 이 sub-agent(gemini/opencode/...)를 부리는
  // 오케스트레이션 확장(UC-014). host 가 wireSupervisor(composition) 로 runner 를 조립해 어댑터에 주입(import-boundary).
  let toolExecutor = deps.toolExecutor;
  const delegateOn = !args.noTools && process.env.NAIA_DELEGATE_AGENT === "1" && !!toolExecutor;
  if (delegateOn) {
    const agentOpts = (name) =>
      name === "gemini" ? { gemini: { yolo: true } }
      : name === "opencode" ? { opencode: { skipPermissions: true } }
      : {};
    const delegateRun = async (agent, task, signal, egress) => {
      const sup = wireSupervisor({ subAgentName: agent, subAgentOpts: agentOpts(agent) });
      await sup.run(task, signal, egress);
    };
    const delegateExec = makeDelegateAgentSkill({ run: delegateRun, defaultWorkdir: process.cwd() });
    toolExecutor = makeCompositeToolExecutor([delegateExec, toolExecutor]);
  }

  const chosen = chooseProviderConfig({
    argProvider: args.provider,
    argModel: args.model,
    defaultConfig: deps.defaultConfig,
    envKey: (n) => process.env[n],
  });
  if (!chosen.ok) { process.stderr.write(chosen.error + "\n"); cleanup(); process.exit(78); /* EX_CONFIG */ }
  const config = chosen.config;
  // 키 주입 — gRPC creds_update 와 동일 채널(credentials overlay). 코어 동일, transport 만 다름.
  if (config.apiKey || config.naiaKey) {
    deps.credentials.update(config.provider, {
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.naiaKey ? { naiaKey: config.naiaKey } : {}),
    });
  }

  const io = {
    write: (s) => process.stdout.write(s),
    prompt: () => {},   // REPL 모드에서 rl.prompt 로 교체. once 모드=no-op.
  };
  const repl = makeReplConversation({
    io,
    newRequestId: () => randomUUID(),
    ...(args.systemPrompt ? { systemPrompt: args.systemPrompt } : {}),
    enableTools: !args.noTools,
    sessionId: `cli-${randomUUID()}`,
    ...(process.env.NAIA_CHAT_VERBOSE === "1" ? { verbose: true } : {}),
  });

  // 같은 파이프라인: gRPC 와 동일 deps + 동일 wireAgentUC1, ingress/egress 만 stdio/readline.
  const wired = wireAgentUC1({
    ingress: repl.ingress,
    egress: repl.egress,
    credentials: deps.credentials,
    diag: deps.diag,
    ...(deps.provider ? { provider: deps.provider } : {}),
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
    ...(toolExecutor && !args.noTools ? { toolExecutor } : {}),
    ...(deps.memory ? { memory: deps.memory, compaction: deps.memory } : {}),
    ...(deps.conversationLog ? { conversationLog: deps.conversationLog } : {}),
    defaultConfig: config,
  });
  wired.start?.();
  process.stderr.write(`[naia-agent-chat] provider=${config.provider}/${config.model} (${chosen.source}), skills=${args.noTools ? "off" : deps.skillsLabel}, memory=${deps.memoryLabel}, delegate=${delegateOn ? "on" : "off"}\n`);

  let exiting = false;
  const shutdown = async (code) => {
    if (exiting) return; exiting = true;
    // ⚠️ backstop only(unref) — 정상 경로는 **자연 종료**(process.exit 안 함). hard process.exit() 는 undici
    //   fetch 소켓 teardown 을 끊어 Windows 에서 libuv "UV_HANDLE_CLOSING"(async.c) 어설션 크래시 + exit code
    //   오염(3)을 유발한다(HTTP 응답을 받은 error/일반 경로에서 재현, 실 키 검증 2026-06-26). 이벤트 루프가
    //   비면(readline 해제 + undici idle 소켓 unref) node 가 소켓을 깨끗이 닫고 process.exitCode 로 종료한다.
    const backstop = setTimeout(() => process.exit(code), 15000); backstop.unref?.();
    try { if (wired.drain) await wired.drain(); } catch { /* best-effort */ }
    try { if (deps.memory) await Promise.race([deps.memory.close(), new Promise((r) => setTimeout(r, 8000))]); } catch { /* best-effort */ }
    cleanup();
    process.exitCode = code;
    try { process.stdout.write(""); } catch { /* best-effort */ }
  };

  // ── once 모드: 단발 처리 후 종료(파이프/스크립트) ──
  if (args.once) {
    // ⚠️ watchdog(적대리뷰 H1): handler 가 어떤 이유로 terminal emit 을 안 주면 onTurnEnd 가 안 불려 영구 행 →
    //   stdin 을 안 읽는 once 모드는 좀비가 된다. 상한 시간 후 강제 종료(.unref 로 정상 경로는 차단 안 함).
    const watchdog = setTimeout(() => { process.stderr.write("\n[타임아웃] 응답 없음 — 종료.\n"); shutdown(1); }, 180000);
    watchdog.unref?.();
    repl.setOnTurnEnd((info) => { clearTimeout(watchdog); shutdown(info.kind === "error" ? 1 : 0); });
    if (!repl.submit(args.once)) { clearTimeout(watchdog); process.stderr.write("빈 메시지.\n"); await shutdown(64); }
    return;
  }

  // ── REPL 모드: 입력 큐(파이프/타입어헤드도 턴 순차 처리, 단일 턴 직렬) ──
  process.stdout.write("naia-agent 대화 — Ctrl+C(턴 중)=취소, Ctrl+D=종료\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "› " });
  io.prompt = () => { if (!exiting) rl.prompt(); };
  const queue = [];
  let closing = false;
  const maybeShutdown = () => { if (closing && !repl.isBusy() && queue.length === 0) shutdown(0); };
  const pump = () => { while (!repl.isBusy() && queue.length) repl.submit(queue.shift()); maybeShutdown(); };
  repl.setOnTurnEnd(() => pump());
  rl.on("line", (line) => { queue.push(line); pump(); });
  rl.on("close", () => { closing = true; if (!repl.isBusy() && queue.length === 0) { process.stdout.write("\n안녕히 가세요.\n"); } maybeShutdown(); }); // Ctrl+D/EOF
  let sigintArmed = false;
  process.on("SIGINT", () => {
    if (repl.isBusy()) { repl.cancel(); return; }            // 턴 중 = 취소
    if (sigintArmed) { process.exit(130); }                   // 2회차 = 강제 종료
    sigintArmed = true;
    process.stdout.write("\n(한 번 더 Ctrl+C, 또는 Ctrl+D 로 종료)\n");
    io.prompt();
    setTimeout(() => { sigintArmed = false; }, 2000).unref?.();
  });
  rl.prompt();
}

const parsed = parseChatArgs(process.argv.slice(2));
if (!parsed.ok) {
  if (parsed.help) { process.stdout.write((parsed.error ?? CHAT_USAGE) + "\n"); process.exit(0); }
  process.stderr.write((parsed.error ?? "인자 오류") + "\n");
  process.exit(64);
}
loadEnvFile();
if (parsed.args.mode === "login") await doLogin(parsed.args);
else await doChat(parsed.args);
