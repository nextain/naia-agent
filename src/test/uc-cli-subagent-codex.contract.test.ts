// UC-CLI subagent-codex 어댑터 계약(SPEC-010 확장, 2026-06-29) — codex exec --json NDJSON → SubAgentEvent
// 매핑 + honest-unsupported + 인터럽트. fake child(spawnFn 주입) 로 결정론 검증. resolveBin 주입.
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { makeCodexSubAgent, codexLineToEvent, type SpawnFn, type ResolvedBin } from "../main/adapters/subagent-codex.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const fixedBin = (): ResolvedBin => ({ command: "codex", prefixArgs: [] });

function fakeNdjson() {
  let stdoutCb: ((b: Buffer) => void) | undefined;
  const handlers: Record<string, (...a: unknown[]) => void> = {};
  const killSignals: Array<string | number> = [];
  let spawnArgs: { command: string; args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv } | undefined;
  const spawnFn: SpawnFn = (command, args, o) => {
    spawnArgs = { command, args, cwd: o.cwd, env: o.env };
    const child = {
      stdout: { on: (_e: string, cb: (b: Buffer) => void) => { stdoutCb = cb; } },
      stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) { handlers[ev] = cb; return this as unknown; },
      kill(sig?: NodeJS.Signals) { killSignals.push(sig ?? "SIGTERM"); if ((sig ?? "SIGTERM") === "SIGKILL") setTimeout(() => handlers.close?.(null, "SIGKILL"), 0); return true; },
    };
    return child as unknown as ChildProcess;
  };
  return {
    spawnFn,
    line: (s: string) => stdoutCb?.(Buffer.from(s + "\n", "utf8")),
    chunk: (s: string) => stdoutCb?.(Buffer.from(s, "utf8")),
    close: (code: number | null, signal: NodeJS.Signals | null = null) => handlers.close?.(code, signal),
    emitError: (msg: string) => handlers.error?.(new Error(msg)),
    get killSignals() { return killSignals; },
    get spawnArgs() { return spawnArgs!; },
  };
}

async function drain(events: AsyncIterable<SubAgentEvent>): Promise<SubAgentEvent[]> {
  const out: SubAgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("subagent-codex 어댑터 계약 (SPEC-010 확장, fake child)", () => {
  it("codex JSONL → SubAgentEvent 시퀀스 (planning→text_delta→tool_use_end→session_end)", async () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "X 함수 추가해", workdir: "/tmp/w" });
    f.line('{"type":"thread.started","thread_id":"th_1"}');
    f.line('{"type":"turn.started"}');                                              // 무시
    f.line('{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"시작"}}');
    f.line('{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":["ls"]}}');
    f.line('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'); // 무시(terminal=close)
    f.close(0);
    const events = await drain(session.events);

    expect(events.map((e) => e.kind)).toEqual(["planning", "text_delta", "tool_use_end", "session_end"]);
    expect((events[1] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("시작");
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).tool).toBe("command_execution");
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).ok).toBe(true);
    expect((events[3] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("args 정합: 전역 config를 무시하고 workspace-write/never/ephemeral 경계를 강제한다", () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, model: "gpt-5" });
    port.spawn({ prompt: "hi", workdir: "/tmp/w" });
    expect(f.spawnArgs.command).toBe("codex");
    expect(f.spawnArgs.args).toEqual([
      "exec", "--json",
      "--ignore-user-config",
      "--sandbox", "workspace-write",
      "--config", 'approval_policy="never"',
      "--ephemeral",
      "--skip-git-repo-check",
      "--model", "gpt-5",
      "--cd", "/tmp/w",
      "hi",
    ]);
    expect(f.spawnArgs.cwd).toBe("/tmp/w");
  });

  it("uses the provider-neutral read-only capability when Naia requests a proposal worker", () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    port.spawn({ prompt: "proposal", workdir: "/tmp/course", filesystemAccess: "read_only" });
    expect(f.spawnArgs.args).toContain("read-only");
    expect(f.spawnArgs.args).not.toContain("workspace-write");
  });

  it("skipGitRepoCheck=false 옵션 → --skip-git-repo-check 생략", () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, skipGitRepoCheck: false });
    port.spawn({ prompt: "hi", workdir: "/tmp/w" });
    expect(f.spawnArgs.args).toEqual([
      "exec", "--json",
      "--ignore-user-config",
      "--sandbox", "workspace-write",
      "--config", 'approval_policy="never"',
      "--ephemeral",
      "--cd", "/tmp/w",
      "hi",
    ]);
  });

  it("does not inherit a parent Codex thread or its sandbox policy", () => {
    const priorThread = process.env.CODEX_THREAD_ID;
    const priorProfile = process.env.CODEX_PERMISSION_PROFILE;
    process.env.CODEX_THREAD_ID = "parent-thread";
    process.env.CODEX_PERMISSION_PROFILE = "read-only";
    try {
      const f = fakeNdjson();
      makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn }).spawn({ prompt: "hi", workdir: "/tmp/w" });
      expect(f.spawnArgs.env?.CODEX_THREAD_ID).toBeUndefined();
      expect(f.spawnArgs.env?.CODEX_PERMISSION_PROFILE).toBeUndefined();
    } finally {
      if (priorThread === undefined) delete process.env.CODEX_THREAD_ID;
      else process.env.CODEX_THREAD_ID = priorThread;
      if (priorProfile === undefined) delete process.env.CODEX_PERMISSION_PROFILE;
      else process.env.CODEX_PERMISSION_PROFILE = priorProfile;
    }
  });

  it("malformed NDJSON 관용 (crash 없이 드롭) + file_change → tool_use_end", async () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.line("{ not json");                                  // malformed → 드롭
    f.line('{"type":"item.completed","item":{"type":"reasoning","text":"..."}}'); // reasoning → 무시
    f.line('{"type":"item.completed","item":{"id":"i","type":"file_change","path":"a.ts"}}'); // → tool_use_end
    f.close(0);
    const events = await drain(session.events);
    expect(events.map((e) => e.kind)).toEqual(["tool_use_end", "session_end"]);
    expect((events[0] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).tool).toBe("file_change");
  });

  it("비정상 종료: exit code≠0 → session_end{ok:false}", async () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.close(1);
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("exit code 1");
  });

  it("honest-unsupported: spawn 'error' → session_end{ok:false, 'codex unavailable'} (throw 아님)", async () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    f.emitError("spawn codex ENOENT");
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("codex unavailable");
  });

  it("honest-unsupported: resolveBin throw → 즉시 session_end{ok:false} (spawn 미호출)", async () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: () => { throw new Error("CODEX_BIN must be an absolute path"); }, spawnFn: f.spawnFn });
    const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
    const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(end.ok).toBe(false);
    expect(end.reason).toContain("codex unavailable");
  });

  it("turn.completed closes the logical job and reaps an idle Codex child", async () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 15 });
    const session = port.spawn({ prompt: "proposal", workdir: "/tmp/course", filesystemAccess: "read_only" });
    f.line('{"type":"item.completed","item":{"type":"agent_message","text":"proposal"}}');
    f.line('{"type":"turn.completed","usage":{}}');
    const events = await drain(session.events);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.map((event) => event.kind)).toEqual(["text_delta", "session_end"]);
    expect((events.at(-1) as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
    expect(f.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("ignores duplicate logical terminal events in one stdout chunk", async () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 15 });
    const session = port.spawn({ prompt: "proposal", workdir: "/tmp/course", filesystemAccess: "read_only" });
    f.chunk('{"type":"turn.completed"}' + "\n" + '{"type":"turn.completed"}' + "\n");
    const events = await drain(session.events);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toHaveLength(1);
    expect((events[0] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
    expect(f.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("AC1 — cancel(): SIGTERM 무시 → 유예 후 SIGKILL → session_end 1회", async () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 60 });
    const session = port.spawn({ prompt: "long", workdir: "/tmp/w" });
    const events: SubAgentEvent[] = [];
    const drained = (async () => { for await (const e of session.events) events.push(e); })();
    await session.cancel("stop");
    await drained;
    expect(f.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    const ends = events.filter((e) => e.kind === "session_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(false);
  });

  // stub-detector: codexLineToEvent 가 실 매핑(항상참/no-op 아님). RT-verified shape.
  it("stub-detector — codexLineToEvent type별 정확 매핑(빈/무관=null)", () => {
    expect(codexLineToEvent('{"type":"thread.started","thread_id":"x"}')).toEqual({ kind: "planning" });
    expect(codexLineToEvent('{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}')).toEqual({ kind: "text_delta", text: "OK" });
    expect(codexLineToEvent('{"type":"item.completed","item":{"type":"command_execution","command":["ls"]}}')).toEqual({ kind: "tool_use_end", tool: "command_execution", ok: true });
    expect(codexLineToEvent('{"type":"turn.failed","error":{"message":"invalid api key sk-secret"}}'))
      .toEqual({ kind: "session_end", ok: false, reason: "codex turn.failed: authentication" });
    expect(codexLineToEvent("")).toBeNull();
    expect(codexLineToEvent('{"type":"turn.completed","usage":{}}')).toEqual({ kind: "session_end", ok: true, reason: "codex turn.completed" });
    expect(codexLineToEvent('{"type":"item.completed","item":{"type":"agent_message","text":""}}')).toBeNull(); // 빈 텍스트=드롭
  });
});
