#!/usr/bin/env node
// agent-stdio-entry — new-naia-agent(brain) 를 **gRPC transport** 로 구동하는 진입점(naia-os 가 spawn → connect).
// transport-독립 런타임 deps 는 compose-agent-deps.mjs(CLI host 와 공유, NFR-CLI-shared) — 여기선 gRPC server +
// panel(환경 위임, egress 필요) + 라이브 reload + 종료(drain/flush) 등 **gRPC host 관심사**만 배선.
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeHostWireRuntime, wireAgentUC1 } from "../../dist/main/composition/index.js";
import { makeCompositeToolExecutor } from "../../dist/main/adapters/composite-tool-executor.js";
import { makePanelToolExecutor } from "../../dist/main/adapters/panel-tool-executor.js";
import { makeGrpcServer } from "../../dist/main/adapters/grpc/grpc-server.js";
import { makeKnowledgeGrounding } from "../../dist/main/adapters/knowledge-grounding.js";
import { makeFileConsentStore } from "../../dist/main/adapters/file-consent-store.js";
import { makeProcessingGuard } from "../../dist/main/adapters/processing-guard.js";
import { ensureCurrentProcessingAuthorized, makeProcessingAwareProvider, makeProcessingAwareResolver, makeProcessingAwareToolExecutor } from "../../dist/main/adapters/processing-operation-decorators.js";
import {
  anthropicBaseUrl,
  labProxyBaseUrl,
  nativeBaseUrl,
  resolveProviderRoute,
} from "../../dist/main/domain/provider-route.js";
import { makeActivityRouteRegistry, makeActivitySpeechEgress } from "../../dist/main/adapters/activity-speech-egress.js";
import { makeActivityRadioDjBgm } from "../../dist/main/adapters/activity-radio-dj-bgm.js";
import { makeExhibitionKnowledge } from "../../dist/main/adapters/exhibition-knowledge.js";
import {
  makeDeterministicRadioDjSelector,
  makeRadioDjContext,
  makeRadioDjPreferenceStore,
  makeSystemProactiveScheduler,
} from "../../dist/main/adapters/radio-dj-runtime.js";
import { PersonalRadioDjController } from "../../dist/main/app/personal-radio-dj-controller.js";
import { ExhibitionIntroController } from "../../dist/main/app/exhibition-intro-controller.js";
import { SpeechProfileRuntime } from "../../dist/main/app/speech-profile-runtime.js";
import {
  makeCompileKnowledge,
  makeKbCompilerBackend,
  readWorkspaceKnowledgeConfig,
} from "../../dist/main/adapters/knowledge-compile.js";
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
const {
  memory, memoryLabel, conversationLog, transcriptLabel, diag, personaSource, workspaceContextSource,
  knowledgeBackend, knowledgeSlot, openKnowledgeForWorkspace,
} = deps;
let skillsLabel = deps.skillsLabel;
const providerEndpoint = (config) => {
  const route = resolveProviderRoute(config);
  if (route === "lab-proxy") return labProxyBaseUrl(config);
  if (route === "ollama") return nativeBaseUrl("ollama", config.ollamaHost);
  if (route === "anthropic") return anthropicBaseUrl(config);
  if (route === "claude-code") return "https://api.anthropic.com";
  return nativeBaseUrl(config.provider, config.labGatewayUrl ?? config.vllmHost);
};
const isLoopback = (url) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0"
      || /^127\./.test(host) || host.endsWith(".localhost");
  } catch { return false; }
};
const processingResolver = resolver ? makeProcessingAwareResolver(resolver, (config) => {
  const endpointUrl = providerEndpoint(config);
  return {
    endpointUrl,
    endpointZone: "unverified",
    requiresConsent: !isLoopback(endpointUrl),
  };
}) : undefined;
const processingProvider = provider ? makeProcessingAwareProvider(provider, {
  endpointUrl: "http://127.0.0.1/fixed-provider",
  endpointZone: "unverified",
  requiresConsent: false,
}) : undefined;

// ★ 라이브 reload(정본 R1-2 "startup-only 금지"): 사용자가 naia-os 에서 모델/프로바이더 교체 시 OS 가
//   naia-settings(config.json) 갱신 후 SetWorkspace/ReloadSettings 재호출 → 여기서 재로딩해 handler 활성 config 를 swap.
//   applyDefaultConfig 는 wireAgentUC1 반환(아래)으로 채워진다 — 클로저가 *호출 시점* 값을 보므로 선언 순서 무관.
let currentAdkPath = adkPath;
const loadTrustedProcessingProfiles = async (path) => {
  try {
    const parsed = JSON.parse(await readFile(join(path, "naia-settings", "processing.json"), "utf8"));
    if (!parsed || typeof parsed !== "object"
      || Reflect.ownKeys(parsed).some((key) => !["version", "profiles", "consents"].includes(String(key)))
      || parsed.version !== 1 || !Array.isArray(parsed.profiles) || parsed.profiles.length > 64
      || !Array.isArray(parsed.consents ?? []) || (parsed.consents ?? []).length > 256) throw new Error();
    const profiles = new Map();
    for (const item of parsed.profiles) {
      if (!item || typeof item !== "object"
        || Reflect.ownKeys(item).some((key) => !["processingProfileRef", "profile"].includes(String(key)))
        || !/^[A-Za-z0-9_-]{1,128}$/.test(item.processingProfileRef)
        || !["local_only", "cloud_enabled", "ask_before_external"].includes(item.profile)
        || profiles.has(item.processingProfileRef)) throw new Error();
      profiles.set(item.processingProfileRef, item.profile);
    }
    return { ok: true, value: { profiles, consents: parsed.consents ?? [] } };
  } catch { return { ok: false }; }
};
const initialProcessingConfig = await loadTrustedProcessingProfiles(adkPath);
const initialTrustedProcessingConfig = initialProcessingConfig.ok
  ? initialProcessingConfig.value
  : { profiles: new Map(), consents: [] };
const makeConsentStore = (path, records) =>
  records.length ? makeFileConsentStore({
    path: join(path, "data-private", "processing", "consumed.json"),
    records,
  }) : undefined;
let initialConsentStore;
try { initialConsentStore = makeConsentStore(adkPath, initialTrustedProcessingConfig.consents); }
catch { initialConsentStore = undefined; }
const initialKnowledgeConfig = await readWorkspaceKnowledgeConfig(adkPath);
let trustedSnapshot = Object.freeze({
  workspace: adkPath,
  providerConfig: defaultConfig,
  credentialGeneration: defaultConfig ? 1 : 0,
  processingConfig: initialTrustedProcessingConfig,
  consentStore: initialConsentStore,
  knowledgeScopes: knowledgeBackend && initialKnowledgeConfig.scope ? [initialKnowledgeConfig.scope] : [],
  knowledgeBackend: knowledgeSlot.snapshot(),
});
let applyDefaultConfig = (_c) => {};
const reloadConfigFrom = async (path) => {
  const c = path ? (settingsStore.loadMain(path) ?? undefined) : undefined;
  const processing = await loadTrustedProcessingProfiles(path);
  if (!c || !processing.ok) return { loaded: false, provider: "", model: "" };
  try {
    const knowledge = await openKnowledgeForWorkspace(path);
    const consentStore = makeConsentStore(path, processing.value.consents);
    const candidate = Object.freeze({
      workspace: path,
      providerConfig: c,
      credentialGeneration: trustedSnapshot.credentialGeneration + 1,
      processingConfig: processing.value,
      consentStore,
      knowledgeScopes: knowledge?.scope ? [knowledge.scope] : [],
      knowledgeBackend: knowledge?.backend,
    });
    knowledgeSlot.swap(knowledge?.backend);
    trustedSnapshot = candidate;
  } catch {
    return { loaded: false, provider: "", model: "" };
  }
  applyDefaultConfig(c);
  process.stderr.write(`[naia-agent] settings reload → ${c ? `${c.provider}/${c.model}` : "none"} (adk=${path})\n`);
  return { loaded: !!c, provider: c?.provider ?? "", model: c?.model ?? "" };
};

// 정본 transport = gRPC (naia-os --gRPC--> naia-agent). os(Rust)가 이 서버에 connect. data 채널은 gRPC 단일.
// SetWorkspace/ReloadSettings = naia-adk/naia-settings 로딩 결과 반환(저장/불러오기 정본).
// UC-PANEL(FR-PANEL): panel executor(환경 도구) 콜백은 late-binding — panelExec 는 egress 확보 후(아래) 생성.
let panelExec;
let activityBgm;
let profileRuntime;
const shellProcessingScope = (snapshot) => `ws_${createHash("sha256")
  .update(String(snapshot.workspace ?? ""))
  .digest("base64url")}`;
const makeBoundProcessingPolicy = (snapshot) => {
  const processingGuard = makeProcessingGuard({
    profiles: { get: (ref) => snapshot.processingConfig.profiles.get(ref) },
    consents: snapshot.consentStore,
  });
  return {
  resolve: (req, operation) => {
    if (!req.processing) return undefined;
    const scope = req.channel?.kind === "discord"
      ? (req.grounding?.knowledgeScope ?? req.channel.bindingId)
      : shellProcessingScope(snapshot);
    const disclosure = processingGuard.authorize({
      scope,
      processingProfileRef: req.processing.processingProfileRef,
      workload: operation.workload,
      provider: { provider: operation.provider ?? "", model: operation.model ?? "" },
      endpoint: {
        url: operation.endpointUrl,
        zone: operation.endpointZone,
      },
      sessionId: req.sessionId ?? req.requestId,
    });
    return { kind: "processingDisclosure", ...disclosure };
  },
  claimConsent: (req, operation, disclosure) => {
    const scope = req.channel?.kind === "discord"
      ? (req.grounding?.knowledgeScope ?? req.channel.bindingId)
      : shellProcessingScope(snapshot);
    return processingGuard.claimConsent({
      scope,
      processingProfileRef: req.processing.processingProfileRef,
      workload: operation.workload,
      destination: disclosure.destination,
      sessionId: req.sessionId ?? req.requestId,
    });
  },
  };
};
const processingPolicy = {
  bind: () => makeBoundProcessingPolicy(trustedSnapshot),
  resolve: (req, operation) => makeBoundProcessingPolicy(trustedSnapshot).resolve(req, operation),
  claimConsent: (req, operation, disclosure) =>
    makeBoundProcessingPolicy(trustedSnapshot).claimConsent(req, operation, disclosure),
};
const groundingPolicy = {
  bind: () => makeKnowledgeGrounding(knowledgeSlot.snapshot()),
  resolve: (req) => makeKnowledgeGrounding(knowledgeSlot.snapshot()).resolve(req),
};
const bindRequestRuntime = () => {
  const snapshot = trustedSnapshot;
  return {
    trustContext: {
      workspace: snapshot.workspace,
      provider: snapshot.providerConfig?.provider,
      model: snapshot.providerConfig?.model,
      credentialGeneration: snapshot.credentialGeneration,
      allowedKnowledgeScopes: snapshot.knowledgeScopes,
    },
    processingPolicy: makeBoundProcessingPolicy(snapshot),
    grounding: makeKnowledgeGrounding(snapshot.knowledgeBackend),
    providerConfig: snapshot.providerConfig,
  };
};
const wireRuntime = makeHostWireRuntime(() => ({
  workspace: trustedSnapshot.workspace,
  config: trustedSnapshot.providerConfig,
  credentialGeneration: trustedSnapshot.credentialGeneration,
  allowedKnowledgeScopes: trustedSnapshot.knowledgeScopes,
}), { grounding: groundingPolicy, processingPolicy });
const grpcServer = makeGrpcServer({
  bindAddr: process.env.NAIA_AGENT_GRPC_ADDR || "127.0.0.1:0",
  onSetWorkspace: (wsPath) => {
    if (wsPath) currentAdkPath = wsPath; // OS 가 워크스페이스 경로 주입 → 이후 ReloadSettings 도 이 경로 사용
    return reloadConfigFrom(currentAdkPath);
  },
  onReloadSettings: () => reloadConfigFrom(currentAdkPath),
  // UC-KNOWLEDGE-COMPILE(FR-KB-5): "지금 컴파일" → 등록 소스 폴더(naia-settings/knowledge.json) → kb.json.
  //   config 읽기=셸 소유 정본(에이전트 읽기전용), 실 backend=kb-compiler(오프라인 결정론). adk_path 미지정=현 워크스페이스.
  onCompileKnowledge: (wsPath) =>
    makeCompileKnowledge({
      readConfig: readWorkspaceKnowledgeConfig,
      backend: makeKbCompilerBackend(),
      diag,
    })(wsPath || currentAdkPath),
  onRegisterPanelSkills: (panelId, tools) => {
    panelExec?.register(panelId, tools);
    profileRuntime?.capabilitiesChanged();
  },                                                                                    // FR-PANEL-1
  onClearPanelSkills: (panelId) => {
    panelExec?.clear(panelId);
    profileRuntime?.capabilitiesChanged();
  },                                                                                    // FR-PANEL-1
  onListSkills: () => toolExecutor?.specs() ?? [],                                      // M2: ListSkills(voice)=composite 전체(builtin+panel, H1 동적 재집계). panel만 반환하던 버그 수정.
  onPanelToolResult: (requestId, toolCallId, output, success, activityId) => {
    panelExec?.resolveResult(requestId, toolCallId, output, success);
    activityBgm?.resolveResult(requestId, activityId, toolCallId, output, success);
  },
  onConfigureSpeechProfile: (profile) => profileRuntime?.configure(profile),
  onSpeechSubscriberChange: (sessionId, ready) => profileRuntime?.subscriberChanged(sessionId, ready),
  onYieldSpeechActivity: (sessionId, activityId) => profileRuntime?.yield(sessionId, activityId) ?? { ok: false },
  onControlSpeechActivity: (sessionId, activityId, action) => profileRuntime?.control(sessionId, activityId, action) ?? false,
  onStopSpeechActivity: (sessionId, activityId) => profileRuntime?.stop(sessionId, activityId),
  trustResolver: wireRuntime.trustResolver,
  providerSessionStore: wireRuntime.providerSessionStore,
  diag,
});
const localToolNames = new Set([
  "get_time", "memo_list", "memo_get", "memo_save",
  "list_dir", "read_file", "write_file",
  "obsidian_list_notes", "obsidian_read_note", "obsidian_search",
  "skill_knowledge_search", "skill_knowledge_ask", "skill_knowledge_graph",
]);
// panel executor 생성(egress 확보 후) + builtin 과 composite 합성. panel 도구 execute()=panel_tool_call emit→PanelToolResult 대기(E1, FR-PANEL-2/3).
panelExec = makePanelToolExecutor({ egress: grpcServer.egress });
toolExecutor = toolExecutor ? makeCompositeToolExecutor([toolExecutor, panelExec]) : panelExec;
toolExecutor = makeProcessingAwareToolExecutor(toolExecutor, (call) => {
  if (localToolNames.has(call.name)) return undefined;
  const known = call.name === "get_weather"
    ? { provider: "openmeteo", model: "weather", endpointUrl: "https://api.open-meteo.com" }
    : call.name.startsWith("github_")
      ? { provider: "github", model: "rest", endpointUrl: "https://api.github.com" }
      : { provider: "unclassified-tool", model: "unknown", endpointUrl: "unclassified:" };
  return {
    operationKey: "tool:pending",
    workload: "network_tool",
    ...known,
    endpointZone: "unverified",
    requiresConsent: true,
  };
});
skillsLabel += " + panel(환경 위임)";
// Issue #82 proactive profiles — persistent activity stream + 좁은 BGM/KB 포트.
const activityRoutes = makeActivityRouteRegistry();
const activitySpeech = makeActivitySpeechEgress(grpcServer.activityEgress, activityRoutes);
activityBgm = makeActivityRadioDjBgm({
  wire: grpcServer.activityEgress,
  routes: activityRoutes,
  specs: () => toolExecutor?.specs() ?? [],
});
const proactiveScheduler = makeSystemProactiveScheduler();
const preferenceStore = makeRadioDjPreferenceStore();
const radioContext = makeRadioDjContext({
  explicitLikes: (sessionId) => preferenceStore.explicitLikes(sessionId),
  fetchWeather: async (latitude, longitude) => {
    await ensureCurrentProcessingAuthorized({
      operationKey: `proactive:weather:${latitude}:${longitude}`,
      workload: "network_tool",
      provider: "openmeteo",
      model: "weather",
      endpointUrl: "https://api.open-meteo.com",
      endpointZone: "unverified",
      requiresConsent: true,
    });
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("current", "temperature_2m,weather_code");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`weather HTTP ${response.status}`);
    const body = await response.json();
    return {
      tempC: Number(body?.current?.temperature_2m),
      code: Number(body?.current?.weather_code),
      observedAt: String(body?.current?.time ?? new Date().toISOString()),
    };
  },
});
const djController = new PersonalRadioDjController({
  scheduler: proactiveScheduler,
  ids: { next: randomUUID },
  context: radioContext,
  selector: makeDeterministicRadioDjSelector(),
  bgm: activityBgm,
  speech: activitySpeech,
  preferences: preferenceStore,
});
const exhibitionController = new ExhibitionIntroController({
  scheduler: proactiveScheduler,
  ids: { activity: randomUUID, resumeToken: randomUUID },
  knowledge: makeExhibitionKnowledge(knowledgeSlot.backend),
  speech: activitySpeech,
});
profileRuntime = new SpeechProfileRuntime({
  dj: djController,
  exhibition: exhibitionController,
  chatEgress: grpcServer.egress,
});
// memory(makeNaiaMemory)는 MemoryPort + CompactionPort 둘 다 구현 → compaction 도 같은 인스턴스 주입(UC-compaction).
// FR-PERSONA-3: personaSource 주입(코어가 워크스페이스 페르소나 조립). naia-os 는 chat_request 에 systemPrompt 를
//   실어 보내므로 그 요청은 override 로 동작(당장 동작변화 없음) — 단 코어가 페르소나를 소유하는 단일 경로로 통일.
const wired = wireAgentUC1({ ingress: grpcServer.ingress, egress: grpcServer.egress, speechProfiles: profileRuntime, credentials, diag, trustResolver: wireRuntime.trustResolver, providerSessionStore: wireRuntime.providerSessionStore, grounding: wireRuntime.grounding, processingPolicy: wireRuntime.processingPolicy, bindRequestRuntime, ...(processingProvider ? { provider: processingProvider } : {}), ...(processingResolver ? { resolver: processingResolver } : {}), ...(toolExecutor ? { toolExecutor } : {}), ...(memory ? { memory } : {}), ...(memory ? { compaction: memory } : {}), ...(conversationLog ? { conversationLog } : {}), ...(personaSource ? { personaSource } : {}), ...(workspaceContextSource ? { workspaceContext: workspaceContextSource } : {}), ...(defaultConfig ? { defaultConfig } : {}) });
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
