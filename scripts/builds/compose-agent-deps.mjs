// compose-agent-deps — naia-agent(brain) 의 **transport-독립 런타임 deps** 단일 조립기.
// gRPC host(agent-stdio-entry.mjs)와 CLI host(bin/naia-agent-chat.mjs)가 **둘 다 이 함수**로 deps 를
// 만들어 같은 `wireAgentUC1` 에 주입한다 → 두 경로가 literally 동일 파이프라인(NFR-CLI-shared, 병렬 금지).
// 여기서 만드는 것: provider(resolver/fake) · credentials(keychain) · naia-settings(defaultConfig) ·
//   toolExecutor(builtin+composite, **panel 제외**=gRPC 전용) · memory(naia-memory) · conversationLog(transcript) · diag.
// transport(stdin/stdout/readline/grpc)·panel(환경 위임, egress 필요)·shutdown 은 각 host 의 관심사 → 여기 없음.
import { createInterface } from "node:readline";
import { makeProviderResolver } from "../../dist/main/adapters/provider-resolver.js";
import { makeFakeProvider, makeSystemEchoProvider } from "../../dist/main/adapters/fake-provider.js";
import { makeKeychainCredentials } from "../../dist/main/adapters/keychain-secret-store.js";
import { makeNaiaSettingsStore } from "../../dist/main/adapters/naia-settings-store.js";
import { buildSubLlmProvider } from "../../dist/main/adapters/sub-llm-provider.js";
import { makeStderrDiagnostic } from "../../dist/main/adapters/diagnostic.js";
import { makeBuiltinSkillsExecutor } from "../../dist/main/adapters/builtin-skills.js";
import { makeGithubSkillsExecutor } from "../../dist/main/adapters/github-skills.js";
import { makeObsidianSkillsExecutor } from "../../dist/main/adapters/obsidian-skills.js";
import { makeMcpSkillsExecutor } from "../../dist/main/adapters/mcp-skills.js";
import { makeMcpJsonRpcClient } from "../../dist/main/adapters/mcp-stdio-transport.js";
import { makeCompositeToolExecutor } from "../../dist/main/adapters/composite-tool-executor.js";
import { makeNotifyExecutor } from "../../dist/main/adapters/notify-skills.js";
import { makeAdkSkillExecutor, parseSkillMd } from "../../dist/main/adapters/adk-skill-loader.js";
import { makeOpenMeteoFetchWeather } from "../../dist/main/adapters/openmeteo-weather.js";
import { makeFileMemoStore } from "../../dist/main/adapters/file-memo-store.js";
import { makeFileConversationLog } from "../../dist/main/adapters/conversation-log-store.js";
// ⚠️ makeNaiaMemory(→@nextain/naia-memory)는 *동적* import(아래) — 정적이면 모듈 로딩 실패 시 NAIA_AGENT_MEMORY=off
// 나 try/catch 에 도달 못 하고 프로세스가 죽어 메모리 비활성 채팅(FR-MEM-3)·초기화 격리 계약이 깨진다.
import * as nodeFs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * transport-독립 런타임 deps 조립(async — memory 동적 import + MCP init 때문).
 * @param {object} [o]
 * @param {NodeJS.ProcessEnv} [o.env] — 기본 process.env. (NAIA_ADK_PATH/AGENT_PROVIDER/NAIA_AGENT_SKILLS/MEMORY/TRANSCRIPT/DEBUG 등)
 * @returns deps + 라벨 + cleanupFns + settingsStore/adkPath(호스트의 reload 배선용).
 */
export async function composeAgentRuntimeDeps(o = {}) {
  const env = o.env ?? process.env;
  const cleanupFns = []; // 종료 시 정리(MCP 자식 등) — 호스트 shutdown 이 호출.

  // ── provider 해석: 기본 = config-driven resolver(naia-settings→셸→req.provider+creds_update 로 lab-proxy/native/ollama
  //    라우팅). AGENT_PROVIDER=fake → 헤드리스 결정론 fake(E2E·LLM 불요). echo-system → recall→inject 관통 검증용. ──
  const ap = env.AGENT_PROVIDER;
  let provider, resolver, providerLabel;
  if (ap === "fake") { provider = makeFakeProvider(); providerLabel = "fake(headless)"; }
  else if (ap === "echo-system") { provider = makeSystemEchoProvider(); providerLabel = "echo-system(e2e)"; }
  else { resolver = makeProviderResolver(); providerLabel = "config-driven resolver(lab-proxy/native/ollama)"; }

  // ADK 워크스페이스 경로 — 단일 device workspace(1기기=1설정=단일 워크스페이스). 우선순위:
  //   NAIA_ADK_PATH env > 전역 config(~/.naia-agent/config.json adkPath) > 기본 ~/naia-adk(bootstrap 폴백).
  // 전역 config 가 CLI standalone 의 SoT — 모든 진입점(chat/gRPC host)이 같은 워크스페이스에서 LLM/설정 로딩.
  // ⚠️ 기본 ~/naia-adk 폴백은 silent-divergence 원인(다른 복제본 가리킘) — 사용 시 경고로 가시화.
  const DEFAULT_ADK = join(homedir(), "naia-adk");
  let globalAdk;
  try {
    const parsed = JSON.parse(nodeFs.readFileSync(join(homedir(), ".naia-agent", "config.json"), "utf8"));
    if (typeof parsed?.adkPath === "string" && parsed.adkPath.length > 0) globalAdk = parsed.adkPath;
  } catch { /* 전역 config 없음/손상 = 폴백 */ }
  const adkPath = env.NAIA_ADK_PATH || globalAdk || DEFAULT_ADK;
  if (!env.NAIA_ADK_PATH && !globalAdk) {
    process.stderr.write(`[naia-agent] ⚠ 워크스페이스 미설정 — 기본(${DEFAULT_ADK}) 폴백. 'naia-agent-chat workspace <path>' 로 단일 device 워크스페이스 고정 권장(1기기=1설정).\n`);
  }
  let skillsCfg = {};
  try { skillsCfg = JSON.parse(nodeFs.readFileSync(join(adkPath, "naia-settings", "skills.json"), "utf8")); } catch { /* 없음 = env 폴백 */ }

  // ── UC5 실 스킬(time/weather/memo + github/obsidian/mcp/notify/adk) — 기본 활성(NAIA_AGENT_SKILLS=off 로 비활성). ──
  // ⚠️ panel(환경 위임)은 여기 미포함 — egress 가 필요해 gRPC host 가 wire 후 합성(브라우저/BGM=셸 소유 환경, E1).
  let toolExecutor, skillsLabel = "off";
  if (env.NAIA_AGENT_SKILLS !== "off") {
    const memoPath = env.NAIA_MEMO_PATH || join(homedir(), ".naia-agent", "memos.json");
    const memo = makeFileMemoStore({ path: memoPath, dir: dirname(memoPath), fs: nodeFs });
    const builtin = makeBuiltinSkillsExecutor({ clock: () => new Date(), fetchWeather: makeOpenMeteoFetchWeather(), memo });
    skillsLabel = `time/weather/memo(${memoPath})`;
    const executors = [builtin];
    const ghToken = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (ghToken) { executors.push(makeGithubSkillsExecutor({ token: ghToken })); skillsLabel += " + github(ro)"; }
    const vault = env.NAIA_OBSIDIAN_VAULT;
    if (vault) { executors.push(makeObsidianSkillsExecutor({ vaultDir: vault, fs: nodeFs })); skillsLabel += " + obsidian(ro)"; }
    const mcpCmd = env.NAIA_MCP_CMD;
    if (mcpCmd) {
      try {
        const parts = mcpCmd.trim().split(/\s+/);
        const mcpName = env.NAIA_MCP_NAME || "mcp";
        const child = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
        const mrl = createInterface({ input: child.stdout });
        let mcb = null;
        mrl.on("line", (l) => mcb?.(l));
        const channel = { send: (line) => child.stdin.write(line + "\n"), onLine: (cb) => { mcb = cb; return () => { mcb = null; }; }, close: () => { try { child.kill(); } catch { /* noop */ } } };
        const transport = makeMcpJsonRpcClient(channel);
        const mcpExec = await makeMcpSkillsExecutor({ transport, serverName: mcpName, initTimeoutMs: 30000 });
        executors.push(mcpExec);
        cleanupFns.push(channel.close);
        skillsLabel += ` + mcp:${mcpName}(${mcpExec.specs().length})`;
      } catch (e) {
        process.stderr.write(`[naia-agent] MCP init 실패(격리, MCP 없이 진행): ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    const notifyUrls = (skillsCfg && typeof skillsCfg === "object" && skillsCfg.notify && typeof skillsCfg.notify === "object") ? skillsCfg.notify : {};
    const notifyWebhookUrl = async (target) => notifyUrls[target] ?? env[`NAIA_NOTIFY_${target.toUpperCase()}_WEBHOOK`] ?? null;
    const anyNotify = ["slack", "discord", "google_chat"].some((t) => notifyUrls[t] || env[`NAIA_NOTIFY_${t.toUpperCase()}_WEBHOOK`]);
    if (anyNotify) {
      const notifyPost = async (url, body, signal) => {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
        return { ok: r.ok, status: r.status };
      };
      executors.push(makeNotifyExecutor({ post: notifyPost, webhookUrl: notifyWebhookUrl }));
      skillsLabel += " + notify";
    }
    // naia-adk 동적 스킬(SKILL.md) — 정의=naia-adk 워크스페이스 / 실행=agent. 본문(절차)을 도구 output 으로(프롬프트 주입형).
    const adkSkills = [];
    try {
      const skillsDir = join(adkPath, ".agents", "skills");
      for (const ent of nodeFs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        try {
          const parsed = parseSkillMd(nodeFs.readFileSync(join(skillsDir, ent.name, "SKILL.md"), "utf8"));
          if (parsed) adkSkills.push(parsed);
        } catch { /* SKILL.md 없음/파싱실패 = 스킵 */ }
      }
    } catch { /* .agents/skills 없음 */ }
    if (adkSkills.length) {
      const adkExec = makeAdkSkillExecutor(adkSkills);
      executors.push(adkExec);
      skillsLabel += ` + adk-skills(${adkExec.specs().length}/${adkSkills.length})`;
    }
    toolExecutor = executors.length > 1 ? makeCompositeToolExecutor(executors) : builtin;
  }

  // ── creds = OS 키체인 read-back(Linux=secret-tool lookup service=naia-agent). creds_update 는 런타임 overlay 로 우선. ──
  const C_ENV = { ...env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" };
  const secretToolRead = (name) => {
    const r = spawnSync("secret-tool", ["lookup", "service", "naia-agent", "account", name], { encoding: "utf8", timeout: 5000, env: C_ENV });
    if (r.error || r.status !== 0) return undefined;
    const out = r.stdout ?? "";
    return out.length > 0 ? out.replace(/\n$/, "") : undefined;
  };
  const credentials = makeKeychainCredentials({ read: process.platform === "linux" ? secretToolRead : () => undefined });

  // ── config 정본 = <NAIA_ADK_PATH>/naia-settings/llm.json(main). apiKeyRef → env ?? 키체인. 없음=defaultConfig 없음. ──
  const settingsResolveSecret = (ref) => env[ref] ?? (process.platform === "linux" ? secretToolRead(ref) : undefined);
  const settingsStore = makeNaiaSettingsStore({ fs: nodeFs, resolveSecret: settingsResolveSecret, log: (m, c) => process.stderr.write(`[naia-agent] ${m} ${c ? JSON.stringify(c) : ""}\n`) });
  const defaultConfig = settingsStore.loadMain(adkPath) ?? undefined;
  const configLabel = defaultConfig ? `naia-settings(${defaultConfig.provider}/${defaultConfig.model})` : `none(wire provider 필요) adk=${adkPath}`;

  // ── Phase 3 graft: engine profile(3-role 스냅샷) 실소비 + sub-LLM first-class 표면(Phase 5 adk-batch 소비).
  // loadEngineProfile 는 이제 런타임 소부(계약 전용 해소). mode 잔재는 Phase 3.3 폐기.
  const engineProfile = settingsStore.loadEngineProfile(adkPath) ?? undefined;
  const engineLabel = engineProfile
    ? `engine(main=${engineProfile.mainProvider}/${engineProfile.mainModel}, sub=${engineProfile.subProvider}, embed=${engineProfile.embeddingProvider}, tier=${engineProfile.localGpuTier})`
    : `engine(none)`;
  // memCfg 를 memory 블록 밖에서 먼저 로드(cheap config read) — sub-LLM 은 memory 비활성 시에도 구성(adk-batch 독립).
  const memCfg = settingsStore.loadMemoryConfig(adkPath);
  // buildSubLlmProvider: 미구성(llm.provider="none"/필수누락) = undefined(호출처 폴백). native fetch 사용.
  const subLlm = buildSubLlmProvider(memCfg?.llm, { fetch: async (url, init) => fetch(url, init) });
  const subLlmLabel = subLlm ? `sub-llm(${subLlm.provider}/${subLlm.model ?? "?"})` : `sub-llm(none)`;

  // ── 장기기억(naia-memory) — 기본 활성(NAIA_AGENT_MEMORY=off 로 비활성). 초기화 실패=격리(기억 없이 진행). ──
  let memory, memoryLabel = "off";
  if (env.NAIA_AGENT_MEMORY !== "off") {
    try {
      const { makeNaiaMemory } = await import("../../dist/main/adapters/naia-memory.js");
      const { resolveWorkspaceId, storeDirKey } = await import("../../dist/main/adapters/workspace-project.js");
      const project = env.NAIA_MEMORY_PROJECT || resolveWorkspaceId(adkPath, {
        readFile: (p) => nodeFs.readFileSync(p, "utf8"),
        writeFileExclusive: (p, d) => nodeFs.writeFileSync(p, d, { flag: "wx", mode: 0o600 }),
        mkdir: (p) => nodeFs.mkdirSync(p, { recursive: true, mode: 0o700 }),
        isDirectory: (p) => { try { return nodeFs.statSync(p).isDirectory(); } catch { return false; } },
        randomUUID,
      });
      const storeBase = env.NAIA_MEMORY_DIR || join(homedir(), ".naia-agent", "memory");
      const storePath = env.NAIA_MEMORY_STORE || join(storeBase, storeDirKey(project), "store.json");
      try { nodeFs.mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
      const sessionId = env.NAIA_MEMORY_SESSION || `proc-${randomUUID()}`;
      memory = makeNaiaMemory({
        storePath, project, sessionId,
        ...(memCfg
          ? {
              adapter: memCfg.adapter,
              ...(memCfg.qdrantUrl ? { qdrantUrl: memCfg.qdrantUrl } : {}),
              ...(memCfg.qdrantApiKey ? { qdrantApiKey: memCfg.qdrantApiKey } : {}),
              embedding: memCfg.embedding,
              llm: memCfg.llm,
            }
          : {}),
      });
      memoryLabel = `naia-memory(${storePath}, project=${project}, adapter=${memCfg?.adapter ?? "local"}, embed=${memCfg?.embedding.provider ?? "none"}, llm=${memCfg?.llm.provider ?? "none"})`;
    } catch (e) {
      process.stderr.write(`[naia-agent] memory init 실패(격리, 기억 없이 진행): ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // ── 대화 transcript 영속(FR-CONV.1) — turn 종료 시 verbatim 대화록 append. 기본 활성(NAIA_AGENT_TRANSCRIPT=off). ──
  let conversationLog, transcriptLabel = "off";
  if (env.NAIA_AGENT_TRANSCRIPT !== "off") {
    const conversationsDir = env.NAIA_CONVERSATIONS_DIR || join(adkPath, "conversations");
    conversationLog = makeFileConversationLog({ conversationsDir, fs: nodeFs, join });
    transcriptLabel = `conversations(${conversationsDir})`;
  }

  // ── 표준 로깅 sink(docs/logging.md): stderr + debug 게이트(NAIA_AGENT_DEBUG=1). console.* 금지. ──
  const diag = makeStderrDiagnostic({ write: (l) => process.stderr.write(l + "\n"), debug: env.NAIA_AGENT_DEBUG === "1" });

  return {
    adkPath,
    provider, resolver, providerLabel,
    credentials, secretToolRead,
    settingsStore, settingsResolveSecret, defaultConfig, configLabel,
    engineProfile, engineLabel,
    subLlm, subLlmLabel,
    toolExecutor, skillsLabel,
    memory, memoryLabel,
    conversationLog, transcriptLabel,
    diag, cleanupFns,
  };
}
