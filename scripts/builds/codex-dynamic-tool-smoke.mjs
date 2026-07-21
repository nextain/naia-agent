#!/usr/bin/env node

// 실제 로그인된 Codex app-server에 동적 도구를 1회 노출하고, 같은 turn에서
// toolUse → toolResult → 최종 텍스트가 완주하는지 검증한다. 인증정보는 읽거나 출력하지 않는다.
import { runCodexAppServerTurn } from "../../dist/main/adapters/codex-app-server-provider.js";

const model = process.env.NAIA_CODEX_SMOKE_MODEL || "gpt-5.4";
const timestamp = process.env.NAIA_CODEX_SMOKE_TIME || "2026-07-21T11:30:00+09:00";
const timezone = "Asia/Seoul";
const events = [];
let executions = 0;

for await (const event of runCodexAppServerTurn({
  model,
  prompt: `Call get_time exactly once with timezone ${timezone}. Then reply exactly: NAIA_DYNAMIC_TOOL_OK ${timestamp}`,
  tools: [{
    name: "get_time",
    description: "Return the deterministic smoke-test time for a timezone.",
    parameters: {
      type: "object",
      properties: { timezone: { type: "string" } },
      required: ["timezone"],
      additionalProperties: false,
    },
    tier: "none",
  }],
  executeTool: async (call) => {
    executions += 1;
    if (call.name !== "get_time" || call.args?.timezone !== timezone) {
      return { output: "unexpected smoke tool input", isError: true };
    }
    return { output: timestamp };
  },
})) events.push(event);

const toolUses = events.filter((event) => event.kind === "toolUse");
const toolResults = events.filter((event) => event.kind === "toolResult");
const text = events.filter((event) => event.kind === "text").map((event) => event.text).join("");
const completed = events.some((event) => event.kind === "completed");
const result = {
  model,
  executions,
  toolUse: toolUses.map(({ name, args }) => ({ name, args })),
  toolResult: toolResults.map(({ name, output, success }) => ({ name, output, success })),
  text,
  completed,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (
  executions !== 1
  || toolUses.length !== 1
  || toolResults.length !== 1
  || toolResults[0]?.success !== true
  || !text.includes(`NAIA_DYNAMIC_TOOL_OK ${timestamp}`)
  || !completed
) process.exitCode = 1;
