// UC6 browser skill 테스트 — agent-local(cmd 화이트리스트 + arg 검증 + injected runCli mock). 외부 CLI/browser 불요.
import { describe, it, expect } from "vitest";
import { makeAgentBrowserExecutor, type BrowserCliRun } from "../main/adapters/agent-browser-skills.js";
import type { ToolCall } from "../main/domain/chat.js";

const call = (args: Record<string, unknown>): ToolCall => ({ id: "1", name: "agent_browser", args });

function mkRun(result = { ok: true, stdout: "done", stderr: "" }): { run: BrowserCliRun; log: Array<{ cmd: string; args: readonly string[]; timeoutMs: number }> } {
  const log: Array<{ cmd: string; args: readonly string[]; timeoutMs: number }> = [];
  const run: BrowserCliRun = async (cmd, args, opts) => { log.push({ cmd, args, timeoutMs: opts.timeoutMs }); return result; };
  return { run, log };
}

describe("UC6 agent_browser skill", () => {
  it("tier=ask(환경조작 승인) + tool spec", () => {
    expect(makeAgentBrowserExecutor().specs().find((s) => s.name === "agent_browser")?.tier).toBe("ask");
  });

  it("open <url> → runCli(cmd,args) 위임 + stdout", async () => {
    const { run, log } = mkRun({ ok: true, stdout: "opened", stderr: "" });
    const r = await makeAgentBrowserExecutor({ runCli: run }).execute(call({ cmd: "open", args: ["https://x"] }), {});
    expect(r.isError).toBeUndefined();
    expect(r.output).toBe("opened");
    expect(log).toEqual([{ cmd: "open", args: ["https://x"], timeoutMs: 30000 }]);
  });

  it("runCli 미주입 → 정직 unsupported(외부 CLI 미연결)", async () => {
    const r = await makeAgentBrowserExecutor().execute(call({ cmd: "open", args: ["https://x"] }), {});
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/unavailable|미주입/);
  });

  it("★ 화이트리스트 밖 cmd → 차단(임의 명령 주입 방지)", async () => {
    const { run, log } = mkRun();
    const r = await makeAgentBrowserExecutor({ runCli: run }).execute(call({ cmd: "rm -rf /" }), {});
    expect(r.isError).toBe(true);
    expect(log).toEqual([]); // runCli 호출 안 함
  });

  it("args 가 string[] 아니면 isError(인젝션 방지)", async () => {
    const { run } = mkRun();
    const r = await makeAgentBrowserExecutor({ runCli: run }).execute(call({ cmd: "click", args: [{ evil: 1 }] }), {});
    expect(r.isError).toBe(true);
  });

  it("CLI 실패(ok=false) → stderr isError", async () => {
    const { run } = mkRun({ ok: false, stdout: "", stderr: "selector not found" });
    const r = await makeAgentBrowserExecutor({ runCli: run }).execute(call({ cmd: "click", args: ["#x"] }), {});
    expect(r).toEqual({ output: "selector not found", isError: true });
  });

  it("cmd 누락 / args 없이 호출 OK(기본 빈 배열)", async () => {
    const { run, log } = mkRun();
    expect((await makeAgentBrowserExecutor({ runCli: run }).execute(call({}), {})).isError).toBe(true); // cmd 없음
    await makeAgentBrowserExecutor({ runCli: run }).execute(call({ cmd: "snapshot" }), {});
    expect(log[0]).toEqual({ cmd: "snapshot", args: [], timeoutMs: 30000 });
  });
});
