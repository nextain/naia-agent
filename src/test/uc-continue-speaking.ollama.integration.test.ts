// UC-015 / AC9 — 로컬 Ollama 실연동 통합 검증 (Issue #82).
//
// 왜 이 파일이 따로 있나: contract 테스트(fake provider)는 *기능 게이트*다 — 핸들러가 계약대로 동작하는지만 본다.
// 그것이 green 이어도 "시연 모델이 continue_speaking 을 실제로 고르는가"는 알 수 없다(도구 설명·모델 능력 문제).
// AC9 는 그 별도 게이트다: 고정 시연 문장 + 실제 로컬 Ollama 로, 독립 2회 모두 모델이 스스로 도구를 선택하고
// 2개 이상 발화를 이어가는지 실측한다. 실패 시 정직하게 보고하며 **키워드 우회로 성공 처리하지 않는다**(계약 AC9).
//
// 게이팅: NAIA_OLLAMA_INTEGRATION=1 일 때만 실행(무인 CI 는 미실행 — 네트워크/GPU 의존).
//   ⚠️ 게이트가 켜졌는데 endpoint/모델이 없으면 **skip 이 아니라 fail**(계약: "시연 준비 실패로 판정하며 skip하지 않는다").
//   skip 으로 넘기면 "green 인데 시연은 깨진" 상태를 못 잡는다.
//
// 판정 seam: diag.debug. text 이벤트는 per-chunk 스트리밍이라 발화 수와 1:1 이 아니므로 셀 수 없다.
//   "연속 발화 활성화" = 모델이 도구를 골랐고 userRequestQuote 가 원문에 실제로 존재해 app 이 수락함(위조 불가).
//   "연속 발화 완료"   = 자율 후속 호출이 최종 텍스트를 낸 횟수 = 발화 수.
//
// 러닝타임 bound: 도구 인자 기본값이 10분/60발화라 실시계로 두면 테스트가 10분간 돈다. 모델의 *선택* 은 실제로
//   두고, 목표 발화에 도달한 뒤 **가상 시계만** deadline 너머로 밀어 정상 finish 시킨다(취소가 아니므로 error 0 유지).
//   시계 주입은 계약이 명시한 결정론 테스트 seam(continuationClock)이다.
import { describe, expect, it, afterAll } from "vitest";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import { makeOllamaProvider } from "../main/adapters/ollama-provider.js";
import type { AgentEmit, ChatRequest } from "../main/domain/chat.js";

const GATE_ON = process.env.NAIA_OLLAMA_INTEGRATION === "1";

/** 계약 고정값 — 시연 환경과 동일해야 의미가 있다(임의 교체 금지). */
const ENDPOINT = "http://127.0.0.1:11434";
const MODEL = "dnotitia-dna3.0-9b-q4-16k:latest";
const USER_TEXT = "라디오처럼 뭐라도 계속 이야기해 줘. 난 씻고 올게.";

/** AC9 최소 요구 = 2개 이상. 도달 즉시 시계를 밀어 종료(발화당 실 LLM 호출이라 상한을 둔다). */
const REQUIRED_UTTERANCES = 2;
const PER_RUN_TIMEOUT_MS = 240_000;
const EVIDENCE_PATH = path.join(process.cwd(), ".agents", "reviews", "issue-82-ollama-integration-2026-07-16.json");

interface ContinuationClock {
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<boolean>;
}
type ContinuationDeps = HandlerDeps & { readonly continuationClock?: ContinuationClock };

interface RunRecord {
  requestId: string;
  model: string;
  endpoint: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  activated: boolean;
  utterances: number;
  /** 이벤트 종류를 run-length 로 압축(text/thinking 은 per-chunk 라 원배열이 수백~수천 줄이 된다). */
  eventShape: string;
  usageCount: number;
  finishCount: number;
  errorCount: number;
  errors: string[];
  pass: boolean;
}

const runs: RunRecord[] = [];

/** 게이트 ON 인데 준비가 안 됐으면 fail — 원인을 문장으로 남겨 "왜 시연이 깨지는지"가 바로 보이게. */
async function preflight(): Promise<void> {
  let tags: { models?: Array<{ name?: string }> };
  try {
    const resp = await fetch(`${ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`GET /api/tags → ${resp.status} ${resp.statusText}`);
    tags = (await resp.json()) as { models?: Array<{ name?: string }> };
  } catch (e) {
    throw new Error(`시연 준비 실패 — Ollama endpoint(${ENDPOINT}) 응답 없음: ${(e as Error).message}`);
  }
  const names = (tags.models ?? []).map((m) => m.name ?? "");
  if (!names.includes(MODEL)) {
    throw new Error(`시연 준비 실패 — 모델 '${MODEL}' 미설치. 설치된 모델: ${names.join(", ") || "(없음)"}`);
  }
}

/** 턴 1회 = 새 핸들러/새 상태. requestId 는 호출자가 달리 준다(계약: 독립 2회). */
async function runOnce(requestId: string): Promise<RunRecord> {
  const events: { requestId: string; event: AgentEmit }[] = [];
  const debug: { message: string; ctx: unknown }[] = [];
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const utterances = (): number => debug.filter((d) => d.message === "연속 발화 완료").length;

  // 가상 시계: now() 는 단조 증가하되 테스트가 제어한다. 목표 발화 도달 후 wait() 에서 deadline 너머로 점프 →
  // 핸들러의 대기-후 경계검사가 정상 finish 로 종료(AC5 경로). 실제 pause 는 하지 않아 러닝타임을 줄인다.
  let virtualNow = 0;
  const clock: ContinuationClock = {
    now: () => virtualNow,
    wait: async (_ms, signal) => {
      if (signal.aborted) return false;
      if (utterances() >= REQUIRED_UTTERANCES) virtualNow += 60 * 60 * 1000; // deadline(최대 30분) 확실히 초과
      return true;
    },
  };

  const deps: ContinuationDeps = {
    provider: makeOllamaProvider(),
    conversation: {
      assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }),
    },
    credentials: { update: () => {}, get: () => undefined },
    approval: makeInMemoryApproval(),
    egress: { emit: (rid, event) => events.push({ requestId: rid, event }) },
    diag: { log: () => {}, debug: (message, ctx) => debug.push({ message, ctx }) },
    continuationClock: clock,
  };

  const req: ChatRequest = {
    kind: "chat",
    requestId,
    sessionId: `ac9-${requestId}`,
    provider: { provider: "ollama", model: MODEL, ollamaHost: ENDPOINT },
    messages: [{ role: "user", content: USER_TEXT }],
  };

  await new ChatTurnHandler(deps).onChatRequest(req);

  const kinds = events.map((e) => e.event.kind);
  // run-length 인코딩 — "thinking×433,text×230,usage,finish" 처럼 순서와 규모를 한 줄로 남긴다.
  const shape = kinds
    .reduce<Array<{ kind: string; n: number }>>((acc, k) => {
      const last = acc[acc.length - 1];
      if (last && last.kind === k) last.n++;
      else acc.push({ kind: k, n: 1 });
      return acc;
    }, [])
    .map((r) => (r.n > 1 ? `${r.kind}×${r.n}` : r.kind))
    .join(",");
  const errs = events
    .map((e) => e.event)
    .filter((e): e is Extract<AgentEmit, { kind: "error" }> => e.kind === "error")
    .map((e) => String((e as unknown as { message?: unknown }).message ?? "error"));

  const rec: RunRecord = {
    requestId,
    model: MODEL,
    endpoint: ENDPOINT,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    activated: debug.some((d) => d.message === "연속 발화 활성화"),
    utterances: utterances(),
    eventShape: shape,
    usageCount: kinds.filter((k) => k === "usage").length,
    finishCount: kinds.filter((k) => k === "finish").length,
    errorCount: errs.length,
    errors: errs,
    pass: false,
  };
  rec.pass =
    rec.activated &&
    rec.utterances >= REQUIRED_UTTERANCES &&
    rec.usageCount === 1 &&
    rec.finishCount === 1 &&
    rec.errorCount === 0 &&
    events.every((e) => e.requestId === requestId);
  runs.push(rec);
  return rec;
}

afterAll(() => {
  if (!GATE_ON) return;
  // 증적은 재현 가능해야 한다(agents-rules: measured_claims_reproducible) — 두 실행의 원자료를 그대로 남긴다.
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        issue: "https://github.com/nextain/naia-agent/issues/82",
        stage: "integration",
        acceptance: "AC9",
        date: "2026-07-16",
        endpoint: ENDPOINT,
        model: MODEL,
        userText: USER_TEXT,
        requiredUtterances: REQUIRED_UTTERANCES,
        command: "$env:NAIA_OLLAMA_INTEGRATION='1'; pnpm exec vitest run src/test/uc-continue-speaking.ollama.integration.test.ts",
        runs,
        verdict: runs.length === 2 && runs.every((r) => r.pass) ? "PASS" : "FAIL",
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
});

describe.skipIf(!GATE_ON)("UC-015 AC9 — 로컬 Ollama 실연동(고정 시연 문장, 독립 2회)", () => {
  it("preflight: endpoint 응답 + 지정 시연 모델 설치 (없으면 skip 아닌 fail)", async () => {
    await expect(preflight()).resolves.toBeUndefined();
  }, 30_000);

  it(
    "1회차: 모델이 continue_speaking 을 실제로 선택하고 2개 이상 발화 (usage 1 / finish 1 / error 0)",
    async () => {
      const r = await runOnce("ac9-run-1");
      expect(r.activated, `모델이 continue_speaking 을 선택하지 않음 — 도구 설명/모델 능력의 실측 한계. events=${r.eventShape}`).toBe(true);
      expect(r.utterances, `발화 ${r.utterances}회(요구 ${REQUIRED_UTTERANCES}회 이상)`).toBeGreaterThanOrEqual(REQUIRED_UTTERANCES);
      expect(r.errors, "error 이벤트 0 이어야 함").toEqual([]);
      expect(r.usageCount, "usage 정확히 1회").toBe(1);
      expect(r.finishCount, "finish 정확히 1회").toBe(1);
      expect(r.pass).toBe(true);
    },
    PER_RUN_TIMEOUT_MS,
  );

  it(
    "2회차: 새 상태·새 requestId 로 독립 재현",
    async () => {
      const r = await runOnce("ac9-run-2");
      expect(r.activated, `2회차 미선택 — 재현성 없음(1회차 성공은 우연). events=${r.eventShape}`).toBe(true);
      expect(r.utterances).toBeGreaterThanOrEqual(REQUIRED_UTTERANCES);
      expect(r.errors).toEqual([]);
      expect(r.usageCount).toBe(1);
      expect(r.finishCount).toBe(1);
      expect(r.pass).toBe(true);
    },
    PER_RUN_TIMEOUT_MS,
  );
});
