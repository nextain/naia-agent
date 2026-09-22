// compose-agent-deps — naia-agent(brain) 의 **transport-독립 런타임 deps** 단일 조립기.
// gRPC host(agent-stdio-entry.mjs)와 CLI host(bin/naia-agent-chat.mjs)가 **둘 다 이 함수**로 deps 를
// 만들어 같은 `wireAgentUC1` 에 주입한다 → 두 경로가 literally 동일 파이프라인(NFR-CLI-shared, 병렬 금지).
// 여기서 만드는 것: provider(resolver/fake) · credentials(keychain) · naia-settings(defaultConfig) ·
//   toolExecutor(builtin+composite, **app 제외**=gRPC 전용) · memory(naia-memory) · conversationLog(transcript) · diag.
// transport(stdin/stdout/readline/grpc)·app(환경 위임, egress 필요)·shutdown 은 각 host 의 관심사 → 여기 없음.
import { createInterface } from "node:readline";
import { WINDOWS_DPAPI_TIMEOUT_MS } from "../../dist/main/app/cli-manage.js";
import { makeProviderResolver } from "../../dist/main/adapters/provider-resolver.js";
import { makeFakeProvider, makeSystemEchoProvider } from "../../dist/main/adapters/fake-provider.js";
import { makeKeychainCredentials, makeRefreshingKeychainRead } from "../../dist/main/adapters/keychain-secret-store.js";
import { makeNaiaSettingsStore } from "../../dist/main/adapters/naia-settings-store.js";
import { buildSubLlmProvider } from "../../dist/main/adapters/sub-llm-provider.js";
import { resolveRoleRuntimeConfig } from "../../dist/main/adapters/llm-role-runtime.js";
import { makeStderrDiagnostic } from "../../dist/main/adapters/diagnostic.js";
import { makeBuiltinSkillsExecutor } from "../../dist/main/adapters/builtin-skills.js";
import { makeGithubSkillsExecutor } from "../../dist/main/adapters/github-skills.js";
import { makeObsidianSkillsExecutor } from "../../dist/main/adapters/obsidian-skills.js";
import { makeMcpSkillsExecutor } from "../../dist/main/adapters/mcp-skills.js";
import { makeMcpJsonRpcClient } from "../../dist/main/adapters/mcp-stdio-transport.js";
import { makeCompositeToolExecutor } from "../../dist/main/adapters/composite-tool-executor.js";
import { makeNotifyExecutor } from "../../dist/main/adapters/notify-skills.js";
import { makeAdkSkillExecutor, parseSkillMd } from "../../dist/main/adapters/adk-skill-loader.js";
import { makeFsTools } from "../../dist/main/adapters/fs-tools.js";
import { makeShellTool } from "../../dist/main/adapters/shell-tool.js";
import { workspaceBindFromSettings } from "../../dist/main/domain/workspace-bind.js";
import { makeKnowledgeSkillsExecutor } from "../../dist/main/adapters/knowledge-skill.js";
import { readWorkspaceKnowledgeConfig, isValidKnowledgeScope } from "../../dist/main/adapters/knowledge-compile.js";
import { pickSpawnableBin, resolveSpawnableBin, resolveFallbackCommand } from "../../dist/main/adapters/subprocess-session.js";
import { makeOpenMeteoFetchWeather } from "../../dist/main/adapters/openmeteo-weather.js";
import { makeFileMemoStore } from "../../dist/main/adapters/file-memo-store.js";
import { makeFileConversationLog } from "../../dist/main/adapters/conversation-log-store.js";
import { makePersonaSourceStore } from "../../dist/main/adapters/persona-source-store.js";
import { makeWorkspaceContextStore } from "../../dist/main/adapters/workspace-context-store.js";
import { migrateLegacyKnowledge, migrateLegacyMemoryStore, migrateLegacyMemoryStoreFile, migrateLegacyWorkspaceIdentity, resolveProductKnowledgeDir, resolveProductStorage } from "../../dist/main/adapters/workspace-project.js";
// ⚠️ makeNaiaMemory(→@nextain/naia-memory)는 *동적* import(아래) — 정적이면 모듈 로딩 실패 시 NAIA_AGENT_MEMORY=off
// 나 try/catch 에 도달 못 하고 프로세스가 죽어 메모리 비활성 채팅(FR-MEM-3)·초기화 격리 계약이 깨진다.
import * as nodeFs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** Trim a workspace path. Empty/non-string values become "". */
export function trimAdkPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Host ADK root. Shell/gRPC must pass NAIA_ADK_PATH / SetWorkspace.
 * A leftover `~/naia-adk` clone or CLI `~/.naia-agent/config.json` pin must
 * not become the product memory root when that env is set, and the gRPC host
 * must not fall back to those clones at all (`allowHomeAdkFallback: false`).
 */
export function resolveHostAdkPath({
  envAdkPath,
  globalAdkPath,
  defaultAdkPath,
  allowHomeAdkFallback = false,
} = {}) {
  const env = trimAdkPath(envAdkPath);
  if (env) return env;
  if (!allowHomeAdkFallback) return "";
  const global = trimAdkPath(globalAdkPath);
  if (global) return global;
  return trimAdkPath(defaultAdkPath);
}

/**
 * transport-독립 런타임 deps 조립(async — memory 동적 import + MCP init 때문).
 * @param {object} [o]
 * @param {NodeJS.ProcessEnv} [o.env] — 기본 process.env. (NAIA_ADK_PATH/AGENT_PROVIDER/NAIA_AGENT_SKILLS/MEMORY/TRANSCRIPT/DEBUG 등)
 * @param {string} [o.homeDir] — 기본 os.homedir(). 테스트가 leftover `~/naia-adk` clone 을 심을 때 주입.
 * @param {boolean} [o.allowHomeAdkFallback] — CLI standalone 만 true. gRPC/Shell host 는 false(기본).
 * @returns deps + 라벨 + cleanupFns + settingsStore/adkPath(호스트의 reload 배선용).
 */
export async function composeAgentRuntimeDeps(o = {}) {
  const env = o.env ?? process.env;
  const homeDir = typeof o.homeDir === "string" && o.homeDir.trim() ? o.homeDir : homedir();
  const allowHomeAdkFallback = o.allowHomeAdkFallback === true;
  const cleanupFns = []; // 종료 시 정리(MCP 자식 등) — 호스트 shutdown 이 호출.
  const rejectExistingSymlink = (path, label) => {
    try {
      if (nodeFs.lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
  };
  const canonicalProductRoot = (workspacePath) => {
    const canonical = nodeFs.realpathSync(workspacePath);
    const storage = resolveProductStorage(canonical);
    rejectExistingSymlink(storage.settingsDir, "naia-settings");
    rejectExistingSymlink(storage.memoryDir, "naia-settings/memory");
    rejectExistingSymlink(storage.memoryStorePath, "naia-settings/memory/store.json");
    rejectExistingSymlink(storage.workspaceIdPath, "naia-settings/memory/workspace-id");
    return { canonical, storage };
  };
  const assertContainedRealPath = (root, path, label) => {
    if (!nodeFs.existsSync(path)) return;
    const realRoot = nodeFs.realpathSync(root);
    const realPath = nodeFs.realpathSync(path);
    if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`${label} escapes the canonical ADK`);
    }
  };
  const migrationDeps = {
    exists: (path) => nodeFs.existsSync(path),
    mkdir: (path) => nodeFs.mkdirSync(path, { recursive: true, mode: 0o700 }),
    validateSource: (source, expectedRoot) => {
      const realRoot = nodeFs.realpathSync(expectedRoot);
      const realSource = nodeFs.realpathSync(source);
      if (realSource !== realRoot && !realSource.startsWith(`${realRoot}${sep}`)) {
        throw new Error(`legacy source escapes its expected root: ${source}`);
      }
    },
    copyExclusive: (source, destination) => {
      if (nodeFs.lstatSync(source).isSymbolicLink()) throw new Error(`legacy source must not be a symbolic link: ${source}`);
      const temp = `${destination}.migrate-${process.pid}-${randomUUID()}`;
      try {
        nodeFs.copyFileSync(source, temp, nodeFs.constants.COPYFILE_EXCL);
        const fd = nodeFs.openSync(temp, "r+");
        try { nodeFs.fsyncSync(fd); } finally { nodeFs.closeSync(fd); }
        try {
          nodeFs.linkSync(temp, destination); // atomic destination-wins; EEXIST is handled by copyLegacyFile
        } catch (error) {
          const code = error && typeof error === "object" ? error.code : undefined;
          if (!["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(code)) throw error;
          // Some network/removable filesystems cannot create hard links. COPYFILE_EXCL
          // retains destination-wins semantics; the legacy source remains the rollback copy.
          nodeFs.copyFileSync(temp, destination, nodeFs.constants.COPYFILE_EXCL);
          const destinationFd = nodeFs.openSync(destination, "r+");
          try { nodeFs.fsyncSync(destinationFd); } finally { nodeFs.closeSync(destinationFd); }
        }
        try { nodeFs.chmodSync(destination, 0o600); } catch { /* best-effort permission hardening */ }
      } finally {
        try { nodeFs.unlinkSync(temp); } catch { /* absent or cleanup failure: destination remains authoritative */ }
      }
    },
  };

  // ── provider 해석: 기본 = config-driven resolver(naia-settings→셸→req.provider+creds_update 로 lab-proxy/native/ollama
  //    라우팅). AGENT_PROVIDER=fake → 헤드리스 결정론 fake(E2E·LLM 불요). echo-system → recall→inject 관통 검증용. ──
  const ap = env.AGENT_PROVIDER;
  let provider, resolver, providerLabel;
  if (ap === "fake") { provider = makeFakeProvider(); providerLabel = "fake(headless)"; }
  else if (ap === "echo-system") { provider = makeSystemEchoProvider(); providerLabel = "echo-system(e2e)"; }
  else { providerLabel = "config-driven resolver(lab-proxy/native/ollama)"; }

  // ADK 워크스페이스 경로. 제품 host(gRPC/Shell) 정본 = NAIA_ADK_PATH / SetWorkspace.
  // CLI standalone 만 ~/.naia-agent/config.json 과 ~/naia-adk bootstrap 을 허용한다.
  // ⚠️ ~/naia-adk 폴백은 두 번째 clone silent-divergence 원인 — gRPC host 에서 금지.
  const DEFAULT_ADK = join(homeDir, "naia-adk");
  let globalAdk;
  try {
    const parsed = JSON.parse(nodeFs.readFileSync(join(homeDir, ".naia-agent", "config.json"), "utf8"));
    if (typeof parsed?.adkPath === "string" && parsed.adkPath.trim().length > 0) globalAdk = parsed.adkPath.trim();
  } catch { /* 전역 config 없음/손상 = 폴백 */ }
  const adkPath = resolveHostAdkPath({
    envAdkPath: env.NAIA_ADK_PATH,
    globalAdkPath: globalAdk,
    defaultAdkPath: DEFAULT_ADK,
    allowHomeAdkFallback,
  });
  if (allowHomeAdkFallback && !trimAdkPath(env.NAIA_ADK_PATH) && !globalAdk && adkPath) {
    process.stderr.write(`[naia-agent] ⚠ 워크스페이스 미설정 — 기본(${DEFAULT_ADK}) 폴백. 'naia-agent-chat workspace <path>' 로 단일 device 워크스페이스 고정 권장(1기기=1설정).\n`);
  } else if (!adkPath) {
    process.stderr.write("[naia-agent] ⚠ 워크스페이스 미설정 — leftover ~/naia-adk clone 폴백 없이 SetWorkspace/NAIA_ADK_PATH 를 기다린다.\n");
  }
  const readEnvironmentTerminalInput = (workspacePath) => {
    try {
      const parsed = JSON.parse(nodeFs.readFileSync(join(workspacePath, "naia-settings", "config.json"), "utf8"));
      return parsed?.environmentTerminalInput === true;
    } catch { return false; }
  };
  const bindFor = (workspacePath) => {
    if (!workspacePath) return undefined;
    try { if (!nodeFs.existsSync(workspacePath)) return undefined; }
    catch { return undefined; }
    return workspaceBindFromSettings({
      canonicalRoot: workspacePath,
      environmentTerminalInput: readEnvironmentTerminalInput(workspacePath),
    });
  };
  let currentBind = bindFor(adkPath);
  const setWorkspaceBind = (workspacePath) => {
    if (workspacePath) currentBind = bindFor(workspacePath);
  };
  if (!provider) {
    resolver = makeProviderResolver({ workspace: () => currentBind });
  }
  let skillsCfg = {};
  try { skillsCfg = JSON.parse(nodeFs.readFileSync(join(adkPath, "naia-settings", "skills.json"), "utf8")); } catch { /* 없음 = env 폴백 */ }

  // ── UC-PERSONA-CLI(S1b): 워크스페이스 페르소나(Alpha) SoT 읽기 포트만 제공. SoT = <adkPath>/naia-settings/
  //    config.json(naia-os 가 읽고 쓰는 동일 파일). **합성은 코어(ChatTurnHandler)가 personaSource 로 스스로 수행**
  //    (FR-PERSONA-3) — host 는 조립·주입하지 않는다(클라가 system prompt 를 안 보냄). personaLabel 은 stderr
  //    상태줄 표기용으로만 load() 1회 추출. (S1a 의 host 합성·주입 경로는 제거 — 코어가 조립.)
  const personaSource = makePersonaSourceStore({ fs: nodeFs, adkPath });
  const personaProfile = personaSource.load();
  const personaLabel = personaProfile?.agentName
    ? `persona(${personaProfile.agentName}, locale=${personaProfile.locale ?? "?"}, style=${personaProfile.speechStyle ?? "?"})`
    : "persona(none)";

  // ── UC-WORKSPACE-CTX(S2): 워크스페이스 컨텍스트(cwd + 프로젝트 이름) 경량 스냅샷 포트. **합성은 코어**
  //    (ChatTurnHandler 가 workspaceContext 로 per-turn snapshot()→composeWorkspaceContext, persona 뒤 append).
  //    shallow 1-depth readdir 만(<adkPath>/projects/ 디렉터리명) — 파일 내용/깊은 walk 없음(GLM: 덤프 방지).
  //    wsLabel 은 stderr 상태줄 표기용으로만 snapshot() 1회 추출(프로젝트 수 + cwd).
  // Product chat is rooted at the selected ADK, not at the launcher process's
  // implementation directory (for example naia-shell/src-tauri in dev mode).
  const workspaceContextSource = makeWorkspaceContextStore({ fs: nodeFs, adkPath, cwd: adkPath });
  const wsSnap = workspaceContextSource.snapshot();
  const wsLabel = wsSnap
    ? `workspace(cwd=${wsSnap.cwd}, projects=${wsSnap.projectTotal})`
    : "workspace(none)";

  // ── UC5 실 스킬(time/weather/memo + github/obsidian/mcp/notify/adk) — 기본 활성(NAIA_AGENT_SKILLS=off 로 비활성). ──
  // ⚠️ app(환경 위임)은 여기 미포함 — egress 가 필요해 gRPC host 가 wire 후 합성(브라우저/BGM=셸 소유 환경, E1).
  let toolExecutor, skillsLabel = "off";
  let knowledgeBackend;
  let setKnowledgeWorkspace = () => undefined;
  if (env.NAIA_AGENT_SKILLS !== "off") {
    const memoPath = env.NAIA_MEMO_PATH || join(homeDir, ".naia-agent", "memos.json");
    const memo = makeFileMemoStore({ path: memoPath, dir: dirname(memoPath), fs: nodeFs });
    const builtin = makeBuiltinSkillsExecutor({ clock: () => new Date(), fetchWeather: makeOpenMeteoFetchWeather(), memo });
    skillsLabel = `time/weather/memo(${memoPath})`;
    const executors = [builtin];

    // ── UC-FS-TOOLS(S3): 에이전트 직접 fs/shell 도구. ★ 보안 = 코어가 sandbox 정책(allow-root=adkPath)+tier 소유.
    //    실행기(realpath/exec)만 여기서 node:fs/child_process 주입(코어 순수). read/list 기본 등록, write/shell 은
    //    NAIA_SHELL_TOOL=1 opt-in. (GLM: env-var 게이트는 자식상속으로 약함 → 핵심 보안은 sandbox/denylist/argv;
    //    per-request capability 미래 강화는 요구사항 NFR-SEC 노트.)
    const enableShell = env.NAIA_SHELL_TOOL === "1";
    executors.push(makeFsTools({
      fs: nodeFs,
      allowRoots: () => {
        const root = currentBind?.canonicalRoot ?? adkPath;
        return root ? [root] : [];
      },
      enableWrite: enableShell,
    }));
    skillsLabel += enableShell ? " + fs-tools(read/list/write)" : " + fs-tools(read/list)";
    if (enableShell) {
      // ── injection-safe argv 실행기 — **shell 없이** spawn(subprocess-session 헬퍼로 Windows .cmd/.bat shim 해석).
      //    timeout/maxBytes bound, abort 시 child kill. shell 문자열 보간 0(argv 직접).
      const shellExec = (argv, opts) => new Promise((resolve, reject) => {
        // bin 해석: argv[0] 절대경로면 그대로, 아니면 where/which → spawnable(.cmd→node+script / .exe 직접).
        let bin = { command: argv[0], prefixArgs: [] };
        try {
          if (/[\\/]/.test(argv[0])) {
            bin = resolveSpawnableBin(argv[0]); // 경로 포함 = 직접(Windows shim 해석만)
          } else {
            const where = process.platform === "win32" ? "where" : "which";
            const r = spawnSync(where, [argv[0]], { encoding: "utf8", timeout: 5000, windowsHide: true });
            const picked = (r.status === 0 && r.stdout) ? pickSpawnableBin(r.stdout.split(/\r?\n/)) : null;
            bin = picked ? resolveSpawnableBin(picked) : resolveFallbackCommand(argv[0]);
          }
        } catch { bin = resolveFallbackCommand(argv[0]); }
        const fullArgs = [...bin.prefixArgs, ...argv.slice(1)];
        let child;
        try {
          // ⚠️ shell:false(기본) — 셸 보간/주입 차단. cwd=검증된 절대경로. stdin 무시.
          child = spawn(bin.command, fullArgs, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
        } catch (e) { resolve({ stdout: "", stderr: `spawn failed: ${e instanceof Error ? e.message : String(e)}`, code: null }); return; }
        let out = "", errOut = "", bytes = 0, settled = false;
        const cap = (s, chunk) => { const c = chunk.toString("utf8"); bytes += c.length; return bytes > opts.maxBytes ? s : s + c; };
        const done = (res) => { if (settled) return; settled = true; clearTimeout(timer); if (onAbort) opts.signal?.removeEventListener("abort", onAbort); resolve(res); };
        child.stdout?.on("data", (c) => { out = cap(out, c); });
        child.stderr?.on("data", (c) => { errOut = cap(errOut, c); });
        child.on("error", (e) => done({ stdout: out, stderr: `${errOut}\n${e.message}`, code: null }));
        child.on("close", (code) => done({ stdout: out, stderr: errOut, code }));
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } done({ stdout: out, stderr: `${errOut}\n[timeout ${opts.timeoutMs}ms]`, code: null }); }, opts.timeoutMs);
        let onAbort = null;
        if (opts.signal) {
          if (opts.signal.aborted) { try { child.kill("SIGKILL"); } catch { /* noop */ } if (settled) return; settled = true; clearTimeout(timer); reject(new Error("aborted")); return; }
          onAbort = () => { try { child.kill("SIGKILL"); } catch { /* noop */ } if (settled) return; settled = true; clearTimeout(timer); reject(new Error("aborted")); };
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      // realpath 주입 — cwd 의 symlink/junction 탈출 재검증(fs-tools 와 동형). 부재/실패 시 throw → 어댑터가 거부.
      if (adkPath) {
        executors.push(makeShellTool({ exec: shellExec, allowRoots: [adkPath], realpath: (p) => nodeFs.realpathSync(p) }));
        skillsLabel += " + shell-tool(argv)";
      }
    }

    // ── UC-KNOWLEDGE(K1a): 워크스페이스 지식 풀 도구(read-only skill_knowledge_search/ask). memory(푸시)와 직교한 풀.
    //    backend = naia-kb-compiler openWorkspaceKnowledge(<adkPath>/naia-settings/knowledge/<scope>) — *동적* import(@naia/kb-compiler
    //    미설치/빌드실패/KB부재 시 격리: 지식 도구만 생략, 채팅 무영향). 어댑터(makeKnowledgeSkillsExecutor)는 코어 소유,
    //    backend 만 외부 엔진 주입(D03 비종속). **활성 스코프** = 셸 소유 knowledge.json(읽기전용)의 scope —
    //    컴파일 산출(knowledge/<scope>/kb.json)과 동일 scope 로 읽어 읽기/쓰기 경로 정렬(멀티스코프 V1). 파일 부재=빈 KB(ask 기권).
    if (env.NAIA_KNOWLEDGE !== "off") {
      try {
        const { openWorkspaceKnowledge, toGraphData } = await import("@naia/kb-compiler");
        let knowledgeWorkspace = adkPath;
        setKnowledgeWorkspace = (workspacePath) => { if (workspacePath) knowledgeWorkspace = workspacePath; };
        // ★ 라이브 리로드(컴파일 후 재시작 불요): kb.json 은 기동 시 1회 인덱싱되므로, "지금 컴파일" 로
        //   파일이 바뀌어도 기존 KB(인덱스)는 stale → AI 가 새 지식을 못 본다. mtime 변화 감지 시 다음 질의에서
        //   재로딩(재인덱싱) = 컴파일 RPC 와 결선 없이 자가교정. 무변화면 캐시 재사용(매 질의 재인덱싱 안 함).
        let cached = null;
        let cachedKey = "";
        let cachedMtime = -1;
        let lastScope = "default";
        let lastSources = [];
        const loadKnowledge = async () => {
          let scope = "default";
          let sources = [];
          try {
            const cfg = await readWorkspaceKnowledgeConfig(knowledgeWorkspace);
            if (cfg.scope && isValidKnowledgeScope(cfg.scope)) scope = cfg.scope;
            if (Array.isArray(cfg.sources)) sources = cfg.sources;
          } catch { /* knowledge.json 부재/깨짐 = default */ }
          lastScope = scope;
          lastSources = sources;
          const { canonical } = canonicalProductRoot(knowledgeWorkspace);
          const knowledgeRoot = join(canonical, "naia-settings", "knowledge");
          const knowledgeDir = resolveProductKnowledgeDir(canonical, scope);
          const kbFile = join(knowledgeDir, "kb.json");
          rejectExistingSymlink(knowledgeRoot, "naia-settings/knowledge");
          rejectExistingSymlink(knowledgeDir, `naia-settings/knowledge/${scope}`);
          rejectExistingSymlink(kbFile, `naia-settings/knowledge/${scope}/kb.json`);
          assertContainedRealPath(canonical, knowledgeRoot, "naia-settings/knowledge");
          assertContainedRealPath(canonical, knowledgeDir, `naia-settings/knowledge/${scope}`);
          migrateLegacyKnowledge(canonical, scope, migrationDeps);
          let mtime = 0;
          try { mtime = nodeFs.statSync(kbFile).mtimeMs; } catch { mtime = 0; } // 부재 = mtime 0(빈 KB)
          const key = `${canonical}\0${scope}`;
          if (cached === null || key !== cachedKey || mtime !== cachedMtime) {
            cached = await openWorkspaceKnowledge(knowledgeDir);
            cachedKey = key;
            cachedMtime = mtime;
          }
          return cached;
        };
        // FR-KB-8 (naia-agent#142): 카드 → 등록 소스 매칭. 경로 구분자 정규화 + (win32) 대소문자 무시 + 경계 확인(prefix 오탐 방지).
        const normPath = (p) => {
          let s = String(p).replace(/^file:\/\//i, "").replace(/\\/g, "/").replace(/\/+$/, "");
          if (process.platform === "win32") s = s.replace(/^\/(?=[a-zA-Z]:)/, "").toLowerCase();
          return s;
        };
        const underSource = (uri, src) => { const u = normPath(uri); const s = normPath(src); return s !== "" && (u === s || u.startsWith(s + "/")); };
        const backend = {
          search: async (q, k) => (await loadKnowledge()).service.search(q, k),
          ask: async (q) => {
            const wk = await loadKnowledge();
            const r = await wk.service.ask(q);
            if (!r?.abstained) return r;
            // Serve rule: compiled non-gap hits are answers. Conversational
            // questions ("회사 이름이 뭐야?") can miss ask's token coverage
            // even when search already found the card (naia-shell#648).
            const hits = await wk.service.search(q, 3);
            const hit = Array.isArray(hits) ? hits.find((h) => h && h.score > 0) : null;
            if (!hit) return r;
            return {
              abstained: false,
              answer: hit.snippet || hit.title,
              sources: hits.slice(0, 3).map((h) => ({ title: h.title, sourceUris: h.sourceUris })),
            };
          },
          graph: async () => toGraphData((await loadKnowledge()).kb),
          scope: async () => {
            const wk = await loadKnowledge();
            const cards = Array.isArray(wk?.kb?.cards) ? wk.kb.cards : [];
            const counts = lastSources.map(() => 0);
            let otherCards = 0;
            for (const c of cards) {
              const uris = Array.isArray(c?.sourceUris) ? c.sourceUris : [];
              const idx = lastSources.findIndex((src) => uris.some((u) => typeof u === "string" && underSource(u, src)));
              if (idx >= 0) counts[idx] += 1; else otherCards += 1;
            }
            return { scope: lastScope, sources: lastSources.map((path, i) => ({ path, cardCount: counts[i] })), totalCards: cards.length, otherCards };
          },
        };
        knowledgeBackend = backend;
        executors.push(makeKnowledgeSkillsExecutor({ backend }));
        // Do not eagerly realpath/load the fallback workspace. A fresh desktop may boot before
        // the selected ADK exists; the dynamic backend must recover after SetWorkspace.
        skillsLabel += " + knowledge(canonical naia-settings, live-workspace-reload)";
      } catch (e) {
        process.stderr.write(`[naia-agent] knowledge init 실패(격리, 지식 도구 없이 진행): ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }

    const ghToken = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (ghToken) { executors.push(makeGithubSkillsExecutor({ token: ghToken })); skillsLabel += " + github(ro)"; }
    const vault = env.NAIA_OBSIDIAN_VAULT;
    if (vault) { executors.push(makeObsidianSkillsExecutor({ vaultDir: vault, fs: nodeFs })); skillsLabel += " + obsidian(ro)"; }
    const mcpCmd = env.NAIA_MCP_CMD;
    if (mcpCmd) {
      try {
        const parts = mcpCmd.trim().split(/\s+/);
        const mcpName = env.NAIA_MCP_NAME || "mcp";
        const child = spawn(parts[0], parts.slice(1), { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
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

  // ── creds = OS 키체인 read-back. Linux=secret-tool(service=naia-agent account={env_key}).
  //    Windows=DPAPI({adkPath}/naia-settings/.keys/{env_key}.dpapi, CurrentUser scope — naia-os write_agent_key 가 저장).
  //    macOS=미지원(후속). creds_update 는 런타임 overlay 로 우선. ──
  const C_ENV = { ...env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" };
  const secretToolRead = (name) => {
    const r = spawnSync("secret-tool", ["lookup", "service", "naia-agent", "account", name], { encoding: "utf8", timeout: 5000, env: C_ENV, windowsHide: true });
    if (r.error || r.status !== 0) return undefined;
    const out = r.stdout ?? "";
    return out.length > 0 ? out.replace(/\n$/, "") : undefined;
  };
  // Windows DPAPI read-back(키체인). {adk}/naia-settings/.keys/<name>.dpapi → PowerShell ProtectedData::Unprotect(CurrentUser).
  // naia-os 가 write_agent_key 로 저장한 키를 agent 가 read-back(별도 login 불요). 경로는 $env:DPAPI_FILE 로 전달(명령 주입 방지).
  // 성공한 decrypt만 파일 identity+version으로 캐시한다. login 전 부재, logout/login에 따른 교체,
  // SetWorkspace 경로 변경은 다음 read에서 즉시 관측하면서 매 턴 PowerShell spawn은 피한다.
  let credentialAdkPath = adkPath;
  const setCredentialWorkspace = (workspacePath) => {
    if (workspacePath) credentialAdkPath = workspacePath;
  };
  const winDpapiRead = makeRefreshingKeychainRead((name) => {
    const file = join(credentialAdkPath, "naia-settings", ".keys", `${name}.dpapi`);
    let stat;
    try { stat = nodeFs.statSync(file, { bigint: true }); }
    catch { return undefined; }
    return {
      cacheKey: file,
      version: `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`,
      read: () => {
        const r = spawnSync("powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:DPAPI_FILE), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))"], { encoding: "utf8", timeout: WINDOWS_DPAPI_TIMEOUT_MS, env: { ...env, DPAPI_FILE: file }, windowsHide: true });
        const out = (!r.error && r.status === 0) ? (r.stdout ?? "").replace(/\r?\n$/, "") : undefined;
        return out && out.length > 0 ? out : undefined;
      },
    };
  });
  const keychainRead = process.platform === "win32" ? winDpapiRead : (process.platform === "linux" ? secretToolRead : () => undefined);
  const credentials = makeKeychainCredentials({ read: keychainRead });

  // ── config 정본 = <adkPath>/naia-settings/llm.json(main). apiKeyRef → env ?? 키체인. 없음=defaultConfig 없음. ──
  const settingsResolveSecret = (ref) => env[ref] ?? keychainRead(ref);
  const settingsStore = makeNaiaSettingsStore({ fs: nodeFs, resolveSecret: settingsResolveSecret, log: (m, c) => process.stderr.write(`[naia-agent] ${m} ${c ? JSON.stringify(c) : ""}\n`) });
  const defaultConfig = settingsStore.loadMain(adkPath) ?? undefined;
  const configLabel = defaultConfig ? `naia-settings(${defaultConfig.provider}/${defaultConfig.model})` : `none(wire provider 필요) adk=${adkPath}`;

  // ── main/sub/memory 역할별 effective config. 신규 llmRoles 우선, legacy memoryLlm*은
  // memory로 보존되고 sub에만 legacy-inherit 된다. 역할별 provider/auth 실패는 다른 역할을 끄지 않는다.
  const llmRoles = settingsStore.loadLlmRoles(adkPath);
  const roleConfigs = llmRoles?.ok ? llmRoles.configs : [];
  const resolveRole = (role) => {
    const effective = roleConfigs.find((cfg) => cfg.role === role);
    return effective ? resolveRoleRuntimeConfig(effective, settingsResolveSecret) : undefined;
  };
  const subRoleRuntime = resolveRole("sub");
  const roleLabel = llmRoles?.ok
    ? `roles(${llmRoles.configs.map((cfg) => `${cfg.role}=${cfg.provider.value}/${cfg.model.value}:${cfg.provider.provenance}`).join(",")})`
    : llmRoles
      ? `roles(invalid:${llmRoles.role}/${llmRoles.reason})`
      : "roles(legacy-main-only)";

  // 기존 engine profile은 GPU/embedding 상태 진단 호환용. LLM 역할 라우팅 권위는 위 llmRoles다.
  const engineProfile = settingsStore.loadEngineProfile(adkPath) ?? undefined;
  const engineLabel = engineProfile
    ? `engine(main=${engineProfile.mainProvider}/${engineProfile.mainModel}, sub=${engineProfile.subProvider}, embed=${engineProfile.embeddingProvider}, tier=${engineProfile.localGpuTier})`
    : `engine(none)`;
  const subLlm = subRoleRuntime?.ok
    ? buildSubLlmProvider(subRoleRuntime.config, { fetch: async (url, init) => fetch(url, init) })
    : undefined;
  const subLlmLabel = subLlm
    ? `sub-llm(${subLlm.provider}/${subLlm.model ?? "?"})`
    : subRoleRuntime && !subRoleRuntime.ok
      ? `sub-llm(degraded:${subRoleRuntime.reason})`
      : "sub-llm(none)";

  // ── 장기기억(naia-memory) — 기본 활성(NAIA_AGENT_MEMORY=off 로 비활성). 초기화 실패=격리(기억 없이 진행). ──
  let memory, memoryLabel = "off";
  let reloadMemory = async () => ({ ok: true, reloaded: false, retained: false, status: "off" });
  if (env.NAIA_AGENT_MEMORY !== "off") {
    try {
      const { makeNaiaMemory } = await import("../../dist/main/adapters/naia-memory.js");
      const { makeReloadableMemory } = await import("../../dist/main/adapters/reloadable-memory.js");
      const { resolveWorkspaceId } = await import("../../dist/main/adapters/workspace-project.js");
      memory = makeReloadableMemory();

      const stableJson = (value) => {
        if (value === undefined) return "undefined";
        if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
        if (value && typeof value === "object") {
          return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
        }
        return JSON.stringify(value);
      };

      const loadMemorySnapshot = (workspacePath) => {
        const memoryConfig = settingsStore.loadMemoryConfig(workspacePath);
        const roles = settingsStore.loadLlmRoles(workspacePath);
        const absoluteWorkspace = resolve(workspacePath);
        const workspaceKey = process.platform === "win32" ? absoluteWorkspace.toLowerCase() : absoluteWorkspace;
        // Hash instead of retaining/logging a canonical string that may contain
        // resolved API keys from loadMemoryConfig.
        const fingerprint = createHash("sha256")
          .update(workspaceKey)
          .update("\0")
          .update(stableJson({ memoryConfig, roles }))
          .digest("hex");
        return { memoryConfig, roles, fingerprint };
      };

      const buildMemory = async (workspacePath, snapshot) => {
        const nextMemCfg = snapshot.memoryConfig;
        const nextRoles = snapshot.roles;
        if (nextRoles && !nextRoles.ok) {
          throw new Error(`invalid llmRoles(${nextRoles.role}/${nextRoles.reason})`);
        }
        const nextRoleConfigs = nextRoles?.ok ? nextRoles.configs : [];
        const effectiveMemoryRole = nextRoleConfigs.find((cfg) => cfg.role === "memory");
        const nextMemoryRuntime = effectiveMemoryRole
          ? resolveRoleRuntimeConfig(effectiveMemoryRole, settingsResolveSecret)
          : undefined;
        const { canonical: canonicalWorkspace, storage } = canonicalProductRoot(workspacePath);
        // Preserve existing users: copy legacy identity first, then use that identity to find
        // the legacy hashed store. Never overwrite a new-boundary file.
        const tryLegacyMigration = (label, migrate) => {
          try { return migrate(); }
          catch (error) {
            process.stderr.write(`[naia-agent] legacy ${label} migration skipped: ${error instanceof Error ? error.message : String(error)}\n`);
            return false;
          }
        };
        tryLegacyMigration("workspace identity", () => migrateLegacyWorkspaceIdentity(canonicalWorkspace, migrationDeps));
        const project = resolveWorkspaceId(canonicalWorkspace, {
          readFile: (p) => nodeFs.readFileSync(p, "utf8"),
          writeFileExclusive: (p, d) => nodeFs.writeFileSync(p, d, { flag: "wx", mode: 0o600 }),
          mkdir: (p) => nodeFs.mkdirSync(p, { recursive: true, mode: 0o700 }),
          isDirectory: (p) => { try { return nodeFs.statSync(p).isDirectory(); } catch { return false; } },
          realpath: (p) => nodeFs.realpathSync(p),
          randomUUID,
        });
        const storePath = storage.memoryStorePath;
        let migratedLegacyStore = false;
        if (env.NAIA_MEMORY_STORE) {
          migratedLegacyStore = tryLegacyMigration("memory store", () => migrateLegacyMemoryStoreFile(canonicalWorkspace, env.NAIA_MEMORY_STORE, migrationDeps));
        }
        const legacyRoots = [
          env.NAIA_MEMORY_DIR,
          join(homeDir, ".naia-agent", "memory"),
        ].filter((value, index, all) => value && all.indexOf(value) === index);
        for (const legacyRoot of migratedLegacyStore ? [] : legacyRoots) {
          if (tryLegacyMigration("memory store", () => migrateLegacyMemoryStore(canonicalWorkspace, project, legacyRoot, migrationDeps))) {
            migratedLegacyStore = true;
            break;
          }
        }
        // A store keyed by a caller-supplied legacy project cannot be copied safely: its records
        // retain that project and strict UUID scope would make every copied memory unreachable.
        // Keep the source untouched and require an explicit record-rewrite migration later.
        if ((env.NAIA_MEMORY_STORE || env.NAIA_MEMORY_DIR || env.NAIA_MEMORY_PROJECT) && !migratedLegacyStore) {
          process.stderr.write("[naia-agent] legacy memory override is ignored; no legacy store was copied because the canonical destination already exists or the source is absent\n");
        }
        try { nodeFs.mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
        const sessionId = env.NAIA_MEMORY_SESSION || `proc-${randomUUID()}`;
        const consolidationOn = Boolean(nextMemoryRuntime?.ok && env.NAIA_MEMORY_CONSOLIDATION !== "off");
        const next = makeNaiaMemory({
          storePath, project, sessionId,
          ...(nextMemCfg
            ? {
                adapter: nextMemCfg.adapter,
                ...(nextMemCfg.qdrantUrl ? { qdrantUrl: nextMemCfg.qdrantUrl } : {}),
                ...(nextMemCfg.qdrantApiKey ? { qdrantApiKey: nextMemCfg.qdrantApiKey } : {}),
                embedding: nextMemCfg.embedding,
              }
            : {}),
          ...(nextMemoryRuntime?.ok ? { llm: nextMemoryRuntime.config } : {}),
          ...(consolidationOn ? { consolidation: {} } : {}),
          onConsolidation: (event) => {
            if (event.phase === "failed") {
              process.stderr.write(`[naia-agent] memory consolidation failed (episodes kept for retry): ${event.error}\n`);
            } else if (event.episodesProcessed > 0) {
              process.stderr.write(`[naia-agent] memory consolidation: episodes=${event.episodesProcessed} facts+=${event.factsCreated} updated=${event.factsUpdated}\n`);
            }
          },
          onEmbeddingReindex: (event) => {
            if (event.phase === "start") {
              process.stderr.write(`[naia-agent] memory embedding-space mismatch; reindexing (${event.reason})\n`);
            } else if (event.phase === "done") {
              process.stderr.write("[naia-agent] memory embedding reindex complete\n");
            } else {
              const cause = event.error ? `; cause: ${String(event.error).replace(/\r?\n/g, " ").slice(0, 500)}` : "";
              process.stderr.write(`[naia-agent] memory embedding reindex failed; store is not empty (${event.reason})${cause}\n`);
            }
          },
        });
        process.stderr.write("[naia-agent] memory preparing in background (model load / reindex)\n");
        const verify = () => {
          // Re-check after adapter initialization: a local race must not leave an
          // active memory instance writing through a swapped directory/file link.
          rejectExistingSymlink(storage.memoryDir, "naia-settings/memory");
          rejectExistingSymlink(storage.memoryStorePath, "naia-settings/memory/store.json");
          rejectExistingSymlink(storage.workspaceIdPath, "naia-settings/memory/workspace-id");
          assertContainedRealPath(canonicalWorkspace, storage.memoryDir, "naia-settings/memory");
          assertContainedRealPath(canonicalWorkspace, storage.memoryStorePath, "naia-settings/memory/store.json");
          assertContainedRealPath(canonicalWorkspace, storage.workspaceIdPath, "naia-settings/memory/workspace-id");
        };
        const onFail = (error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[naia-agent] memory preparation failed (memory disabled until next reload): ${message}\n`);
          next.close().catch(() => undefined);
        };
        next.ready().then(verify, onFail).catch(onFail);
        const label = `naia-memory(${storePath}, project=${project}, adapter=${nextMemCfg?.adapter ?? "local"}, embed=${nextMemCfg?.embedding.provider ?? "none"}, llm=${nextMemoryRuntime?.ok ? nextMemoryRuntime.config.provider : "none"}, consolidation=${consolidationOn ? "on" : "off"})`;
        return { next, label, fingerprint: snapshot.fingerprint };
      };

      let reloadQueue = Promise.resolve();
      let activeMemoryFingerprint;
      reloadMemory = (workspacePath) => {
        const run = reloadQueue.then(async () => {
          try {
            const snapshot = loadMemorySnapshot(workspacePath);
            if (memory.hasActive() && snapshot.fingerprint === activeMemoryFingerprint) {
              return { ok: true, reloaded: false, retained: false, status: memoryLabel };
            }
            let built;
            const replacement = await memory.reconfigure(async () => {
              built = await buildMemory(workspacePath, snapshot);
              return built.next;
            });
            memoryLabel = built.label;
            activeMemoryFingerprint = built.fingerprint;
            return {
              ok: true,
              reloaded: replacement.replaced,
              retained: false,
              status: built.label,
              ...(replacement.closeError ? { warning: `previous memory close failed: ${replacement.closeError}` } : {}),
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, reloaded: false, retained: memory.hasActive(), status: memoryLabel, error: message };
          }
        });
        reloadQueue = run.then(() => undefined, () => undefined);
        return run;
      };
      if (adkPath) {
        const initial = await reloadMemory(adkPath);
        if (!initial.ok) {
          process.stderr.write(`[naia-agent] memory init failed (isolated, continuing without memory): ${initial.error}\n`);
        }
      } else {
        process.stderr.write("[naia-agent] memory deferred until SetWorkspace/NAIA_ADK_PATH (no leftover ~/naia-adk clone)\n");
      }
    } catch (e) {
      process.stderr.write(`[naia-agent] memory init 실패(격리, 기억 없이 진행): ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // ── 대화 transcript 영속(FR-CONV.1) — turn 종료 시 verbatim 대화록 append. 기본 활성(NAIA_AGENT_TRANSCRIPT=off). ──
  let conversationLog, transcriptLabel = "off";
  if (env.NAIA_AGENT_TRANSCRIPT !== "off" && adkPath) {
    const conversationsDir = env.NAIA_CONVERSATIONS_DIR || join(adkPath, "conversations");
    conversationLog = makeFileConversationLog({ conversationsDir, fs: nodeFs, join });
    transcriptLabel = `conversations(${conversationsDir})`;
  }

  // ── 표준 로깅 sink(docs/logging.md): stderr + debug 게이트(NAIA_AGENT_DEBUG=1). console.* 금지. ──
  const diag = makeStderrDiagnostic({ write: (l) => process.stderr.write(l + "\n"), debug: env.NAIA_AGENT_DEBUG === "1" });

  return {
    adkPath,
    provider, resolver, providerLabel,
    credentials, secretToolRead, setCredentialWorkspace,
    settingsStore, settingsResolveSecret, defaultConfig, configLabel,
    engineProfile, engineLabel, llmRoles, roleLabel,
    subLlm, subLlmLabel,
    toolExecutor, skillsLabel, knowledgeBackend, setKnowledgeWorkspace, setWorkspaceBind,
    memory, memoryLabel, reloadMemory,
    conversationLog, transcriptLabel,
    personaSource, personaLabel,
    workspaceContextSource, wsLabel,
    diag, cleanupFns,
  };
}
