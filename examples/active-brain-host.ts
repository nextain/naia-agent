/**
 * Slice 6A smoke — ActiveBrain spike subscriber wired to a mock memory.
 *
 * Demonstrates rule-based source-monitor (no LLM):
 * - emits 4 SpikeEvents (mix of inject / skip cases)
 * - captures stderr log
 * - asserts decision counts + log lines
 *
 * Run: pnpm tsx examples/active-brain-host.ts
 * Exit 0 = ok, exit 1 = assertion failed.
 */

import process from "node:process";
import type { SpikeEvent, SpikeHandler } from "@nextain/agent-types";
import { ActiveBrain } from "@nextain/agent-cli-app";

interface MockSubscribableMemory {
  on(ev: "spike", h: SpikeHandler): void;
  emitSpike(e: SpikeEvent): Promise<Array<Awaited<ReturnType<SpikeHandler>>>>;
}

function makeMockMemory(): MockSubscribableMemory {
  const handlers: SpikeHandler[] = [];
  return {
    on(_ev, h) {
      handlers.push(h);
    },
    async emitSpike(e) {
      return Promise.all(handlers.map((h) => h(e)));
    },
  };
}

async function main(): Promise<number> {
  const logs: string[] = [];
  const brain = new ActiveBrain({
    activeContext: {
      topics: ["이직", "연봉"],
      recentFactIds: ["f-recent-1"],
      scope: { project: "naia-agent" },
      optOutTopics: ["주식"],
    },
    log: (m) => logs.push(m),
  });

  const memory = makeMockMemory();
  memory.on("spike", brain.handle);

  const events: SpikeEvent[] = [
    {
      factId: "f1",
      content: "사용자가 이직을 고민 중",
      reason: "high-importance-relevant",
      confidence: 0.85,
      relatedFactIds: ["f0"],
      emittedAt: Date.now(),
      scope: { project: "naia-agent" },
    },
    {
      factId: "f2",
      content: "다른 프로젝트의 메모",
      reason: "contradiction",
      confidence: 0.9,
      relatedFactIds: [],
      emittedAt: Date.now(),
      scope: { project: "other-repo" },
    },
    {
      factId: "f3",
      content: "주식 종목 추천",
      reason: "high-importance-relevant",
      confidence: 0.8,
      relatedFactIds: [],
      emittedAt: Date.now(),
      scope: { project: "naia-agent" },
    },
    {
      factId: "f4",
      content: "관련 기억 (recent fact match)",
      reason: "recall-failure-resolved",
      confidence: 0.75,
      relatedFactIds: ["f-recent-1"],
      emittedAt: Date.now(),
      scope: { project: "naia-agent" },
    },
  ];

  const decisions: string[] = [];
  for (const e of events) {
    const result = await memory.emitSpike(e);
    for (const r of result) {
      if (r && typeof r === "object" && "decision" in r) {
        decisions.push(r.decision);
      }
    }
  }

  process.stdout.write(`decisions: ${JSON.stringify(decisions)}\n`);
  process.stdout.write(`log lines: ${logs.length}\n`);
  for (const l of logs) process.stdout.write(l);

  let failed = 0;
  if (decisions.length !== 4) {
    process.stderr.write(`FAIL: expected 4 decisions, got ${decisions.length}\n`);
    failed++;
  }
  const inject = decisions.filter((d) => d === "inject-next-turn").length;
  const skip = decisions.filter((d) => d === "skip").length;
  if (inject !== 2 || skip !== 2) {
    process.stderr.write(
      `FAIL: expected 2 inject + 2 skip, got inject=${inject} skip=${skip}\n`,
    );
    failed++;
  }
  if (logs.length !== 2) {
    process.stderr.write(`FAIL: expected 2 log lines, got ${logs.length}\n`);
    failed++;
  }

  if (failed > 0) {
    process.stderr.write(`active-brain-host: ${failed} assertion(s) failed\n`);
    return 1;
  }
  process.stdout.write("active-brain-host: OK\n");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`active-brain-host: fatal: ${(err as Error).message}\n`);
    process.exit(2);
  },
);
