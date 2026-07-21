import { describe, expect, it, vi } from "vitest";
import {
  ExhibitionIntroController,
  type ExhibitionScheduler,
} from "../main/app/exhibition-intro-controller.js";

class ManualScheduler implements ExhibitionScheduler {
  nowMs = 0;
  private jobs: { at: number; run: () => void | Promise<void>; cancelled: boolean }[] = [];
  now(): number { return this.nowMs; }
  schedule(delayMs: number, run: () => void | Promise<void>): () => void {
    const job = { at: this.nowMs + delayMs, run, cancelled: false };
    this.jobs.push(job);
    return () => { job.cancelled = true; };
  }
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.jobs
        .filter((j) => !j.cancelled && j.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) {
        this.nowMs = target;
        return;
      }
      this.nowMs = due.at;
      due.cancelled = true;
      await due.run();
    }
  }
}

function harness(opts: {
  items?: { itemId: string; text: string; sourceUris: string[] }[];
  speakImpl?: (text: string) => Promise<"completed" | "cancelled">;
  answerSources?: string[];
  answerImpl?: (question: string) => Promise<{ abstained: boolean; answer: string; sources: string[] }>;
  listImpl?: () => Promise<{ itemId: string; text: string; sourceUris: string[] }[]>;
} = {}) {
  const scheduler = new ManualScheduler();
  const spoken: string[] = [];
  const calls: string[] = [];
  const controller = new ExhibitionIntroController({
    scheduler,
    ids: {
      activity: () => "ex-activity-1",
      resumeToken: () => "resume-1",
    },
    knowledge: {
      ready: () => true,
      listIntroItems: vi.fn(async () => opts.listImpl ? opts.listImpl() : opts.items ?? [
        { itemId: "A", text: "넥스테인은 AI 에이전트를 만듭니다.", sourceUris: ["kb://company"] },
        { itemId: "B", text: "Naia는 로컬 기억을 지원합니다.", sourceUris: ["kb://naia"] },
        { itemId: "C", text: "전시에서는 음성 대화를 체험할 수 있습니다.", sourceUris: ["kb://exhibition"] },
      ]),
      answer: vi.fn(async (_scope, question) => opts.answerImpl
        ? opts.answerImpl(question)
        : question === "근거없음"
          ? { abstained: true, answer: "", sources: [] }
          : { abstained: false, answer: "Naia는 사용자의 질문에 답합니다.", sources: opts.answerSources ?? ["kb://naia"] }),
    },
    speech: {
      open: vi.fn(),
      speak: vi.fn(async ({ text }) => {
        calls.push(`speak:${text}`);
        spoken.push(text);
        return opts.speakImpl ? opts.speakImpl(text) : "completed" as const;
      }),
      interrupt: vi.fn(() => { calls.push("interrupt"); }),
      close: vi.fn(),
    },
  });
  controller.configure({
    sessionId: "exhibition",
    knowledgeScope: "nextain-expo",
    idleMs: 1_000,
    introIntervalMs: 500,
  });
  controller.setSubscriberReady(true);
  return { controller, scheduler, spoken, calls };
}

describe("exhibition intro MVP contract", () => {
  it("EX-01/02: idle 뒤 source 있는 서로 다른 항목 최대 3개를 소개한다", async () => {
    const h = harness({
      items: [
        { itemId: "A", text: "A 소개", sourceUris: ["kb://a"] },
        { itemId: "A", text: "A 중복", sourceUris: ["kb://a"] },
        { itemId: "bad", text: "출처 없음", sourceUris: [] },
        { itemId: "blank", text: "공백 출처", sourceUris: ["  "] },
        { itemId: "B", text: "B 소개", sourceUris: ["kb://b"] },
        { itemId: "C", text: "C 소개", sourceUris: ["kb://c"] },
        { itemId: "D", text: "D 소개", sourceUris: ["kb://d"] },
      ],
    });
    await h.scheduler.advance(999);
    expect(h.spoken).toEqual([]);
    await h.scheduler.advance(1);
    await h.scheduler.advance(2_000);
    expect(h.spoken.filter((s) => s.endsWith("소개"))).toEqual(["A 소개", "B 소개", "C 소개"]);
  });

  it("EX-03: abstained/source-empty 질문은 고정 기권한다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    const binding = h.controller.yieldForQuestion();
    expect(binding).toBeDefined();
    await h.controller.answerQuestion(binding!, "근거없음");
    expect(h.spoken.at(-1)).toBe("확인된 전시 자료에서는 그 답을 찾지 못했습니다.");

    const blankSource = harness({ answerSources: ["  "] });
    await blankSource.scheduler.advance(1_000);
    const blankBinding = blankSource.controller.yieldForQuestion()!;
    await blankSource.controller.answerQuestion(blankBinding, "출처 공백");
    expect(blankSource.spoken.at(-1)).toBe("확인된 전시 자료에서는 그 답을 찾지 못했습니다.");
  });

  it("EX-04/05: 질문은 먼저 interrupt하고 답변 뒤 미소개 항목으로 복귀하며 quiet는 재개하지 않는다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(500); // A
    const binding = h.controller.yieldForQuestion();
    expect(h.calls.at(-1)).toBe("interrupt");
    await h.controller.answerQuestion(binding!, "Naia가 뭐예요?");
    const answerIndex = h.calls.findIndex((c) => c.includes("사용자의 질문"));
    expect(answerIndex).toBeGreaterThan(h.calls.indexOf("interrupt"));
    await h.scheduler.advance(500);
    expect(h.spoken).toContain("Naia는 로컬 기억을 지원합니다.");

    h.controller.quiet();
    const count = h.spoken.length;
    await h.scheduler.advance(10_000);
    expect(h.spoken).toHaveLength(count);
    h.controller.resume();
    await h.scheduler.advance(500);
    expect(h.spoken.length).toBeGreaterThan(count);
  });

  it("PA-EX-02 keeps exhibition memory, transcript, raw-content logs and telemetry producers off", () => {
    const h = harness();
    expect(Object.keys(h.controller.dependencies())).not.toEqual(expect.arrayContaining([
      "memory",
      "conversationLog",
      "rawContentLog",
      "diagnosticLog",
      "telemetry",
    ]));
  });

  it("EX-04/05 race: yield 중 늦게 완료된 소개는 완료 처리하지 않고 다음 항목으로 복귀한다", async () => {
    let resolveB!: (value: "completed") => void;
    let delayed = false;
    const h = harness({
      items: [
        { itemId: "A", text: "A 소개", sourceUris: ["kb://a"] },
        { itemId: "B", text: "B 소개", sourceUris: ["kb://b"] },
        { itemId: "C", text: "C 소개", sourceUris: ["kb://c"] },
      ],
      speakImpl: (text) => {
        if (text === "B 소개" && !delayed) {
          delayed = true;
          return new Promise((resolve) => { resolveB = resolve; });
        }
        return Promise.resolve("completed");
      },
    });
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(500); // A completed
    const pendingB = h.scheduler.advance(500);
    await Promise.resolve();
    const binding = h.controller.yieldForQuestion()!;
    resolveB("completed");
    await pendingB;
    await h.controller.answerQuestion(binding, "질문");
    await h.scheduler.advance(500);
    expect(h.spoken.filter((text) => text === "B 소개")).toHaveLength(1);
    expect(h.spoken.at(-1)).toBe("C 소개");
  });

  it("EX-04/05 race: attracting 목록 로딩 중 질문해도 답변 뒤 A부터 소개를 재개한다", async () => {
    let resolveItems!: (items: { itemId: string; text: string; sourceUris: string[] }[]) => void;
    const h = harness({
      listImpl: () => new Promise((resolve) => { resolveItems = resolve; }),
    });
    const starting = h.scheduler.advance(1_000);
    await Promise.resolve();
    expect(h.controller.state()).toBe("attracting");
    const binding = h.controller.yieldForQuestion()!;
    const answering = h.controller.answerQuestion(binding, "무엇을 볼 수 있나요?");
    await Promise.resolve();
    resolveItems([
      { itemId: "A", text: "A 소개", sourceUris: ["kb://a"] },
      { itemId: "B", text: "B 소개", sourceUris: ["kb://b"] },
    ]);
    await starting;
    await answering;
    await h.scheduler.advance(500);
    expect(h.spoken).toContain("A 소개");
  });

  it("EX-01 lifecycle: 다음 idle activity는 동일 A/B/C를 새 cursor로 다시 소개한다", async () => {
    const h = harness({
      items: [
        { itemId: "A", text: "A 소개", sourceUris: ["kb://a"] },
        { itemId: "B", text: "B 소개", sourceUris: ["kb://b"] },
        { itemId: "C", text: "C 소개", sourceUris: ["kb://c"] },
      ],
    });
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(1_500);
    expect(h.spoken.filter((text) => text === "A 소개")).toHaveLength(1);
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(500);
    expect(h.spoken.filter((text) => text === "A 소개")).toHaveLength(2);
  });

  it("EX-05 lifecycle: 두 번째 목록 로딩 중 quiet/resume은 이전 목록을 재생하지 않는다", async () => {
    let listCall = 0;
    let resolveSecond!: (items: { itemId: string; text: string; sourceUris: string[] }[]) => void;
    const h = harness({
      listImpl: () => {
        listCall++;
        if (listCall === 1) {
          return Promise.resolve([
            { itemId: "A", text: "첫 활동 A", sourceUris: ["kb://a"] },
          ]);
        }
        return new Promise((resolve) => { resolveSecond = resolve; });
      },
    });
    await h.scheduler.advance(1_000);
    await h.scheduler.advance(500); // first activity completes
    const secondStart = h.scheduler.advance(1_000);
    await Promise.resolve();
    h.controller.quiet();
    h.controller.resume();
    const count = h.spoken.length;
    await Promise.resolve();
    expect(h.spoken).toHaveLength(count);
    resolveSecond([{ itemId: "B", text: "두 번째 활동 B", sourceUris: ["kb://b"] }]);
    await secondStart;
    await Promise.resolve();
    await h.scheduler.advance(500);
    expect(h.spoken.at(-1)).toBe("두 번째 활동 B");
  });

  it("EX-05 security: 같은 token 문자열이어도 과거 yield generation은 재사용할 수 없다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    const first = h.controller.yieldForQuestion()!;
    await h.controller.answerQuestion(first, "첫 질문");
    const second = h.controller.yieldForQuestion()!;
    expect(second.resumeToken).toBe(first.resumeToken); // test ID source intentionally repeats
    expect(second.yieldGeneration).toBeGreaterThan(first.yieldGeneration);
    await expect(h.controller.answerQuestion(first, "재전송 공격")).resolves.toBe(false);
    await expect(h.controller.answerQuestion(second, "두 번째 질문")).resolves.toBe(true);
  });

  it.each(["quiet", "stop", "reconfigure"] as const)(
    "EX-04 race: KB 응답 대기 중 %s이면 오래된 답을 발화하지 않는다",
    async (action) => {
      let resolveAnswer!: (value: { abstained: false; answer: string; sources: string[] }) => void;
      const h = harness({
        answerImpl: () => new Promise((resolve) => { resolveAnswer = resolve; }),
      });
      await h.scheduler.advance(1_000);
      const binding = h.controller.yieldForQuestion()!;
      const answering = h.controller.answerQuestion(binding, "지연 질문");
      await Promise.resolve();
      if (action === "quiet") h.controller.quiet();
      else if (action === "stop") h.controller.stop();
      else h.controller.configure(undefined);
      resolveAnswer({ abstained: false, answer: "오래된 답변", sources: ["kb://old"] });
      await expect(answering).resolves.toBe(true);
      expect(h.spoken).not.toContain("오래된 답변");
    },
  );

  it("EX-01 lifecycle: active configure disable은 이전 음성을 interrupt한다", async () => {
    const h = harness();
    await h.scheduler.advance(1_000);
    h.controller.configure(undefined);
    expect(h.calls.at(-1)).toBe("interrupt");
    expect(h.controller.state()).toBe("disabled");
  });
});
