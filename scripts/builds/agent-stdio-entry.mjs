#!/usr/bin/env node
// agent-stdio-entry — new-naia-agent(brain) 를 실 process stdin/stdout 로 구동하는 진입점.
// os uc1-trace-harness 의 AGENT_CMD 대상: stdin JSON-line(AgentOutbound) 수신 → wireAgentUC1 → stdout agent_response.
// 기본 provider=fake(LLM 불요, 헤드리스). 실 LLM 은 후속(providers/ 이식).
import { createInterface } from "node:readline";
import { wireAgentUC1 } from "../../dist/main/composition/index.js";
import { makeProviderResolver } from "../../dist/main/adapters/provider-resolver.js";
import { makeFakeProvider, makeSystemEchoProvider } from "../../dist/main/adapters/fake-provider.js";
import { makeKeychainCredentials } from "../../dist/main/adapters/keychain-secret-store.js";
import { makeNaiaSettingsStore } from "../../dist/main/adapters/naia-settings-store.js";
import { makeStderrDiagnostic } from "../../dist/main/adapters/diagnostic.js";
import { makeGrpcServer } from "../../dist/main/adapters/grpc/grpc-server.js";
import { makeBuiltinSkillsExecutor } from "../../dist/main/adapters/builtin-skills.js";
import { makeGithubSkillsExecutor } from "../../dist/main/adapters/github-skills.js";
import { makeObsidianSkillsExecutor } from "../../dist/main/adapters/obsidian-skills.js";
import { makeMcpSkillsExecutor } from "../../dist/main/adapters/mcp-skills.js";
import { makeMcpJsonRpcClient } from "../../dist/main/adapters/mcp-stdio-transport.js";
import { makeCompositeToolExecutor } from "../../dist/main/adapters/composite-tool-executor.js";
import { makeNotifyExecutor } from "../../dist/main/adapters/notify-skills.js";
import { makeOpenMeteoFetchWeather } from "../../dist/main/adapters/openmeteo-weather.js";
import { makeFileMemoStore } from "../../dist/main/adapters/file-memo-store.js";
// ⚠️ makeNaiaMemory(→@nextain/naia-memory)는 *동적* import — 정적이면 모듈 로딩 실패 시 NAIA_AGENT_MEMORY=off
// 나 try/catch 에 도달 못 하고 프로세스가 죽어 메모리 비활성 채팅(FR-MEM-3)·초기화 격리 계약이 깨진다.
import * as nodeFs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// process stdin/stdout → LineIO. ⚠️ readline 은 즉시 시작하지만 라우터/종료 핸들러는 비동기 init(동적
// import 등) *후* 등록된다 → init 중 도착한 입력·EOF 가 유실되지 않게 **boot 큐 + EOF latch** 로 보존.
const rl = createInterface({ input: process.stdin });
let lineCb = null;
const bootQueue = []; // start() 전 도착한 줄 보관(첫 요청 유실 방지)
const BOOT_QUEUE_MAX = 1000;             // init 중 큐 라인 수 상한
const BOOT_QUEUE_MAX_BYTES = 8 * 1024 * 1024; // init 중 큐 byte 상한(라인 수만으론 거대 라인 메모리 고갈 못 막음)
let bootBytes = 0;
const io = {
  writeLine: (line) => { process.stdout.write(line + "\n"); },
  // 구독 시 큐 드레인 후 stdin resume(backpressure 해제) — boot 중 paused 였어도 ready 되면 흐름 재개.
  onLine: (cb) => { lineCb = cb; for (const l of bootQueue.splice(0)) cb(l); bootBytes = 0; rl.resume(); return () => { lineCb = null; }; },
};
// ⚠️ 드롭 대신 **backpressure** — 큐가 상한(라인 수 또는 byte)에 닿으면 stdin 을 pause 한다(요청 무손실 →
// terminal 불변식 무영향; OS 파이프가 버퍼링, ready 시 resume). 드롭+부분 error 방출은 control frame 오방출·
// 중복 terminal 위험이라 채택 안 함. (단일 무한 라인은 readline 자체 한계로 agent 전역 이슈, 이 UC 밖.)
rl.on("line", (l) => {
  if (lineCb) { lineCb(l); return; }
  bootQueue.push(l); bootBytes += l.length;
  if (bootQueue.length >= BOOT_QUEUE_MAX || bootBytes >= BOOT_QUEUE_MAX_BYTES) rl.pause();
});
// EOF latch — close 가 shutdown 등록 전에 발생하면 보류했다가 등록 시 실행(조기 EOF 에 flush 누락 방지).
// ⚠️ init 가 hang 해도(import 무한대기) shutdown 이 영영 설치 안 될 수 있으므로, latch 가 발화하면 즉시
// init-watchdog 강제 종료 timer 를 건다 — 조기 EOF + hung init 에서도 프로세스가 영구 정지하지 않게.
let onShutdown = null;
// ⚠️ gRPC transport: stdin 은 데이터 채널 아님 → stdin EOF 는 종료 신호가 아니다(서버는 SIGTERM/SIGINT 까지 생존).
// (구 stdio 진입점은 stdin EOF=클라 연결종료로 셧다운했으나, gRPC 서버는 Rust 가 시그널로 종료한다.)
rl.on("close", () => { /* no-op — gRPC 모드: EOF≠shutdown */ });

// provider 해석: 기본 = config-driven resolver — 요청의 provider/model/naiaKey/apiKey(naia-settings → 셸 → req.provider
//   + creds_update) 로 lab-proxy(naia 게이트웨이)/native(키 직접)/ollama 라우팅. (옛 AGENT_PROVIDER=glm/ollama env 강제 삭제 —
//   config 가 흐르게: "온보딩/설정 → adk → agent 가 읽어 그 provider 로 대화".)
// AGENT_PROVIDER=fake → 헤드리스 결정론 fake provider(E2E·LLM 불요).
const ap = process.env.AGENT_PROVIDER;
let provider, resolver, label;
if (ap === "fake") { provider = makeFakeProvider(); label = "fake(headless)"; }
else if (ap === "echo-system") { provider = makeSystemEchoProvider(); label = "echo-system(e2e: systemPrompt 반향)"; } // recall→inject 관통 검증용
else { resolver = makeProviderResolver(); label = "config-driven resolver(lab-proxy/native/ollama)"; }
// ADK 워크스페이스 경로(naia-adk) — config 정본 + 스킬 설정 위치(naia-os 가 기동 시 주입).
const adkPath = process.env.NAIA_ADK_PATH || join(homedir(), "naia-adk");
// 스킬 설정(성격 구분: 스킬 코드=agent 런타임 / 스킬 설정·시크릿=naia-adk 워크스페이스).
//   adkPath/naia-settings/skills.json 예: { "notify": { "slack": "https://...", "discord": "..." } }. env 폴백.
let skillsCfg = {};
try { skillsCfg = JSON.parse(nodeFs.readFileSync(join(adkPath, "naia-settings", "skills.json"), "utf8")); } catch { /* 없음 = env 폴백 */ }

// UC5 실 스킬(time/weather/memo) — 기본 활성(NAIA_AGENT_SKILLS=off 로 비활성). 실 deps 주입:
// clock=현재시각, fetchWeather=open-meteo(키 불요), memo=in-memory(기본). memo_save 는 승인 게이트(tier ask).
let toolExecutor, skillsLabel = "off";
if (process.env.NAIA_AGENT_SKILLS !== "off") {
  // memo 영속: NAIA_MEMO_PATH(또는 ~/.naia-agent/memos.json). node:fs 주입(코어 순수 유지).
  const memoPath = process.env.NAIA_MEMO_PATH || join(homedir(), ".naia-agent", "memos.json");
  const memo = makeFileMemoStore({ path: memoPath, dir: dirname(memoPath), fs: nodeFs });
  const builtin = makeBuiltinSkillsExecutor({ clock: () => new Date(), fetchWeather: makeOpenMeteoFetchWeather(), memo });
  skillsLabel = `time/weather/memo(${memoPath})`;
  // 외부/로컬 스킬 합성(builtin 우선). 환경변수 있을 때만 추가, 없으면 builtin 단독.
  const executors = [builtin];
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken) { executors.push(makeGithubSkillsExecutor({ token: ghToken })); skillsLabel += " + github(ro)"; }
  const vault = process.env.NAIA_OBSIDIAN_VAULT;
  if (vault) { executors.push(makeObsidianSkillsExecutor({ vaultDir: vault, fs: nodeFs })); skillsLabel += " + obsidian(ro)"; }
  // MCP 서버(NAIA_MCP_CMD="npx -y @modelcontextprotocol/server-everything stdio"). 초기화 실패=격리(MCP 없이 진행).
  const mcpCmd = process.env.NAIA_MCP_CMD;
  if (mcpCmd) {
    try {
      const parts = mcpCmd.trim().split(/\s+/);
      const mcpName = process.env.NAIA_MCP_NAME || "mcp";
      const child = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
      const mrl = createInterface({ input: child.stdout });
      let mcb = null;
      mrl.on("line", (l) => mcb?.(l));
      const channel = { send: (line) => child.stdin.write(line + "\n"), onLine: (cb) => { mcb = cb; return () => { mcb = null; }; }, close: () => { try { child.kill(); } catch { /* noop */ } } };
      const transport = makeMcpJsonRpcClient(channel);
      const mcpExec = await makeMcpSkillsExecutor({ transport, serverName: mcpName, initTimeoutMs: 30000 });
      executors.push(mcpExec);
      skillsLabel += ` + mcp:${mcpName}(${mcpExec.specs().length})`;
    } catch (e) {
      process.stderr.write(`[new-naia-agent] MCP init 실패(격리, MCP 없이 진행): ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  // notify(slack/discord/google_chat) — webhook URL = naia-adk skills.json.notify.{target} > env NAIA_NOTIFY_{TARGET}_WEBHOOK.
  //   스킬 코드=agent / 설정(URL)=naia-adk. URL 있는 target 만 활성(github/obsidian 패턴). post=fetch.
  const notifyUrls = (skillsCfg && typeof skillsCfg === "object" && skillsCfg.notify && typeof skillsCfg.notify === "object") ? skillsCfg.notify : {};
  const notifyWebhookUrl = async (target) => notifyUrls[target] ?? process.env[`NAIA_NOTIFY_${target.toUpperCase()}_WEBHOOK`] ?? null;
  const anyNotify = ["slack", "discord", "google_chat"].some((t) => notifyUrls[t] || process.env[`NAIA_NOTIFY_${t.toUpperCase()}_WEBHOOK`]);
  if (anyNotify) {
    const notifyPost = async (url, body, signal) => {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
      return { ok: r.ok, status: r.status };
    };
    executors.push(makeNotifyExecutor({ post: notifyPost, webhookUrl: notifyWebhookUrl }));
    skillsLabel += " + notify";
  }
  toolExecutor = executors.length > 1 ? makeCompositeToolExecutor(executors) : builtin;
}

// creds = OS 키체인 read-back(naia-os write_agent_key 가 쓴 naiaKey/apiKey). creds_update 는 런타임 overlay 로 우선.
// 키체인 read 주입(코어 순수 유지): Linux=secret-tool lookup(service=naia-agent), 기타=미지원(undefined, plaintext fallback 없음).
const C_ENV = { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" };
const secretToolRead = (name) => {
  const r = spawnSync("secret-tool", ["lookup", "service", "naia-agent", "account", name], { encoding: "utf8", timeout: 5000, env: C_ENV });
  if (r.error || r.status !== 0) return undefined;
  const out = r.stdout ?? "";
  return out.length > 0 ? out.replace(/\n$/, "") : undefined;
};
const credentials = makeKeychainCredentials({ read: process.platform === "linux" ? secretToolRead : () => undefined });

// ★ config 정본 = <NAIA_ADK_PATH>/naia-settings/llm.json (정본: naia-os 가 기동 시 워크스페이스 경로 주입 → agent 가
//   naia-settings 로 provider/모델 로딩 완료 → 대화는 메시지만). apiKeyRef → process.env ?? 키체인(secret-tool).
//   파일 없음/미설정 = defaultConfig 없음 → wire chat_request.provider 가 실리면 그걸로(하위호환), 둘 다 없으면 honest error.
const settingsResolveSecret = (ref) => process.env[ref] ?? (process.platform === "linux" ? secretToolRead(ref) : undefined);
const settingsStore = makeNaiaSettingsStore({ fs: nodeFs, resolveSecret: settingsResolveSecret, log: (m, c) => process.stderr.write(`[new-naia-agent] ${m} ${c ? JSON.stringify(c) : ""}\n`) });
const defaultConfig = settingsStore.loadMain(adkPath) ?? undefined;
const configLabel = defaultConfig ? `naia-settings(${defaultConfig.provider}/${defaultConfig.model})` : `none(wire provider 필요) adk=${adkPath}`;
// ★ 라이브 reload(정본 R1-2 "startup-only 금지"): 사용자가 naia-os 에서 모델/프로바이더 교체 시 OS 가
//   naia-settings(config.json) 갱신 후 SetWorkspace/ReloadSettings 재호출 → 여기서 재로딩해 handler 활성 config 를 swap.
//   applyDefaultConfig 는 wireAgentUC1 반환(아래)으로 채워진다 — 클로저가 *호출 시점* 값을 보므로 선언 순서 무관.
let currentAdkPath = adkPath;
let applyDefaultConfig = (_c) => {};
const reloadConfigFrom = (path) => {
  const c = path ? (settingsStore.loadMain(path) ?? undefined) : undefined;
  applyDefaultConfig(c);
  process.stderr.write(`[new-naia-agent] settings reload → ${c ? `${c.provider}/${c.model}` : "none"} (adk=${path})\n`);
  return { loaded: !!c, provider: c?.provider ?? "", model: c?.model ?? "" };
};

// 장기기억(naia-memory) — 기본 활성(NAIA_AGENT_MEMORY=off 로 비활성, FR-MEM-3 무회귀). 턴 전 recall 주입 /
// 턴 후 save. 초기화 실패=격리(기억 없이 진행). store=NAIA_MEMORY_STORE 또는 ~/.naia-agent/memory/store.json.
// ⚠️ project = workspace 식별자 — 서로 다른 워크스페이스/사용자가 한 store 를 공유해도 회상이 섞이지 않게
// (strict 격리는 project 키 단위). NAIA_MEMORY_PROJECT 미지정 시 workspace 경로(NAIA_ADK_PATH)에서 안정적
// 으로 유도(고정 "default" 면 모든 워크스페이스가 합쳐져 교차 누설 — FR-MEM-5 위반). 경로 해시로 충돌 회피.
let memory, memoryLabel = "off";
if (process.env.NAIA_AGENT_MEMORY !== "off") {
  try {
    const { makeNaiaMemory } = await import("../../dist/main/adapters/naia-memory.js"); // 동적 — 로딩 실패=격리
    // workspace 식별자는 *정규화 후* 해시 — 상대/절대/symlink/trailing-slash 가 같은 워크스페이스에 다른
    // project 를 만들어 기억을 못 찾는 것 방지. 정상 운영(os→agent 가 존재하는 워크스페이스 경로 주입)에선
    // realpath 가 안정적; 경로 부재(degenerate)면 절대경로 resolve 폴백(best-effort). 충돌 회피 위해 128-bit.
    const { resolveWorkspaceId, storeDirKey } = await import("../../dist/main/adapters/workspace-project.js");
    // project = workspace identity(영속 UUID `<adkPath>/.naia/workspace-id`, FR-MEM-9). 이동 시 따라가고
    // 경로 재사용 시 새 UUID → 이전 워크스페이스 기억 누설 차단. 경로 부재면 경로해시 폴백. 환경변수 우선.
    const project = process.env.NAIA_MEMORY_PROJECT || resolveWorkspaceId(adkPath, {
      readFile: (p) => nodeFs.readFileSync(p, "utf8"),                                  // ENOENT/EACCES code 보존
      writeFileExclusive: (p, d) => nodeFs.writeFileSync(p, d, { flag: "wx", mode: 0o600 }), // wx=배타(EEXIST)
      mkdir: (p) => nodeFs.mkdirSync(p, { recursive: true, mode: 0o700 }),
      isDirectory: (p) => { try { return nodeFs.statSync(p).isDirectory(); } catch { return false; } },
      randomUUID,
    });
    // ⚠️ store 파일은 **workspace(project)별로 분리** — 단일 store 를 여러 워크스페이스가 공유하면 종료 flush
    // 의 atomic-rename 이 lost-update 로 서로 덮어쓴다. 디렉터리 조각은 project 해시(traversal-safe).
    // NAIA_MEMORY_DIR(base dir) 지정 시에도 그 아래 project-hash 서브디렉터리 분리 유지. NAIA_MEMORY_STORE
    // (정확 파일) = 분리 우회 **escape hatch**(테스트/단일-store, 다중 워크스페이스 동시 시 lost-update 위험).
    const storeBase = process.env.NAIA_MEMORY_DIR || join(homedir(), ".naia-agent", "memory");
    const storePath = process.env.NAIA_MEMORY_STORE || join(storeBase, storeDirKey(project), "store.json");
    // at-rest 기밀성 방어(저비용): store 디렉터리를 0700 으로 생성(다른 로컬 사용자 읽기 차단). 파일 권한
    // (0600)·symlink·비정규 파일 처리는 실제 파일 I/O 를 소유한 naia-memory LocalAdapter 의 책임(이 wiring
    // UC 범위 밖, naia-memory 하드닝 항목). umask 영향 회피 위해 mode 명시.
    try { nodeFs.mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
    // sessionId = 프로세스별 고유 — 재시작마다 별 세션(provenance/rolling-summary/compact 경계 오염 방지).
    // 고정 "s1" 이면 같은 project 의 모든 재시작이 한 세션으로 합쳐짐. 회상은 content+project 기반이라
    // 정확성엔 무관하나, 세션 경계 위생을 위해 분리.
    const sessionId = process.env.NAIA_MEMORY_SESSION || `proc-${randomUUID()}`;
    memory = makeNaiaMemory({ storePath, project, sessionId });
    memoryLabel = `naia-memory(${storePath}, project=${project})`;
  } catch (e) {
    process.stderr.write(`[new-naia-agent] memory init 실패(격리, 기억 없이 진행): ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

// 표준 로깅 sink 주입(docs/logging.md): stderr(stdout 은 wire 전용) + debug 게이트(NAIA_AGENT_DEBUG=1 시 진입·분기 로그).
const diag = makeStderrDiagnostic({ write: (l) => process.stderr.write(l + "\n"), debug: process.env.NAIA_AGENT_DEBUG === "1" });
// 정본 transport = gRPC (naia-os --gRPC--> naia-agent). os(Rust)가 이 서버에 connect. data 채널은 gRPC 단일.
// SetWorkspace/ReloadSettings = naia-adk/naia-settings 로딩 결과 반환(저장/불러오기 정본).
const grpcServer = makeGrpcServer({
  bindAddr: process.env.NAIA_AGENT_GRPC_ADDR || "127.0.0.1:0",
  onSetWorkspace: (wsPath) => {
    if (wsPath) currentAdkPath = wsPath; // OS 가 워크스페이스 경로 주입 → 이후 ReloadSettings 도 이 경로 사용
    return reloadConfigFrom(currentAdkPath);
  },
  onReloadSettings: () => reloadConfigFrom(currentAdkPath),
  diag,
});
const wired = wireAgentUC1({ ingress: grpcServer.ingress, egress: grpcServer.egress, credentials, diag, ...(provider ? { provider } : {}), ...(resolver ? { resolver } : {}), ...(toolExecutor ? { toolExecutor } : {}), ...(memory ? { memory } : {}), ...(defaultConfig ? { defaultConfig } : {}) });
applyDefaultConfig = wired.setDefaultConfig; // 라이브 reload 결선 — 이후 SetWorkspace/ReloadSettings 가 활성 config swap
const { start, drain } = wired;
start?.(); // ingress.onRequest(route) 등록 — gRPC 핸들러가 도메인 req 를 흘린다
const grpcAddr = await grpcServer.start();
// ⚠️ stdout 한 줄 핸드셰이크(데이터 transport 아님) — Rust 가 이 addr 를 읽어 gRPC connect.
process.stdout.write(`GRPC_LISTENING ${grpcAddr}\n`);
process.stderr.write(`[new-naia-agent] grpc ready @${grpcAddr} (${label} provider, config: ${configLabel}, skills: ${skillsLabel}, memory: ${memoryLabel})\n`);

// stdin 닫히면 종료 — ⚠️ 순서: (1) drain(in-flight 턴 save 완료 대기) → (2) memory.close()(store flush)
//   → (3) exit. naia-memory LocalAdapter 는 encode 를 in-memory 버퍼링하고 close() 에서 flush 하므로,
//   진행 중 턴을 안 기다리고 닫으면 마지막 턴 save 가 유실된다(EOF-during-turn 레이스). 격리: 실패해도 종료 진행.
onShutdown = async () => {
  process.exitCode = 0;
  // ⚠️ 강제 종료 안전망을 *최상단*(await 전)에 설치 — drain/close/flush 어디서 hang 해도 종료를 보장한다.
  // (await memory.close() 뒤에 두면 close 가 pending 일 때 도달 못 해 영구 정지.) unref 금지 = 루프 유지.
  // 30s = **종료 grace**. stdin EOF = 클라이언트 *이미 연결 종료* → 이 grace 의 목적은 응답 전달이 아니라
  // in-flight 턴의 save 영속이다. memory recall/save deadline(5s)·정상 턴 지연보다 충분히 커 정당한 작업을
  // 선점하지 않고, 병리적 provider/close hang 이 EOF 종료를 영구정지로 만드는 회귀만 차단한다(원래 진입점은
  // EOF 시 즉시 exit 하며 in-flight 를 버렸음 — 30s grace 는 그보다 강한 보존, 한계 케이스만 best-effort 유실).
  setTimeout(() => process.exit(0), 30000);
  // 각 종료 단계를 독립 try/catch — 한 단계 실패가 다음(특히 stdout flush)을 건너뛰지 않게. close 는
  // *hang* 도 stdout flush 를 막지 못하게 timeout 으로 bound(reject 는 catch, hang 은 race).
  try { if (drain) await drain(); } catch (e) { process.stderr.write(`[new-naia-agent] drain 실패: ${e instanceof Error ? e.message : String(e)}\n`); }
  try { await grpcServer.shutdown(); } catch (e) { process.stderr.write(`[new-naia-agent] grpc shutdown 실패: ${e instanceof Error ? e.message : String(e)}\n`); }
  try {
    if (memory) await Promise.race([memory.close(), new Promise((res) => setTimeout(res, 8000))]);
  } catch (e) { process.stderr.write(`[new-naia-agent] memory flush 실패: ${e instanceof Error ? e.message : String(e)}\n`); }
  // process.exit 는 미flush stdout 쓰기를 끊는다(turn 출력 유실 가능). 빈 write 콜백은 앞선 모든 쓰기가
  // 파이프로 flush 된 뒤 호출 → 그때 종료(순서 보장). drain/close 가 실패·hang 해도 이 줄에 항상 도달.
  process.stdout.write("", () => process.exit(0));
};
// gRPC 서버 종료 = OS(Rust)가 보내는 시그널. drain/flush/grpc-shutdown 수행 후 exit.
process.on("SIGTERM", () => { if (onShutdown) onShutdown(); });
process.on("SIGINT", () => { if (onShutdown) onShutdown(); });
