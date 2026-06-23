// UC-CLI subagent-roster 계약(2b, AC6) — 이름 → SubAgentPort 선택 + 미구현/미지 = 정직 unsupported(throw 아님).
import { describe, it, expect } from "vitest";
import type { ChildProcess } from "node:child_process";
import { selectSubAgent, SUPPORTED_SUBAGENTS, DECLARED_SUBAGENTS } from "../main/adapters/subagent-roster.js";
import type { SpawnFn, ResolvedBin } from "../main/adapters/subprocess-session.js";
import type { SubAgentEvent } from "../main/domain/orchestration.js";

const fixedBin = (cmd: string) => (): ResolvedBin => ({ command: cmd, prefixArgs: [] });

/** 등록 직후 close(0) 하는 fake spawn — "어떤 어댑터든 실 sub-agent 세션을 만든다" 만 증명. */
function closingSpawn(): SpawnFn {
  return () => {
    const handlers: Record<string, (...a: unknown[]) => void> = {};
    const child = {
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on(ev: string, cb: (...a: unknown[]) => void) { handlers[ev] = cb; return this as unknown; },
      kill() { return true; },
    };
    queueMicrotask(() => handlers.close?.(0, null)); // 생성자 close 리스너 등록 후 종료
    return child as unknown as ChildProcess;
  };
}

async function drain(events: AsyncIterable<SubAgentEvent>): Promise<SubAgentEvent[]> {
  const out: SubAgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("subagent-roster 계약 (2b, AC6)", () => {
  it("'pi' → 실 pi 어댑터(주입 bin/spawn 으로 세션 생성 — session_end{ok:true})", async () => {
    const port = selectSubAgent("pi", { pi: { resolveBin: fixedBin("pi"), spawnFn: closingSpawn() } });
    const events = await drain(port.spawn({ prompt: "x", workdir: "/tmp/w" }).events);
    expect(events.at(-1)?.kind).toBe("session_end");
    expect((events.at(-1) as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("'opencode' → 실 opencode 어댑터(세션 생성)", async () => {
    const port = selectSubAgent("opencode", { opencode: { resolveBin: fixedBin("opencode"), spawnFn: closingSpawn() } });
    const events = await drain(port.spawn({ prompt: "x", workdir: "/tmp/w" }).events);
    expect((events.at(-1) as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("'shell' + command 주입 → 실 shell 어댑터(세션 생성)", async () => {
    const port = selectSubAgent("shell", { shell: { command: "x", spawnFn: closingSpawn() } });
    const events = await drain(port.spawn({ prompt: "x", workdir: "/tmp/w" }).events);
    expect((events.at(-1) as Extract<SubAgentEvent, { kind: "session_end" }>).ok).toBe(true);
  });

  it("'shell' command 미지정 → 정직 unsupported(session_end{ok:false}, throw 아님)", async () => {
    const port = selectSubAgent("shell"); // opts.shell 없음
    const events = await drain(port.spawn({ prompt: "x", workdir: "/tmp/w" }).events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(events).toHaveLength(1);
    expect(events[0].ok).toBe(false);
    expect(events[0].reason).toContain("unsupported sub-agent: shell");
  });

  it.each(["claude-code", "codex", "gemini"])("'%s' (선언됐으나 후속) → 정직 unsupported(deferred), throw 아님", async (name) => {
    const port = selectSubAgent(name);
    const events = await drain(port.spawn({ prompt: "x", workdir: "/tmp/w" }).events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(events).toHaveLength(1);
    expect(events[0].ok).toBe(false);
    expect(events[0].reason).toContain(`unsupported sub-agent: ${name}`);
    expect(events[0].reason).toContain("deferred");
  });

  it("미지(unknown) 이름 → 정직 unsupported + supported 목록 안내, throw 아님", async () => {
    const port = selectSubAgent("bogus-agent-zzz");
    const events = await drain(port.spawn({ prompt: "x", workdir: "/tmp/w" }).events) as Extract<SubAgentEvent, { kind: "session_end" }>[];
    expect(events).toHaveLength(1);
    expect(events[0].ok).toBe(false);
    expect(events[0].reason).toContain("unknown");
    expect(events[0].reason).toContain("pi, opencode, shell"); // 안내
  });

  it("roster 목록: supported ⊆ declared, claude-code/codex/gemini 는 선언만", () => {
    expect(SUPPORTED_SUBAGENTS).toEqual(["pi", "opencode", "shell"]);
    for (const s of SUPPORTED_SUBAGENTS) expect(DECLARED_SUBAGENTS).toContain(s);
    for (const d of ["claude-code", "codex", "gemini"]) {
      expect(DECLARED_SUBAGENTS).toContain(d);
      expect(SUPPORTED_SUBAGENTS as readonly string[]).not.toContain(d); // 아직 미구현
    }
  });
});
