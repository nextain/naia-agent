// UC-compaction(FR-COMPACT) 계약 — compaction host-loop: 예산 압박 시 head 를 memory 가 요약(recap)해
// systemPrompt 에 주입 + 메시지는 tail 만 provider 로. 드롭형 budgeted-conversation 은 폴백. spawn 없이 fake 포트로 결정론 검증.
// @spec SPEC-008  (REQ-010 / UC-013)
import { describe, it, expect } from "vitest";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ProviderPort, ProviderChatOpts } from "../main/ports/uc1.js";
import type { CompactionPort, HandoffBlob } from "../main/ports/compaction.js";
import type { ChatRequest, AgentEmit, ProviderConfig, ChatMessage, ProviderChunk } from "../main/domain/chat.js";

/** systemPrompt + 도달 messages 캡처 provider — recap 주입·tail 절단 검증용. */
function capturingProvider() {
  const seen: Array<string | undefined> = [];
  const seenMsgs: Array<readonly ChatMessage[]> = [];
  const provider: ProviderPort = {
    // eslint-disable-next-line require-yield
    async *chat(_c: ProviderConfig, m: readonly ChatMessage[], o: ProviderChatOpts): AsyncIterable<ProviderChunk> {
      seen.push(o.systemPrompt);
      seenMsgs.push(m);
      yield { kind: "text", text: "응답" };
      yield { kind: "finish" };
    },
  };
  return { provider, seen, seenMsgs };
}

function fakeCompaction(o: { recap?: string; droppedCount?: number; throwCompact?: boolean } = {}) {
  const calls = { compact: 0, attach: [] as HandoffBlob[] };
  const port: CompactionPort = {
    async compact(req) {
      calls.compact++;
      if (o.throwCompact) throw new Error("compact down");
      return { recap: o.recap ?? "SUMMARY_ZZZ", droppedCount: o.droppedCount ?? (req.messages.length - req.keepTail) };
    },
    async attachHandoff(blob) { calls.attach.push(blob); },
  };
  return { port, calls };
}

function harness(o: {
  provider: ProviderPort; compaction?: CompactionPort;
  compactThresholdTokens?: number; compactKeepTail?: number; compactTargetTokens?: number;
}) {
  const emits: AgentEmit[] = [];
  const deps: HandlerDeps = {
    provider: o.provider,
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    egress: { emit: (_id, e) => emits.push(e) },
    diag: { log: () => {} },
    ...(o.compaction ? { compaction: o.compaction } : {}),
    ...(o.compactThresholdTokens !== undefined ? { compactThresholdTokens: o.compactThresholdTokens } : {}),
    ...(o.compactKeepTail !== undefined ? { compactKeepTail: o.compactKeepTail } : {}),
    ...(o.compactTargetTokens !== undefined ? { compactTargetTokens: o.compactTargetTokens } : {}),
  };
  return { deps, emits };
}

// 6 메시지 — 마지막은 현재 user 입력(tail 보존 검증). 합 ≈32 추정토큰.
const bigConvo = (): ChatMessage[] => [
  { role: "user", content: "old1" }, { role: "assistant", content: "old2" },
  { role: "user", content: "old3" }, { role: "assistant", content: "old4" },
  { role: "user", content: "recent1" }, { role: "user", content: "LAST_USER" },
];
const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat", requestId: "r1", provider: { provider: "ollama", model: "gemma4" }, messages: bigConvo(), ...o,
});

describe("UC-compaction (SPEC-008) — compaction host-loop", () => {
  it("예산 초과 → compact 호출 + recap 을 systemPrompt 주입 + 메시지는 tail 만", async () => {
    const { provider, seen, seenMsgs } = capturingProvider();
    const { port, calls } = fakeCompaction();
    const { deps, emits } = harness({ provider, compaction: port, compactThresholdTokens: 5, compactKeepTail: 2 });
    await new ChatTurnHandler(deps).onChatRequest(req());
    // 압축 발생 시 'compacted' wire 이벤트가 *맨 앞*(provider 라운드 전) 방출 → UI 표시용. 그 뒤 정상 종결.
    expect(emits.map((e) => e.kind)).toEqual(["compacted", "text", "usage", "finish"]);
    const compactedEmit = emits.find((e) => e.kind === "compacted") as { kind: "compacted"; droppedCount: number } | undefined;
    expect(compactedEmit?.droppedCount).toBe(4);                            // bigConvo 6 - keepTail 2 = 4 흡수
    expect(calls.compact).toBe(1);                                          // 압축 호출됨
    expect(seenMsgs[0]!.length).toBe(2);                                    // tail 만(keepTail=2)
    expect(seenMsgs[0]![1]!.content).toBe("LAST_USER");                     // 현재 입력 보존
    expect(seen[0]).toContain("SUMMARY_ZZZ");                               // recap 이 provider systemPrompt 에 도달
    expect(seen[0]).toContain("이전 대화 요약");                            // 압축 프레이밍
  });

  it("provider-safe: 압축된 tail 선두를 user 경계에 정렬(leading assistant 제거)", async () => {
    const { provider, seenMsgs } = capturingProvider();
    const { port, calls } = fakeCompaction();
    // keepTail=3 → 경계(index 3)가 assistant("old4") → user("recent1")로 전진 → tail 선두 user.
    const { deps } = harness({ provider, compaction: port, compactThresholdTokens: 5, compactKeepTail: 3 });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(calls.compact).toBe(1);
    expect(seenMsgs[0]![0]!.role).toBe("user");                            // 선두가 user(엄격 provider 400 회피)
    expect(seenMsgs[0]![seenMsgs[0]!.length - 1]!.content).toBe("LAST_USER"); // 현재 입력 보존
  });

  it("recap+anchors 영속(attachHandoff) — 압축 시 fire-and-forget 호출", async () => {
    const { provider } = capturingProvider();
    const { port, calls } = fakeCompaction({ recap: "RECAP_PERSIST" });
    const { deps } = harness({ provider, compaction: port, compactThresholdTokens: 5, compactKeepTail: 2 });
    await new ChatTurnHandler(deps).onChatRequest(req({ sessionId: "sess-x" }));
    expect(calls.attach).toHaveLength(1);
    expect(calls.attach[0]!.recap).toBe("RECAP_PERSIST");
    expect(calls.attach[0]!.sessionId).toBe("sess-x");
    expect(calls.attach[0]!.trigger).toBe("budget");
  });

  it("임계 이하 → 압축 안 함(compact 미호출, 전체 메시지 도달)", async () => {
    const { provider, seen, seenMsgs } = capturingProvider();
    const { port, calls } = fakeCompaction();
    // 기본 threshold(4000) — 작은 대화는 미달.
    const { deps } = harness({ provider, compaction: port });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(calls.compact).toBe(0);            // 압축 안 함
    expect(seenMsgs[0]!.length).toBe(6);      // 전체 유지
    expect(seen[0]).toBeUndefined();          // recap 주입 없음
  });

  it("droppedCount 0 → 원본 유지(압축 미수행)", async () => {
    const { provider, seenMsgs } = capturingProvider();
    const { port, calls } = fakeCompaction({ droppedCount: 0 });
    const { deps } = harness({ provider, compaction: port, compactThresholdTokens: 5, compactKeepTail: 2 });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(calls.compact).toBe(1);            // 시도는 함
    expect(seenMsgs[0]!.length).toBe(6);      // 그러나 droppedCount 0 → 원본
  });

  it("직교 compaction ⊥ chat: compact throw 해도 턴 finish(드롭 폴백, 원본 메시지)", async () => {
    const { provider, seen, seenMsgs } = capturingProvider();
    const { port } = fakeCompaction({ throwCompact: true });
    const { deps, emits } = harness({ provider, compaction: port, compactThresholdTokens: 5, compactKeepTail: 2 });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]); // 압축 실패가 턴 안 깸
    expect(seenMsgs[0]!.length).toBe(6);                                    // 원본 유지(드롭 폴백)
    expect(seen[0]).toBeUndefined();                                        // recap 없음
  });

  it("compaction 미주입 → 무회귀(정상 finish, 전체 메시지)", async () => {
    const { provider, seen, seenMsgs } = capturingProvider();
    const { deps, emits } = harness({ provider, compactThresholdTokens: 5, compactKeepTail: 2 });
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((e) => e.kind)).toEqual(["text", "usage", "finish"]);
    expect(seenMsgs[0]!.length).toBe(6);
    expect(seen[0]).toBeUndefined();
  });
});
