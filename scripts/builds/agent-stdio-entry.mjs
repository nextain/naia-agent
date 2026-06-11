#!/usr/bin/env node
// agent-stdio-entry — new-naia-agent(brain) 를 실 process stdin/stdout 로 구동하는 진입점.
// os uc1-trace-harness 의 AGENT_CMD 대상: stdin JSON-line(AgentOutbound) 수신 → wireAgentUC1 → stdout agent_response.
// 기본 provider=fake(LLM 불요, 헤드리스). 실 LLM 은 후속(providers/ 이식).
import { createInterface } from "node:readline";
import { wireAgentUC1 } from "../../dist/main/composition/index.js";
import { makeOllamaProvider } from "../../dist/main/adapters/ollama-provider.js";
import { makeOpenAICompatProvider } from "../../dist/main/adapters/openai-compat-provider.js";
import { makeBuiltinSkillsExecutor } from "../../dist/main/adapters/builtin-skills.js";
import { makeGithubSkillsExecutor } from "../../dist/main/adapters/github-skills.js";
import { makeObsidianSkillsExecutor } from "../../dist/main/adapters/obsidian-skills.js";
import { makeCompositeToolExecutor } from "../../dist/main/adapters/composite-tool-executor.js";
import { makeOpenMeteoFetchWeather } from "../../dist/main/adapters/openmeteo-weather.js";
import { makeFileMemoStore } from "../../dist/main/adapters/file-memo-store.js";
import * as nodeFs from "node:fs";
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

// AGENT_PROVIDER: ollama(GPU) | glm(클라우드 z.ai coding, GLM_KEY) | (미설정)=fake 헤드리스.
const ap = process.env.AGENT_PROVIDER;
let provider, label = "fake";
if (ap === "ollama") { provider = makeOllamaProvider(); label = "ollama"; }
else if (ap === "glm") {
  // GLM_MODEL: 셸 UI 가 보낸 model(naia-local 등)을 GLM 이 거부하므로 유효 모델로 강제.
  const glmModel = process.env.GLM_MODEL || "glm-4.6";
  provider = makeOpenAICompatProvider({ baseUrl: process.env.GLM_BASE_URL || "https://api.z.ai/api/coding/paas/v4", apiKey: process.env.GLM_KEY || process.env.GLM_API_KEY || "", model: glmModel });
  label = `glm(z.ai ${glmModel})`;
}
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
  toolExecutor = executors.length > 1 ? makeCompositeToolExecutor(executors) : builtin;
}

const { start } = wireAgentUC1({ io, ...(provider ? { provider } : {}), ...(toolExecutor ? { toolExecutor } : {}) });
start?.();
process.stderr.write(`[new-naia-agent] stdio ready (${label} provider, skills: ${skillsLabel})\n`);

// stdin 닫히면 종료
rl.on("close", () => process.exit(0));
