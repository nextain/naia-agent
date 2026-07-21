// UC1 agent(brain) 계약 테스트 (P02). fake ProviderPort → ChatTurnHandler → egress 캡처.
import { describe, it, expect } from "vitest";
import { mapProviderChunk, isTerminalEmit, type AgentEmit, type ChatRequest } from "../main/domain/chat.js";
import { ChatTurnHandler, type HandlerDeps } from "../main/app/chat-turn-handler.js";
import { decodeRequest, encodeEmit } from "../main/adapters/protocol.js";
import { makeFakeProvider } from "../main/adapters/fake-provider.js";
import { makeInMemoryCredentials } from "../main/composition/index.js";
import { makeInMemoryApproval } from "../main/adapters/approval.js";
import type { ProviderPort, ProviderChatOpts } from "../main/ports/uc1.js";
import type { ProviderConfig, ChatMessage, ProviderChunk } from "../main/domain/chat.js";

function capture() {
  const emits: { requestId: string; e: AgentEmit }[] = [];
  const logs: string[] = [];
  const deps: HandlerDeps = {
    provider: makeFakeProvider(),
    conversation: { assemble: (r) => ({ messages: r.messages, ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}) }) },
    credentials: makeInMemoryCredentials(),
    approval: makeInMemoryApproval(),
    egress: { emit: (requestId, e) => emits.push({ requestId, e }) },
    diag: { log: (m) => logs.push(m) },
  };
  return { deps, emits, logs };
}
const req = (o: Partial<ChatRequest> = {}): ChatRequest => ({
  kind: "chat", requestId: "r1", provider: { provider: "ollama", model: "gemma4" }, messages: [{ role: "user", content: "hi" }], ...o,
});

describe("domain (agent UC1)", () => {
  it("mapProviderChunk: toolUse id→toolCallId, name→toolName", () => {
    expect(mapProviderChunk({ kind: "toolUse", id: "x", name: "n", args: {} })).toEqual({ kind: "toolUse", toolCallId: "x", toolName: "n", args: {} });
    expect(mapProviderChunk({ kind: "text", text: "a" })).toEqual({ kind: "text", text: "a" });
    expect(mapProviderChunk({ kind: "finish" })).toEqual({ kind: "finish" });
  });
  it("isTerminalEmit: finish/error 만", () => {
    expect(isTerminalEmit({ kind: "finish" })).toBe(true);
    expect(isTerminalEmit({ kind: "error", message: "e" })).toBe(true);
    expect(isTerminalEmit({ kind: "text", text: "a" })).toBe(false);
  });
});

describe("protocol (wire conform — os AgentOutbound↔AgentMessage)", () => {
  it("decodeRequest: chat_request/cancel/approval/creds + 미지=null", () => {
    expect(decodeRequest('{"type":"chat_request","requestId":"r1","provider":{"provider":"ollama","model":"m"},"messages":[]}')?.kind).toBe("chat");
    expect(decodeRequest('{"type":"cancel_stream","requestId":"r1"}')).toEqual({ kind: "cancel", requestId: "r1" });
    expect(decodeRequest('{"type":"creds_update","provider":"openai","apiKey":"sk"}')).toEqual({ kind: "credsUpdate", provider: "openai", secret: { apiKey: "sk" } });
    expect(decodeRequest('{"type":"discord_message"}')).toBeNull(); // 미지=null
    expect(decodeRequest("not json")).toBeNull();
    expect(decodeRequest("null")).toBeNull();   // JSON null = TypeError 방지(R1)
    expect(decodeRequest("3")).toBeNull(); expect(decodeRequest("true")).toBeNull();
  });
  it("encodeEmit: kind(camel)→type(snake), requestId 결속", () => {
    expect(encodeEmit("r1", { kind: "text", text: "hi" })).toEqual({ type: "text", requestId: "r1", text: "hi" });
    expect(encodeEmit("r1", { kind: "toolUse", toolCallId: "t", toolName: "n", args: {} })).toEqual({ type: "tool_use", requestId: "r1", toolCallId: "t", toolName: "n", args: {} });
    expect(encodeEmit("r1", { kind: "finish" })).toEqual({ type: "finish", requestId: "r1" });
  });
  it("UC-WIRE-V1 확장 필드를 stdio 경계에서 보존", () => {
    const d = decodeRequest(JSON.stringify({
      type: "chat_request",
      requestId: "r1",
      messages: [{
        role: "user",
        content: "image",
        attachments: [{
          id: "img_1",
          kind: "image",
          mimeType: "image/png",
          sizeBytes: 12,
          localRef: "local_1",
        }],
      }],
      grounding: { policy: "required", knowledgeScope: "workspace" },
      providerSession: { mode: "resume", providerSessionRef: "provider_ref_1" },
      processing: { processingProfileRef: "profile_1" },
    })) as ChatRequest;
    expect(d.messages[0]?.attachments?.[0]?.localRef).toBe("local_1");
    expect(d.grounding).toEqual({ policy: "required", knowledgeScope: "workspace" });
    expect(d.providerSession).toEqual({ mode: "resume", providerSessionRef: "provider_ref_1" });
    expect(d.processing).toEqual({ processingProfileRef: "profile_1" });

    expect(encodeEmit("r1", {
      kind: "grounding",
      status: "grounded",
      sources: [{ title: "KB", sourceUris: ["kb://workspace"] }],
    })).toMatchObject({ type: "grounding", status: "grounded" });
    expect(encodeEmit("r1", {
      kind: "providerSession",
      sessionId: "session_1",
      providerSessionRef: "provider_ref_1",
      state: "resumed",
    })).toMatchObject({ type: "provider_session", state: "resumed" });
  });
  it("decode 시 enableThinking top-level 보존", () => {
    const d = decodeRequest('{"type":"chat_request","requestId":"r1","provider":{"provider":"o","model":"m"},"messages":[],"enableThinking":true}');
    expect((d as ChatRequest).enableThinking).toBe(true);
  });
});

describe("ChatTurnHandler (turn 파이프라인)", () => {
  it("정상 1턴: fake provider → text→usage→finish 순, terminal 후 무방출", async () => {
    const { deps, emits } = capture();
    await new ChatTurnHandler(deps).onChatRequest(req());
    expect(emits.map((x) => x.e.kind)).toEqual(["text", "usage", "finish"]); // usage 는 finish 직전 1회
    expect(emits.every((x) => x.requestId === "r1")).toBe(true);
  });
  it("provider-native 도구는 즉시 실행하고 handled 이벤트를 한 번만 내보낸다", async () => {
    const { deps, emits } = capture();
    let executions = 0;
    const toolExecutor = {
      specs: () => [{ name: "get_time", description: "현재 시각", parameters: { type: "object" }, tier: "none" }],
      async execute(call: { id: string; name: string; args: unknown }) {
        executions++;
        expect(call.name).toBe("get_time");
        return { output: "10:30" };
      },
    };
    const native: ProviderPort = {
      async *chat(_c, _m, opts): AsyncIterable<ProviderChunk> {
        const call = { id: "native-1", name: "get_time", args: {} };
        yield { kind: "toolUse", ...call, handled: true };
        const result = await opts.executeTool!(call);
        yield { kind: "toolResult", ...call, output: result.output, success: !result.isError, handled: true };
        yield { kind: "text", text: "현재 10:30입니다." };
        yield { kind: "finish" };
      },
    };
    await new ChatTurnHandler({ ...deps, provider: native, toolExecutor }).onChatRequest(req());
    expect(executions).toBe(1);
    expect(emits.map(({ e }) => e.kind)).toEqual(["toolUse", "toolResult", "text", "usage", "finish"]);
    expect(emits.find(({ e }) => e.kind === "toolResult")?.e).toMatchObject({
      toolCallId: "native-1", toolName: "get_time", output: "10:30", success: true,
    });
  });
  it("provider rejection → usage→error(terminal), 레지스트리 해제", async () => {
    const { deps, emits } = capture();
    const failing: ProviderPort = { async *chat(_c: ProviderConfig, _m: readonly ChatMessage[], _o: ProviderChatOpts): AsyncIterable<ProviderChunk> { throw new Error("LLM down"); } };
    const h = new ChatTurnHandler({ ...deps, provider: failing });
    await h.onChatRequest(req());
    expect(emits.map((x) => x.e.kind)).toEqual(["usage", "error"]);
    expect(h.turnState("r1")).toBeUndefined(); // 해제
  });
  it("provider 동기 throw 도 catch→error(try 안)", async () => {
    const { deps, emits } = capture();
    const syncThrow: ProviderPort = { chat() { throw new Error("sync build fail"); } };
    await new ChatTurnHandler({ ...deps, provider: syncThrow }).onChatRequest(req());
    expect(emits.some((x) => x.e.kind === "error")).toBe(true);
  });
  it("무-terminal EOF(finish 없는 스트림) → usage→error", async () => {
    const { deps, emits } = capture();
    const noFinish: ProviderPort = { async *chat(): AsyncIterable<ProviderChunk> { yield { kind: "text", text: "a" }; } };
    const h = new ChatTurnHandler({ ...deps, provider: noFinish });
    await h.onChatRequest(req());
    expect(emits.map((x) => x.e.kind)).toEqual(["text", "usage", "error"]);
  });
  it("중복 requestId = 진단 로그만(wire error emit 금지)", async () => {
    const { deps, emits, logs } = capture();
    const h = new ChatTurnHandler(deps);
    // 첫 턴 진행 중 동일 id 재진입을 흉내: 첫 턴이 동기적으로 끝나므로, 별 방법 — 수동으로 두 번째를 첫 turn 활성 중 호출.
    const slow: ProviderPort = { async *chat(): AsyncIterable<ProviderChunk> { await new Promise((r) => setTimeout(r, 5)); yield { kind: "finish" }; } };
    const h2 = new ChatTurnHandler({ ...deps, provider: slow });
    const p = h2.onChatRequest(req());            // 활성
    await h2.onChatRequest(req());                // 중복(활성 중) → 로그
    await p;
    expect(logs.some((l) => l.includes("duplicate"))).toBe(true);
    expect(emits.some((x) => x.e.kind === "error" && (x.e as { message: string }).message.includes("duplicate"))).toBe(false); // wire error 없음
    void h;
  });
  it("cancel: provider 가 abort 무시해도 self-break→터미널 error('cancelled')+레지스트리 해제(누수 방지, 코드리뷰 R2)", async () => {
    const { deps, emits } = capture();
    // abort 무시하는 provider(무한에 가까운 스트림)
    const ignoreAbort: ProviderPort = { async *chat(): AsyncIterable<ProviderChunk> { for (let i=0;i<1000;i++){ await Promise.resolve(); yield { kind:"text", text:String(i) }; } } };
    const h = new ChatTurnHandler({ ...deps, provider: ignoreAbort });
    const p = h.onChatRequest(req());
    await Promise.resolve();           // 첫 chunk 처리 진입
    h.onCancel({ kind: "cancel", requestId: "r1" });
    await p;
    const last = emits[emits.length-1]!.e;
    expect(last.kind).toBe("error"); expect((last as {message:string}).message).toBe("cancelled");
    expect(h.turnState("r1")).toBeUndefined();  // 해제
  });
  it("cancel: provider 가 abort 시 throw(AbortError) 해도 종결='cancelled'(catch 통일, 코드리뷰 R3)", async () => {
    const { deps, emits } = capture();
    const throwOnAbort: ProviderPort = { async *chat(_c:ProviderConfig,_m:readonly ChatMessage[],o:ProviderChatOpts): AsyncIterable<ProviderChunk> {
      yield { kind:"text", text:"a" };
      while(!o.signal?.aborted) await Promise.resolve();
      throw Object.assign(new Error("The operation was aborted"), { name:"AbortError" });
    } };
    const h = new ChatTurnHandler({ ...deps, provider: throwOnAbort });
    const p = h.onChatRequest(req());
    await Promise.resolve();
    h.onCancel({ kind:"cancel", requestId:"r1" });
    await p;
    const last = emits[emits.length-1]!.e;
    expect(last.kind).toBe("error"); expect((last as {message:string}).message).toBe("cancelled");  // AbortError 아님
  });
  it("cancel: provider 가 abort 무시 *및* next() 영구대기(hang) 해도 race 로 종결+해제(코드리뷰 R5)", async () => {
    const { deps, emits } = capture();
    // 첫 chunk 후 영구 hang(다음 next() 가 resolve 안 됨, abort 도 무시) — for-await 면 누수.
    const hang: ProviderPort = { async *chat(): AsyncIterable<ProviderChunk> { yield { kind:"text", text:"a" }; await new Promise(()=>{}); } };
    const h = new ChatTurnHandler({ ...deps, provider: hang });
    const p = h.onChatRequest(req());
    await Promise.resolve(); await Promise.resolve();
    h.onCancel({ kind:"cancel", requestId:"r1" });
    await p;   // race 로 abort 가 이겨 종료 — hang 이면 이 await 가 영구 블록(테스트 타임아웃)
    const last = emits[emits.length-1]!.e;
    expect(last.kind).toBe("error"); expect((last as {message:string}).message).toBe("cancelled");
    expect(h.turnState("r1")).toBeUndefined();
  });
  it("creds_update → providerConfig 에 secret 주입(다음 chat)", async () => {
    const { deps } = capture();
    let seenConfig: ProviderConfig | null = null;
    const spy: ProviderPort = { async *chat(c: ProviderConfig): AsyncIterable<ProviderChunk> { seenConfig = c; yield { kind: "finish" }; } };
    const h = new ChatTurnHandler({ ...deps, provider: spy });
    h.onCredsUpdate({ kind: "credsUpdate", provider: "ollama", secret: { apiKey: "sk-1" } });
    await h.onChatRequest(req());
    expect(seenConfig!.apiKey).toBe("sk-1"); // creds_update 채널 → providerConfig 주입
  });
});
