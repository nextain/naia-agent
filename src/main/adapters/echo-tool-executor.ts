// adapters/echo-tool-executor — UC5 slice 1 built-in ToolExecutorPort (결정론, 순수).
// 등록 도구 1개: echo(args.text 반향). 미등록 name = isError(no-throw). 실 스킬(time/weather/memo)=후속 per-tool.
import type { ToolExecutorPort } from "../ports/uc1.js";
import type { ToolSpec, ToolCall } from "../domain/chat.js";

const ECHO: ToolSpec = {
  name: "echo",
  description: "입력 text 를 그대로 반향한다(테스트·기본 도구).",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

/** slice 1 기본 도구 실행기 — echo 1개. specs()/execute() no-throw. */
export function makeEchoToolExecutor(): ToolExecutorPort {
  return {
    specs: () => [ECHO],
    async execute(call: ToolCall): Promise<{ output: string; isError?: boolean }> {
      if (call.name !== "echo") return { output: `unknown tool: ${call.name}`, isError: true };
      const a = call.args;
      const text = a && typeof a === "object" && typeof (a as { text?: unknown }).text === "string"
        ? (a as { text: string }).text
        : null;
      if (text === null) return { output: "echo: missing string arg 'text'", isError: true };
      return { output: text };
    },
  };
}
