#!/usr/bin/env node
// agent-stdio-entry — new-naia-agent(brain) 를 **gRPC transport** 로 구동하는 진입점(naia-os 가 spawn → connect).
// transport-독립 런타임 deps 는 compose-agent-deps.mjs(CLI host 와 공유, NFR-CLI-shared) — 여기선 gRPC server +
// panel(환경 위임, egress 필요) + 라이브 reload + 종료(drain/flush) 등 **gRPC host 관심사**만 배선.
// gRPC host에서 stdin은 일반 명령 transport가 아니다. Shell이 이 자식 전용 익명 파이프에 토큰 원문만
// 한 번 쓰고 즉시 닫는다. line protocol과 섞지 않으며 argv/env/config 파일에도 토큰을 남기지 않는다.
const discordTokenFromSecretPipe = process.env.NAIA_DISCORD_TOKEN_PIPE === "stdin"
  ? new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), 10_000);
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > 512) {
        finish(undefined);
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once("end", () => {
      const token = Buffer.concat(chunks).toString("utf8");
      finish(token.length >= 1 && token.length <= 512 ? token : undefined);
    });
    process.stdin.once("error", () => finish(undefined));
  })
  : Promise.resolve(undefined);
delete process.env.NAIA_DISCORD_TOKEN_PIPE;
let onShutdown = null;
// 종료 시 정리할 자원(자식 프로세스·소켓 등) 핸들 — compose 후 deps.cleanupFns 로 교체(최상단 핸들러가 정리, F2).
let cleanupFns = [];

// 개인 Discord bot credential은 host(Shell keychain)가 시작 직후 secret-only 익명 파이프로 주입한다.
// 환경변수·일반 설정·파일에는 평문 토큰을 두지 않는다. gRPC 모드의 stdin은 데이터 transport가 아니므로
// 토큰 바이트를 소비한 뒤 EOF가 와도 런타임은 계속 생존한다.
const discordToken = await discordTokenFromSecretPipe;
// Secret pipe read/close must finish before any runtime module is evaluated. This keeps
// provider/tool composition and every later child process outside the secret fd lifetime.
const { randomUUID } = await import("node:crypto");
const { join } = await import("node:path");
const { wireAgentUC1 } = await import("../../dist/main/composition/index.js");
const { makeCompositeAgentIngress, makePrefixedAgentEgress } =
  await import("../../dist/main/adapters/agent-transport-mux.js");
const { DiscordChannelRuntime, makeSystemDiscordClock, parseDiscordRuntimeConfig } =
  await import("../../dist/main/adapters/discord-channel.js");
const { makeFileDiscordDedupe } =
  await import("../../dist/main/adapters/discord-dedupe-store.js");
const { makeDiscordGateway } =
  await import("../../dist/main/adapters/discord-gateway.js");
const { makeDiscordRuntimeText } =
  await import("../../dist/main/adapters/discord-messages.js");
const { makeFileDiscordRegistration } =
  await import("../../dist/main/adapters/discord-registration-store.js");
const { makeFileDiscordConsentStore } =
  await import("../../dist/main/adapters/discord-consent-store.js");
const { makeDiscordStatusFile } =
  await import("../../dist/main/adapters/discord-status-file.js");
const { makeDiscordGenerationAuthority } =
  await import("../../dist/main/adapters/discord-generation-authority.js");
const { makeFileDiscordInbox } =
  await import("../../dist/main/adapters/discord-inbox-store.js");
const { makeProcessingGuard } =
  await import("../../dist/main/adapters/processing-guard.js");
const {
  anthropicBaseUrl,
  isLocalEngineBaseUrl,
  labProxyBaseUrl,
  nativeBaseUrl,
  resolveProviderRoute,
} = await import("../../dist/main/domain/provider-route.js");
const { makeCompositeToolExecutor } =
  await import("../../dist/main/adapters/composite-tool-executor.js");
const { makePanelToolExecutor } =
  await import("../../dist/main/adapters/panel-tool-executor.js");
const { makeGrpcServer } =
  await import("../../dist/main/adapters/grpc/grpc-server.js");
const { makeActivityRouteRegistry, makeActivitySpeechEgress } =
  await import("../../dist/main/adapters/activity-speech-egress.js");
const { makeActivityRadioDjBgm } =
  await import("../../dist/main/adapters/activity-radio-dj-bgm.js");
const { makeExhibitionKnowledge } =
  await import("../../dist/main/adapters/exhibition-knowledge.js");
const {
  makeDeterministicRadioDjSelector,
  makeRadioDjContext,
  makeRadioDjPreferenceStore,
  makeSystemProactiveScheduler,
} = await import("../../dist/main/adapters/radio-dj-runtime.js");
const { PersonalRadioDjController } =
  await import("../../dist/main/app/personal-radio-dj-controller.js");
const { ExhibitionIntroController } =
  await import("../../dist/main/app/exhibition-intro-controller.js");
const { SpeechProfileRuntime } =
  await import("../../dist/main/app/speech-profile-runtime.js");
const {
  makeCompileKnowledge,
  makeKbCompilerBackend,
  readWorkspaceKnowledgeConfig,
} = await import("../../dist/main/adapters/knowledge-compile.js");
const { composeAgentRuntimeDeps } = await import("./compose-agent-deps.mjs");

// ── transport-독립 런타임 deps = 공유 빌더(CLI host 와 literally 동일, NFR-CLI-shared) ──
const deps = await composeAgentRuntimeDeps();
cleanupFns = deps.cleanupFns;
const { adkPath, provider, resolver, providerLabel: label, credentials, settingsStore, defaultConfig, configLabel } = deps;
let { toolExecutor } = deps;
const { memory, memoryLabel, conversationLog, transcriptLabel, diag, personaSource, workspaceContextSource, knowledgeBackend } = deps;
let skillsLabel = deps.skillsLabel;

let discordConfig;
const discordBindingsProvided = Boolean(process.env.NAIA_DISCORD_BINDINGS_JSON);
if (process.env.NAIA_DISCORD_BINDINGS_JSON) {
  try { discordConfig = parseDiscordRuntimeConfig(JSON.parse(process.env.NAIA_DISCORD_BINDINGS_JSON)); }
  catch { discordConfig = undefined; }
}
delete process.env.NAIA_DISCORD_BINDINGS_JSON;
let discordRegistrationSeeds;
if (process.env.NAIA_DISCORD_REGISTRATIONS_JSON) {
  try { discordRegistrationSeeds = JSON.parse(process.env.NAIA_DISCORD_REGISTRATIONS_JSON); }
  catch { discordRegistrationSeeds = undefined; }
}
delete process.env.NAIA_DISCORD_REGISTRATIONS_JSON;
let discordConsentRecords;
if (process.env.NAIA_DISCORD_CONSENTS_JSON) {
  try { discordConsentRecords = JSON.parse(process.env.NAIA_DISCORD_CONSENTS_JSON); }
  catch { discordConsentRecords = undefined; }
}
delete process.env.NAIA_DISCORD_CONSENTS_JSON;
const discordGeneration = process.env.NAIA_DISCORD_GENERATION;
const discordStatusPath = process.env.NAIA_DISCORD_STATUS_PATH;
const discordAuthorityPath = process.env.NAIA_DISCORD_AUTHORITY_PATH;
const discordInboxPath = process.env.NAIA_DISCORD_INBOX_PATH;
delete process.env.NAIA_DISCORD_GENERATION;
delete process.env.NAIA_DISCORD_STATUS_PATH;
delete process.env.NAIA_DISCORD_AUTHORITY_PATH;
delete process.env.NAIA_DISCORD_INBOX_PATH;
let discordStatus;
let discordAuthority;
if (discordGeneration && discordStatusPath && discordAuthorityPath) {
  try {
    discordStatus = makeDiscordStatusFile({ generation: discordGeneration, path: discordStatusPath });
    discordAuthority = makeDiscordGenerationAuthority({
      generation: discordGeneration,
      path: discordAuthorityPath,
    });
    discordStatus.write("starting");
  } catch {
    discordStatus = undefined;
  }
}

// ★ 라이브 reload(정본 R1-2 "startup-only 금지"): 사용자가 naia-os 에서 모델/프로바이더 교체 시 OS 가
//   naia-settings(config.json) 갱신 후 SetWorkspace/ReloadSettings 재호출 → 여기서 재로딩해 handler 활성 config 를 swap.
//   applyDefaultConfig 는 wireAgentUC1 반환(아래)으로 채워진다 — 클로저가 *호출 시점* 값을 보므로 선언 순서 무관.
let currentAdkPath = adkPath;
let activeProcessingConfig = defaultConfig;
let activeMemoryProcessingConfig = currentAdkPath ? settingsStore.loadMemoryConfig(currentAdkPath) : null;
let applyDefaultConfig = (_c) => {};
const reloadConfigFrom = (path) => {
  const c = path ? (settingsStore.loadMain(path) ?? undefined) : undefined;
  activeProcessingConfig = c;
  activeMemoryProcessingConfig = path ? settingsStore.loadMemoryConfig(path) : null;
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
  diag,
});
let discordRuntime;
let processingGuard;
let discordStatusPoll;
if (discordToken && discordConfig && discordAuthority) {
  try {
    const dedupePath = process.env.NAIA_DISCORD_DEDUPE_PATH
      || join(currentAdkPath || process.cwd(), "data-private", "discord", "dedupe.json");
    const registration = Array.isArray(discordRegistrationSeeds) && discordRegistrationSeeds.length
      ? makeFileDiscordRegistration({
        path: process.env.NAIA_DISCORD_REGISTRATION_STATE_PATH
          || join(currentAdkPath || process.cwd(), "data-private", "discord", "registrations.json"),
        seeds: discordRegistrationSeeds,
      })
      : undefined;
    const consents = Array.isArray(discordConsentRecords) && discordConsentRecords.length
      ? makeFileDiscordConsentStore({
        path: process.env.NAIA_DISCORD_CONSENT_STATE_PATH
          || join(currentAdkPath || process.cwd(), "data-private", "discord", "consents.json"),
        records: discordConsentRecords,
      })
      : undefined;
    discordRuntime = new DiscordChannelRuntime({
      gateway: makeDiscordGateway(),
      token: { load: async () => discordToken },
      dedupe: makeFileDiscordDedupe({ path: dedupePath }),
      ...(discordInboxPath && discordGeneration
        ? { inbox: makeFileDiscordInbox({ path: discordInboxPath, generation: discordGeneration }) }
        : {}),
      ...(registration ? { registration } : {}),
      authority: discordAuthority,
      clock: makeSystemDiscordClock(),
      text: makeDiscordRuntimeText(process.env.NAIA_DISCORD_LOCALE === "en" ? "en" : "ko"),
      diag,
    }, discordConfig);
    const endpointFor = (config) => {
      const route = resolveProviderRoute(config);
      if (route === "lab-proxy") return labProxyBaseUrl(config);
      if (route === "ollama") return nativeBaseUrl("ollama", config.ollamaHost);
      if (route === "anthropic" || route === "claude-code") return anthropicBaseUrl(config);
      return nativeBaseUrl(config.provider, config.labGatewayUrl || config.vllmHost);
    };
    processingGuard = makeProcessingGuard({
      profiles: { get: (ref) => discordConfig.processingProfiles?.[ref] },
      endpoints: {
        resolve: (provider, workload) => {
          if (workload === "memory_llm" || workload === "sub_llm") {
            const memoryLlm = activeMemoryProcessingConfig?.llm;
            if (!memoryLlm || memoryLlm.provider === "none") {
              return {
                url: "unix:/naia-memory-heuristic",
                zone: "unverified",
                provider: "none",
                model: "heuristic",
              };
            }
            if (!memoryLlm.baseUrl) return undefined;
            return {
              url: memoryLlm.baseUrl,
              zone: isLocalEngineBaseUrl(memoryLlm.baseUrl) ? "private_managed" : "unverified",
              provider: memoryLlm.provider,
              model: memoryLlm.model || "unknown",
            };
          }
          if (workload === "embedding") {
            const embedding = activeMemoryProcessingConfig?.embedding;
            if (!embedding || embedding.provider === "none" || embedding.provider === "offline") {
              return {
                url: "unix:/naia-memory-embedding",
                zone: "unverified",
                provider: embedding?.provider || "none",
                model: embedding?.offlineModel || "keyword",
              };
            }
            const url = embedding.baseUrl || embedding.naiaGatewayUrl;
            if (!url) return undefined;
            return {
              url,
              zone: isLocalEngineBaseUrl(url) ? "private_managed" : "unverified",
              provider: embedding.provider,
              model: embedding.model || "unknown",
            };
          }
          if (workload === "network_tool") {
            const processing = toolExecutor?.specs().find((spec) =>
              spec.processing?.workload === "network_tool"
              && spec.processing.provider === provider.provider
              && spec.processing.model === provider.model)?.processing;
            if (!processing) return undefined;
            return {
              destination: processing.destination,
              zone: "unverified",
              provider: processing.provider,
              model: processing.model,
            };
          }
          const config = activeProcessingConfig;
          if (!config || config.provider !== provider.provider || config.model !== provider.model) return undefined;
          const url = endpointFor(config);
          const localEngine = isLocalEngineBaseUrl(url);
          const loopback = /^(?:https?:\/\/)?(?:localhost|127\.|\[?::1\]?)/i.test(url);
          return {
            url,
            zone: localEngine && !loopback ? "private_managed" : "unverified",
            provider: config.provider,
            model: config.model,
          };
        },
      },
      ...(consents ? { consents } : {}),
    });
  } catch {
    diag.log("discord runtime", { code: "configuration_failed" });
    try { discordStatus?.write("failed", "configuration_failed"); } catch { /* status observer isolation */ }
  }
} else if (discordToken || discordBindingsProvided) {
  const code = !discordToken ? "token_unavailable"
    : !discordConfig ? "bindings_invalid"
    : "authority_invalid";
  diag.log("discord runtime", { code });
  try { discordStatus?.write("failed", code); } catch { /* observer isolation */ }
}
// panel executor 생성(egress 확보 후) + builtin 과 composite 합성. panel 도구 execute()=panel_tool_call emit→PanelToolResult 대기(E1, FR-PANEL-2/3).
panelExec = makePanelToolExecutor({ egress: grpcServer.egress });
toolExecutor = toolExecutor ? makeCompositeToolExecutor([toolExecutor, panelExec]) : panelExec;
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
  knowledge: makeExhibitionKnowledge(knowledgeBackend),
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
const agentIngress = discordRuntime
  ? makeCompositeAgentIngress([grpcServer.ingress, discordRuntime.ingress])
  : grpcServer.ingress;
const agentEgress = discordRuntime
  ? makePrefixedAgentEgress([{ prefix: "discord:", egress: discordRuntime.egress }], grpcServer.egress)
  : grpcServer.egress;
const wired = wireAgentUC1({ ingress: agentIngress, egress: agentEgress, speechProfiles: profileRuntime, credentials, diag, ...(provider ? { provider } : {}), ...(resolver ? { resolver } : {}), ...(processingGuard ? { processingGuard } : {}), ...(toolExecutor ? { toolExecutor } : {}), ...(memory ? { memory } : {}), ...(memory ? { compaction: memory } : {}), ...(conversationLog ? { conversationLog } : {}), ...(personaSource ? { personaSource } : {}), ...(workspaceContextSource ? { workspaceContext: workspaceContextSource } : {}), ...(defaultConfig ? { defaultConfig } : {}) });
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
discordRuntime?.start();
if (discordRuntime && discordStatus) {
  let previous;
  discordStatusPoll = setInterval(() => {
    const status = discordRuntime.status();
    const nativeState = status.state === "ready"
      ? (status.authoritative ? "ready" : "standby")
      : status.state === "terminal_error" ? "failed" : "starting";
    const observation = `${nativeState}:${status.partialReplies}`;
    if (observation === previous) return;
    previous = observation;
    try {
      discordStatus.write(
        nativeState,
        nativeState === "failed" ? "runtime_terminal" : undefined,
        status.partialReply,
      );
    }
    catch { /* native supervisor will time out and reconcile */ }
  }, 50);
}
process.stderr.write(`[naia-agent] grpc ready @${grpcAddr} (${label} provider, config: ${configLabel}, skills: ${skillsLabel}, memory: ${memoryLabel}, transcript: ${transcriptLabel}, discord: ${discordRuntime ? "enabled" : "disabled"})\n`);

// stdin 닫히면 종료 — ⚠️ 순서: (1) drain(in-flight 턴 save 완료 대기) → (2) memory.close()(store flush)
//   → (3) exit. naia-memory LocalAdapter 는 encode 를 in-memory 버퍼링하고 close() 에서 flush 하므로,
//   진행 중 턴을 안 기다리고 닫으면 마지막 턴 save 가 유실된다(EOF-during-turn 레이스). 격리: 실패해도 종료 진행.
onShutdown = async () => {
  process.exitCode = 0;
  // ⚠️ 강제 종료 안전망을 *최상단*(await 전)에 설치 — drain/close/flush 어디서 hang 해도 종료를 보장한다.
  setTimeout(() => process.exit(0), 30000);
  if (discordStatusPoll) clearInterval(discordStatusPoll);
  try { await discordRuntime?.stop(); } catch { diag.log("discord runtime", { code: "shutdown_failed" }); }
  try { discordStatus?.write("stopped"); } catch { /* native supervisor reconciles */ }
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
