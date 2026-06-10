#!/usr/bin/env node
// agent-stdio-entry — new-naia-agent(brain) 를 실 process stdin/stdout 로 구동하는 진입점.
// os uc1-trace-harness 의 AGENT_CMD 대상: stdin JSON-line(AgentOutbound) 수신 → wireAgentUC1 → stdout agent_response.
// 기본 provider=fake(LLM 불요, 헤드리스). 실 LLM 은 후속(providers/ 이식).
import { createInterface } from "node:readline";
import { wireAgentUC1 } from "../../dist/main/composition/index.js";

// process stdin/stdout → LineIO
const rl = createInterface({ input: process.stdin });
let lineCb = null;
const io = {
  writeLine: (line) => { process.stdout.write(line + "\n"); },
  onLine: (cb) => { lineCb = cb; return () => { lineCb = null; }; },
};
rl.on("line", (l) => lineCb?.(l));

const { start } = wireAgentUC1({ io }); // provider 미주입=fake
start?.();
process.stderr.write("[new-naia-agent] stdio ready (fake provider)\n");

// stdin 닫히면 종료
rl.on("close", () => process.exit(0));
