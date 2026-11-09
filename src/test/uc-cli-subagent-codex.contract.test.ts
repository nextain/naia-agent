// UC-CLI subagent-codex 어댑터 계약(SPEC-010 확장, 2026-06-29) — codex exec --json NDJSON → SubAgentEvent
// 매핑 + honest-unsupported + 인터럽트. fake child(spawnFn 주입) 로 결정론 검증. resolveBin 주입.
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { makeCodexSubAgent, codexLineToEvent, type SpawnFn, type ResolvedBin } from "../main/adapters/subagent-codex.js";
import { makeSubAgentNaiaFacing } from "../main/adapters/subagent-issue-actors.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";
import { IssueActorResultError } from "../main/ports/issue-orchestration.js";

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
    f.line('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":2}}');
    f.close(0);
    const events = await drain(session.events);

    expect(events.map((e) => e.kind)).toEqual(["planning", "text_delta", "tool_use_end", "session_end"]);
    expect((events[1] as Extract<SubAgentEvent, { kind: "text_delta" }>).text).toBe("시작");
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).tool).toBe("command_execution");
    expect((events[2] as Extract<SubAgentEvent, { kind: "tool_use_end" }>).ok).toBe(true);
    expect((events[3] as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
    expect((events[3] as Extract<SubAgentEvent, { kind: "session_end" }>).evidence).toMatchObject({
      provider: "openai-codex", selectedModel: "codex-default", sessionId: "th_1",
      inputTokens: 10, cachedInputTokens: 4, outputTokens: 2,
    });
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

  it("pins role-profile reasoning effort independently from the model id", () => {
    const f = fakeNdjson();
    const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, model: "gpt-5.6-luna", reasoningEffort: "low" });
    port.spawn({ prompt: "hi", workdir: "/tmp/w" });
    expect(f.spawnArgs.args).toContain("model_reasoning_effort=\"low\"");
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

  it("passes only a minimal non-secret environment to the Codex child", () => {
    const prior = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      GH_TOKEN: process.env.GH_TOKEN,
      NPM_TOKEN: process.env.NPM_TOKEN,
    };
    process.env.OPENAI_API_KEY = "openai-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
    process.env.GH_TOKEN = "github-secret";
    process.env.NPM_TOKEN = "npm-secret";
    try {
      const f = fakeNdjson();
      makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn }).spawn({ prompt: "hi", workdir: "/tmp/w" });
      expect(f.spawnArgs.env?.PATH).toBe(process.env.PATH);
      expect(f.spawnArgs.env?.HOME).toBe(process.env.HOME);
      expect(f.spawnArgs.env?.OPENAI_API_KEY).toBeUndefined();
      expect(f.spawnArgs.env?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(f.spawnArgs.env?.GH_TOKEN).toBeUndefined();
      expect(f.spawnArgs.env?.NPM_TOKEN).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("enforces --sandbox read-only, 8 noTools config flags, and disabled model catalog when noTools=true option is set on non-bridge openai-codex (B1 / P2-다)", async () => {
    const { CODEX_NO_TOOLS_CONFIG_FLAGS } = await import("../main/adapters/naia-pi-provider.js");
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const cfgDir = mkdtempSync(join(tmpdir(), "naia-codex-notools-test-"));
    try {
      const f = fakeNdjson();
      const port = makeCodexSubAgent({
        resolveBin: fixedBin,
        spawnFn: f.spawnFn,
        noTools: true,
        model: "gpt-5.4",
        codexConfigDir: cfgDir,
      });
      port.spawn({ prompt: "inspect only", workdir: "/tmp/w" });
      expect(f.spawnArgs.args).toContain("read-only");
      expect(f.spawnArgs.args).not.toContain("workspace-write");
      for (const flag of CODEX_NO_TOOLS_CONFIG_FLAGS) {
        expect(f.spawnArgs.args).toContain(flag);
      }
      expect(f.spawnArgs.args).toContain("features.memory_tool=false");
      const catalogArg = f.spawnArgs.args.find((a) => a.startsWith("model_catalog_json="));
      expect(catalogArg).toBeDefined();
      const catalogPath = JSON.parse(catalogArg!.slice("model_catalog_json=".length)) as string;
      const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<Record<string, unknown>> };
      expect(catalog.models.length).toBeGreaterThan(0);
      for (const entry of catalog.models) {
        expect(entry).toMatchObject({
          shell_type: "disabled",
          apply_patch_tool_type: null,
          supports_parallel_tool_calls: false,
          use_responses_lite: false,
          tool_mode: "direct",
          experimental_supported_tools: [],
          supports_search_tool: false,
        });
      }
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
    }
  });

  it("rejects Naia gateway model IDs before spawn on the Codex CLI path (B1/B2)", async () => {
    for (const model of ["grok-4.3", "deepseek-v4-pro", "HCX-007", "hcx-007"]) {
      const f = fakeNdjson();
      const port = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, model });
      const session = port.spawn({ prompt: "inspect", workdir: "/tmp/w" });
      const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
      expect(f.spawnArgs).toBeUndefined();
      expect(end.ok).toBe(false);
      expect(end.reason).toContain("codex model rejected before spawn");
    }
  });

  it("isolates account-provider Codex children from parent DISCORD_BOT_TOKEN, NAIA_API_KEY, and ANTHROPIC_API_KEY credentials (B3)", () => {
    const prior = {
      DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
      NAIA_API_KEY: process.env.NAIA_API_KEY,
      NAIA_ANYLLM_API_KEY: process.env.NAIA_ANYLLM_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.DISCORD_BOT_TOKEN = "must-not-leak-discord";
    process.env.NAIA_API_KEY = "must-not-leak-naia";
    process.env.NAIA_ANYLLM_API_KEY = "must-not-leak-anyllm";
    process.env.ANTHROPIC_API_KEY = "must-not-leak-anthropic";
    try {
      const f = fakeNdjson();
      makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, model: "gpt-5.4" }).spawn({ prompt: "hi", workdir: "/tmp/w" });
      expect(f.spawnArgs.env).toBeDefined();
      expect(f.spawnArgs.env).not.toHaveProperty("DISCORD_BOT_TOKEN");
      expect(f.spawnArgs.env).not.toHaveProperty("NAIA_API_KEY");
      expect(f.spawnArgs.env).not.toHaveProperty("NAIA_ANYLLM_API_KEY");
      expect(f.spawnArgs.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("provides adapter-owned identities and preserves usage evidence on failure for a Codex-backed JSON actor receipt (B3)", async () => {
    const f = fakeNdjson();
    const codex = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: f.spawnFn, model: "gpt-5.4", hardKillDeadlineMs: 5 });
    const facing = makeSubAgentNaiaFacing({
      subAgent: codex,
      binding: { provider: "openai-codex", model: "gpt-5.4" },
      workdir: "/tmp/w",
      diag: { log() {}, debug() {} },
    });
    const result = facing.classify({
      requestId: "request-codex-facing",
      idempotencyKey: "issue:codex:facing",
      text: "fix it",
      requiredObligations: ["fix it"],
      signal: new AbortController().signal,
    });
    f.line('{"type":"thread.started","thread_id":"th_codex_1"}');
    f.line('{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"{\\"kind\\":\\"work\\",\\"obligations\\":[\\"fix it\\"]}"}}');
    f.line('{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":4}}');
    f.close(0);
    const classified = await result;
    expect(classified.classification).toEqual({ kind: "work", obligations: ["fix it"] });
    expect(classified.receipt).toMatchObject({
      role: "naia",
      provider: "openai-codex",
      model: "gpt-5.4",
      tokenCountsAvailable: true,
      inputTokens: 10,
      outputTokens: 4,
      sessionId: "th_codex_1",
      executionId: expect.any(String),
      cost: { state: "unavailable" },
    });
    expect(classified.receipt.sessionId).not.toBe(classified.receipt.executionId);

    const fFail = fakeNdjson();
    const codexFail = makeCodexSubAgent({ resolveBin: fixedBin, spawnFn: fFail.spawnFn, model: "gpt-5.4", hardKillDeadlineMs: 5 });
    const facingFail = makeSubAgentNaiaFacing({
      subAgent: codexFail,
      binding: { provider: "openai-codex", model: "gpt-5.4" },
      workdir: "/tmp/w",
      diag: { log() {}, debug() {} },
    });
    const failedResult = facingFail.classify({
      requestId: "request-codex-fail",
      idempotencyKey: "issue:codex:fail",
      text: "fix it",
      requiredObligations: ["fix it"],
      signal: new AbortController().signal,
    });
    fFail.line('{"type":"thread.started","thread_id":"th_codex_fail"}');
    fFail.line('{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"{\\"kind\\":\\"invalid\\",\\"obligations\\":[]}"}}');
    fFail.line('{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":0,"output_tokens":5}}');
    fFail.close(0);
    const error = await failedResult.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IssueActorResultError);
    expect(error).toMatchObject({
      receipt: {
        role: "naia",
        provider: "openai-codex",
        model: "gpt-5.4",
        idempotencyKey: "issue:codex:fail",
        tokenCountsAvailable: true,
        inputTokens: 12,
        outputTokens: 5,
        cost: { state: "unavailable" },
      },
    });
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
    f.line('{"type":"thread.started","thread_id":"thread-priced"}');
    f.line('{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10}}');
    const events = await drain(session.events);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events.map((event) => event.kind)).toEqual(["text_delta", "planning", "session_end"]);
    expect((events.at(-1) as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
    expect((events.at(-1) as Extract<SubAgentEvent, { kind: "session_end" }>).evidence).toMatchObject({
      sessionId: "thread-priced", inputTokens: 100, cachedInputTokens: 40, outputTokens: 10,
    });
    expect(f.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not price an omitted or malformed usage object as measured zero", async () => {
    for (const terminal of [
      '{"type":"turn.completed"}',
      '{"type":"turn.completed","usage":{"input_tokens":"10","cached_input_tokens":0,"output_tokens":1}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":2,"output_tokens":0}}',
    ]) {
      const f = fakeNdjson();
      const port = makeCodexSubAgent({
        resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 5,
        priceUsdPerMillion: { uncachedInput: 1, cachedInput: 1, output: 1 },
      });
      const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
      f.line(terminal);
      const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
      expect(end.evidence).toMatchObject({ usageAvailable: false, modelEvidenceSource: "adapter_requested" });
      expect(end.evidence?.measuredCostUsd).toBeUndefined();
    }
  });

  it("marks monetary cost unavailable above the frozen long-context applicability threshold", async () => {
    for (const [inputTokens, measured] of [[272_000, true], [272_001, false]] as const) {
      const f = fakeNdjson();
      const port = makeCodexSubAgent({
        resolveBin: fixedBin, spawnFn: f.spawnFn, hardKillDeadlineMs: 5,
        priceUsdPerMillion: { uncachedInput: 1, cachedInput: 0.1, output: 6 },
        maximumPricedInputTokens: 272_000,
      });
      const session = port.spawn({ prompt: "p", workdir: "/tmp/w" });
      f.line(`{"type":"turn.completed","usage":{"input_tokens":${inputTokens},"cached_input_tokens":0,"output_tokens":1}}`);
      const [end] = await drain(session.events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
      expect(end.evidence?.usageAvailable).toBe(true);
      if (measured) expect(end.evidence?.measuredCostUsd).toBeTypeOf("number");
      else expect(end.evidence?.measuredCostUsd).toBeUndefined();
    }
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

  it("resolves codex binary in order CODEX_BIN -> package-local node_modules/.bin/codex -> PATH and never falls back to unpinned npx", async () => {
    const { resolveCodexBin } = await import("../main/adapters/subagent-codex.js");
    const { mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path"); const { tmpdir } = await import("node:os");
    const baseTmp = tmpdir();
    mkdirSync(baseTmp, { recursive: true });
    const root = mkdtempSync(join(baseTmp, "codex-bin-order-"));
    try {
      const pkgRoot = join(root, "pkg");
      const pkgBinDir = join(pkgRoot, "node_modules", ".bin");
      const pathDir = join(root, "global-path");
      const explicitBin = join(root, "explicit-codex");
      mkdirSync(pkgBinDir, { recursive: true });
      mkdirSync(pathDir, { recursive: true });
      const pkgCodex = join(pkgBinDir, "codex");
      const pathCodex = join(pathDir, "codex");
      writeFileSync(pkgCodex, "#!/bin/sh\necho 'codex-cli 0.163.0'\n");
      writeFileSync(pathCodex, "#!/bin/sh\necho 'codex-cli 0.999.0'\n");
      writeFileSync(explicitBin, "#!/bin/sh\necho 'codex-cli 0.163.0'\n");
      chmodSync(pkgCodex, 0o755);
      chmodSync(pathCodex, 0o755);
      chmodSync(explicitBin, 0o755);

      // 1) CODEX_BIN wins over package-local and PATH
      expect(resolveCodexBin({
        env: { CODEX_BIN: explicitBin, PATH: pathDir },
        packageRoot: pkgRoot,
        platform: "linux",
      })).toEqual({ command: explicitBin, prefixArgs: [] });

      // 2) Package-local node_modules/.bin/codex wins over global PATH
      expect(resolveCodexBin({
        env: { PATH: pathDir },
        packageRoot: pkgRoot,
        platform: "linux",
      })).toEqual({ command: pkgCodex, prefixArgs: [] });

      // 3) Global PATH is used when package-local binary is absent
      expect(resolveCodexBin({
        env: { PATH: pathDir },
        packageRoot: join(root, "empty-pkg"),
        platform: "linux",
      })).toEqual({ command: pathCodex, prefixArgs: [] });

      // 4) When absent everywhere, never falls back to unpinned `npx --yes @openai/codex`
      const missing = resolveCodexBin({
        env: { PATH: "" },
        packageRoot: join(root, "empty-pkg"),
        platform: "linux",
        pathLookup: () => null,
      });
      expect(missing).toEqual({ command: "codex", prefixArgs: [] });
      expect(missing.prefixArgs).not.toContain("@openai/codex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
