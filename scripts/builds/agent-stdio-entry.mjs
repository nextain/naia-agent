#!/usr/bin/env node
// agent-stdio-entry — new-naia-agent(brain) 를 실 process stdin/stdout 로 구동하는 진입점.
// os uc1-trace-harness 의 AGENT_CMD 대상: stdin JSON-line(AgentOutbound) 수신 → wireAgentUC1 → stdout agent_response.
// 기본 provider=fake(LLM 불요, 헤드리스). 실 LLM 은 후속(providers/ 이식).
import { createInterface } from "node:readline";
import { wireAgentUC1 } from "../../dist/main/composition/index.js";
import { makeOllamaProvider } from "../../dist/main/adapters/ollama-provider.js";

// process stdin/stdout → LineIO
const rl = createInterface({ input: process.stdin });
let lineCb = null;
const io = {
  writeLine: (line) => { process.stdout.write(line + "\n"); },
  onLine: (cb) => { lineCb = cb; return () => { lineCb = null; }; },
};
rl.on("line", (l) => lineCb?.(l));

// AGENT_PROVIDER=ollama → 실 ollama(NDJSON 스트림, GPU 필요). 미설정=fake(헤드리스).
const useOllama = process.env.AGENT_PROVIDER === "ollama";
const { start } = wireAgentUC1({ io, ...(useOllama ? { provider: makeOllamaProvider() } : {}) });
start?.();
process.stderr.write(`[new-naia-agent] stdio ready (${useOllama ? "ollama" : "fake"} provider)\n`);

// stdin 닫히면 종료
rl.on("close", () => process.exit(0));
