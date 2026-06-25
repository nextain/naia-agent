#!/usr/bin/env node
// agent-stdio-entry — new-naia-agent(brain) 를 **gRPC transport** 로 구동하는 진입점(naia-os 가 spawn → connect).
// transport-독립 런타임 deps 는 compose-agent-deps.mjs(CLI host 와 공유, NFR-CLI-shared) — 여기선 gRPC server +
// panel(환경 위임, egress 필요) + 라이브 reload + 종료(drain/flush) 등 **gRPC host 관심사**만 배선.
import { createInterface } from "node:readline";
import { wireAgentUC1 } from "../../dist/main/composition/index.js";
import { makeCompositeToolExecutor } from "../../dist/main/adapters/composite-tool-executor.js";
import { makePanelToolExecutor } from "../../dist/main/adapters/panel-tool-executor.js";
import { makeGrpcServer } from "../../dist/main/adapters/grpc/grpc-server.js";
import { composeAgentRuntimeDeps } from "./compose-agent-deps.mjs";

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
let onShutdown = null;
// 종료 시 정리할 자원(자식 프로세스·소켓 등) 핸들 — compose 후 deps.cleanupFns 로 교체(최상단 핸들러가 정리, F2).
let cleanupFns = [];
// ⚠️ gRPC transport: stdin 은 데이터 채널 아님 → stdin EOF 는 종료 신호가 아니다(서버는 SIGTERM/SIGINT 까지 생존).
rl.on("close", () => { /* no-op — gRPC 모드: EOF≠shutdown */ });

// ── transport-독립 런타임 deps = 공유 빌더(CLI host 와 literally 동일, NFR-CLI-shared) ──
const deps = await composeAgentRuntimeDeps();
cleanupFns = deps.cleanupFns;
const { adkPath, provider, resolver, providerLabel: label, credentials, settingsStore, defaultConfig, configLabel } = deps;
let { toolExecutor } = deps;
const { memory, memoryLabel, conversationLog, transcriptLabel, diag } = deps;
let skillsLabel = deps.skillsLabel;

// ★ 라이브 reload(정본 R1-2 "startup-only 금지"): 사용자가 naia-os 에서 모델/프로바이더 교체 시 OS 가
//   naia-settings(config.json) 갱신 후 SetWorkspace/ReloadSettings 재호출 → 여기서 재로딩해 handler 활성 config 를 swap.
//   applyDefaultConfig 는 wireAgentUC1 반환(아래)으로 채워진다 — 클로저가 *호출 시점* 값을 보므로 선언 순서 무관.
let currentAdkPath = adkPath;
let applyDefaultConfig = (_c) => {};
const reloadConfigFrom = (path) => {
  const c = path ? (settingsStore.loadMain(path) ?? undefined) : undefined;
  applyDefaultConfig(c);
  process.stderr.write(`[naia-agent] settings reload → ${c ? `${c.provider}/${c.model}` : "none"} (adk=${path})\n`);
  return { loaded: !!c, provider: c?.provider ?? "", model: c?.model ?? "" };
};

// 정본 transport = gRPC (naia-os --gRPC--> naia-agent). os(Rust)가 이 서버에 connect. data 채널은 gRPC 단일.
// SetWorkspace/ReloadSettings = naia-adk/naia-settings 로딩 결과 반환(저장/불러오기 정본).
// UC-PANEL(FR-PANEL): panel executor(환경 도구) 콜백은 late-binding — panelExec 는 egress 확보 후(아래) 생성.
let panelExec;
const grpcServer = makeGrpcServer({
  bindAddr: process.env.NAIA_AGENT_GRPC_ADDR || "127.0.0.1:0",
  onSetWorkspace: (wsPath) => {
    if (wsPath) currentAdkPath = wsPath; // OS 가 워크스페이스 경로 주입 → 이후 ReloadSettings 도 이 경로 사용
    return reloadConfigFrom(currentAdkPath);
  },
  onReloadSettings: () => reloadConfigFrom(currentAdkPath),
  onRegisterPanelSkills: (panelId, tools) => panelExec?.register(panelId, tools),       // FR-PANEL-1
  onClearPanelSkills: (panelId) => panelExec?.clear(panelId),                           // FR-PANEL-1
  onListSkills: () => toolExecutor?.specs() ?? [],                                      // M2: ListSkills(voice)=composite 전체(builtin+panel, H1 동적 재집계). panel만 반환하던 버그 수정.
  onPanelToolResult: (requestId, toolCallId, output, success) => panelExec?.resolveResult(requestId, toolCallId, output, success), // FR-PANEL-3 (H2: requestId+toolCallId)
  diag,
});
// panel executor 생성(egress 확보 후) + builtin 과 composite 합성. panel 도구 execute()=panel_tool_call emit→PanelToolResult 대기(E1, FR-PANEL-2/3).
panelExec = makePanelToolExecutor({ egress: grpcServer.egress });
toolExecutor = toolExecutor ? makeCompositeToolExecutor([toolExecutor, panelExec]) : panelExec;
skillsLabel += " + panel(환경 위임)";
// memory(makeNaiaMemory)는 MemoryPort + CompactionPort 둘 다 구현 → compaction 도 같은 인스턴스 주입(UC-compaction).
const wired = wireAgentUC1({ ingress: grpcServer.ingress, egress: grpcServer.egress, credentials, diag, ...(provider ? { provider } : {}), ...(resolver ? { resolver } : {}), ...(toolExecutor ? { toolExecutor } : {}), ...(memory ? { memory } : {}), ...(memory ? { compaction: memory } : {}), ...(conversationLog ? { conversationLog } : {}), ...(defaultConfig ? { defaultConfig } : {}) });
applyDefaultConfig = wired.setDefaultConfig; // 라이브 reload 결선 — 이후 SetWorkspace/ReloadSettings 가 활성 config swap
const { start, drain } = wired;
start?.(); // ingress.onRequest(route) 등록 — gRPC 핸들러가 도메인 req 를 흘린다
// ⚠️ gRPC bind 실패(포트 점유·잘못된 NAIA_AGENT_GRPC_ADDR·DNS·권한)는 부팅의 유일한 비방어 await 였다 →
//   raw 스택 크래시(재감사 2026-06-23 HIGH). 정직 메시지 + 깔끔한 exit(1)로 감싼다(동적 import 격리와 동일 규율).
let grpcAddr;
try {
  grpcAddr = await grpcServer.start();
} catch (e) {
  process.stderr.write(`[naia-agent] gRPC 시작 실패(주소: ${process.env.NAIA_AGENT_GRPC_ADDR ?? "기본"}): ${e instanceof Error ? e.message : String(e)}\n`);
  for (const fn of cleanupFns) { try { fn(); } catch { /* best-effort */ } }
  process.exit(1);
}
// ⚠️ stdout 한 줄 핸드셰이크(데이터 transport 아님) — Rust 가 이 addr 를 읽어 gRPC connect.
process.stdout.write(`GRPC_LISTENING ${grpcAddr}\n`);
process.stderr.write(`[naia-agent] grpc ready @${grpcAddr} (${label} provider, config: ${configLabel}, skills: ${skillsLabel}, memory: ${memoryLabel}, transcript: ${transcriptLabel})\n`);

// stdin 닫히면 종료 — ⚠️ 순서: (1) drain(in-flight 턴 save 완료 대기) → (2) memory.close()(store flush)
//   → (3) exit. naia-memory LocalAdapter 는 encode 를 in-memory 버퍼링하고 close() 에서 flush 하므로,
//   진행 중 턴을 안 기다리고 닫으면 마지막 턴 save 가 유실된다(EOF-during-turn 레이스). 격리: 실패해도 종료 진행.
onShutdown = async () => {
  process.exitCode = 0;
  // ⚠️ 강제 종료 안전망을 *최상단*(await 전)에 설치 — drain/close/flush 어디서 hang 해도 종료를 보장한다.
  setTimeout(() => process.exit(0), 30000);
  try { if (drain) await drain(); } catch (e) { process.stderr.write(`[naia-agent] drain 실패: ${e instanceof Error ? e.message : String(e)}\n`); }
  try { await grpcServer.shutdown(); } catch (e) { process.stderr.write(`[naia-agent] grpc shutdown 실패: ${e instanceof Error ? e.message : String(e)}\n`); }
  // F2: MCP 자식 등 등록된 자원 정리(고아 누적 방지). 각 독립 try — 한 개 실패가 나머지/exit 를 막지 않게.
  for (const fn of cleanupFns) { try { fn(); } catch (e) { process.stderr.write(`[naia-agent] cleanup 실패: ${e instanceof Error ? e.message : String(e)}\n`); } }
  try {
    if (memory) await Promise.race([memory.close(), new Promise((res) => setTimeout(res, 8000))]);
  } catch (e) { process.stderr.write(`[naia-agent] memory flush 실패: ${e instanceof Error ? e.message : String(e)}\n`); }
  // process.exit 는 미flush stdout 쓰기를 끊는다(turn 출력 유실 가능). 빈 write 콜백은 앞선 모든 쓰기가
  // 파이프로 flush 된 뒤 호출 → 그때 종료(순서 보장). drain/close 가 실패·hang 해도 이 줄에 항상 도달.
  process.stdout.write("", () => process.exit(0));
};
// gRPC 서버 종료 = OS(Rust)가 보내는 시그널. drain/flush/grpc-shutdown 수행 후 exit.
process.on("SIGTERM", () => { if (onShutdown) onShutdown(); });
process.on("SIGINT", () => { if (onShutdown) onShutdown(); });
// ⚠️ 최후 백스톱(재감사 2026-06-23): 부팅/런타임의 잡히지 않은 reject/throw 가 raw 스택 크래시로 새지 않게 —
//   정직 메시지 남기고 자원 정리 후 종료. 정상 경로는 각자 try/catch 로 처리되며 여긴 그물망이다.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[naia-agent] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
  for (const fn of cleanupFns) { try { fn(); } catch { /* best-effort */ } }
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[naia-agent] uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  for (const fn of cleanupFns) { try { fn(); } catch { /* best-effort */ } }
  process.exit(1);
});
