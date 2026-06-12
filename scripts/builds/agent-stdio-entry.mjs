#!/usr/bin/env node
// agent-stdio-entry — new-naia-agent(brain) 를 실 process stdin/stdout 로 구동하는 진입점.
// os uc1-trace-harness 의 AGENT_CMD 대상: stdin JSON-line(AgentOutbound) 수신 → wireAgentUC1 → stdout agent_response.
// 기본 provider=fake(LLM 불요, 헤드리스). 실 LLM 은 후속(providers/ 이식).
import { createInterface } from "node:readline";
import { wireAgentUC1 } from "../../dist/main/composition/index.js";
import { makeProviderResolver } from "../../dist/main/adapters/provider-resolver.js";
import { makeFakeProvider } from "../../dist/main/adapters/fake-provider.js";
import { makeBuiltinSkillsExecutor } from "../../dist/main/adapters/builtin-skills.js";
import { makeGithubSkillsExecutor } from "../../dist/main/adapters/github-skills.js";
import { makeObsidianSkillsExecutor } from "../../dist/main/adapters/obsidian-skills.js";
import { makeMcpSkillsExecutor } from "../../dist/main/adapters/mcp-skills.js";
import { makeMcpJsonRpcClient } from "../../dist/main/adapters/mcp-stdio-transport.js";
import { makeCompositeToolExecutor } from "../../dist/main/adapters/composite-tool-executor.js";
import { makeOpenMeteoFetchWeather } from "../../dist/main/adapters/openmeteo-weather.js";
import { makeFileMemoStore } from "../../dist/main/adapters/file-memo-store.js";
import * as nodeFs from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// process stdin/stdout → LineIO
const rl = createInterface({ input: process.stdin });
let lineCb = null;
const io = {
  writeLine: (line) => { process.stdout.write(line + "\n"); },
  onLine: (cb) => { lineCb = cb; return () => { lineCb = null; }; },
};
rl.on("line", (l) => lineCb?.(l));

// provider 해석: 기본 = config-driven resolver — 요청의 provider/model/naiaKey/apiKey(naia-settings → 셸 → req.provider
//   + creds_update) 로 lab-proxy(naia 게이트웨이)/native(키 직접)/ollama 라우팅. (옛 AGENT_PROVIDER=glm/ollama env 강제 삭제 —
//   config 가 흐르게: "온보딩/설정 → adk → agent 가 읽어 그 provider 로 대화".)
// AGENT_PROVIDER=fake → 헤드리스 결정론 fake provider(E2E·LLM 불요).
const ap = process.env.AGENT_PROVIDER;
let provider, resolver, label;
if (ap === "fake") { provider = makeFakeProvider(); label = "fake(headless)"; }
else { resolver = makeProviderResolver(); label = "config-driven resolver(lab-proxy/native/ollama)"; }
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
  toolExecutor = executors.length > 1 ? makeCompositeToolExecutor(executors) : builtin;
}

const { start } = wireAgentUC1({ io, ...(provider ? { provider } : {}), ...(resolver ? { resolver } : {}), ...(toolExecutor ? { toolExecutor } : {}) });
start?.();
process.stderr.write(`[new-naia-agent] stdio ready (${label} provider, skills: ${skillsLabel})\n`);

// stdin 닫히면 종료
rl.on("close", () => process.exit(0));
