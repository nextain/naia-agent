// emitToProto 필드 보존 — UC1 리뷰 HIGH fix 의 agent+proto 측 lock(도구결과/승인 페이로드 cross-repo 전송).
import { describe, it, expect } from "vitest";
import {
  chatRequestToDomain,
  credsToDomain,
  emitToProto,
} from "../main/adapters/grpc/grpc-codec.js";
import type { AgentEmit } from "../main/domain/chat.js";

describe("emitToProto — UC1 필드 보존(agent→gRPC)", () => {
  it("★ toolResult: toolName+success 를 proto 로 전송(os ChatPanel chunk.success)", () => {
    const e: AgentEmit = { kind: "toolResult", toolCallId: "t", output: "ok", toolName: "write_file", success: false };
    const p = emitToProto("r1", e);
    expect(p.toolResult).toMatchObject({ toolCallId: "t", output: "ok", toolName: "write_file", success: false });
  });
  it("★ approvalRequest: args(JSON)+description 전송(blind approval 방지)", () => {
    const e: AgentEmit = { kind: "approvalRequest", toolCallId: "t", toolName: "execute_command", tier: "T2", args: { command: "rm x" }, description: "삭제" };
    const p = emitToProto("r1", e);
    expect(p.approvalRequest).toMatchObject({ toolCallId: "t", toolName: "execute_command", tier: "T2", description: "삭제" });
    expect(JSON.parse((p.approvalRequest as { argsJson: string }).argsJson)).toEqual({ command: "rm x" });
  });
});

// creds_update presence 시맨틱 lock — graft step1(온보딩 나이아 계정 creds/auth push) 의 load-bearing 계약.
// proto3 `optional string`(oneofs:true) presence 가 credsToDomain 의 `!== undefined` 와 일치해야:
//   빈 ""(present) = 명시 unset(secret 에 포함) / omit(undefined) = 키체인 fallback(secret 에서 생략).
// 이게 깨지면(예: oneofs:false 로 omit→"" 오염) native 키 unset/키체인 fallback 이 조용히 회귀.
describe("credsToDomain — creds presence(빈=unset vs omit=fallback) lock", () => {
  it("apiKey:'' (present) → secret.apiKey='' 포함(명시 unset 신호)", () => {
    const d = credsToDomain({ provider: "openai", apiKey: "" } as never);
    expect("apiKey" in d.secret).toBe(true);
    expect(d.secret.apiKey).toBe("");
  });
  it("apiKey omit(undefined) → secret 에 apiKey 필드 없음(키체인 fallback 보존)", () => {
    const d = credsToDomain({ provider: "openai", naiaKey: "nk" } as never);
    expect("apiKey" in d.secret).toBe(false);
    expect(d.secret.naiaKey).toBe("nk");
  });
  it("naiaKey:'' (present) → secret.naiaKey='' 포함(명시 unset)", () => {
    const d = credsToDomain({ provider: "nextain", naiaKey: "" } as never);
    expect("naiaKey" in d.secret).toBe(true);
    expect(d.secret.naiaKey).toBe("");
  });
});

describe("UC-WIRE-V1 paired shell contract", () => {
  it("preserves Discord channel, attachments, grounding, provider session, and processing", () => {
    const request = chatRequestToDomain({
      requestId: "req_1",
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
      channel: {
        discord: {
          bindingId: "binding_1",
          guildId: "100",
          channelId: "200",
          userId: "300",
        },
      },
      grounding: { policy: "REQUIRED", knowledgeScope: "workspace" },
      providerSession: { mode: "RESUME", providerSessionRef: "provider_ref_1" },
      processing: { processingProfileRef: "default" },
    });
    expect(request).toMatchObject({
      channel: {
        kind: "discord",
        bindingId: "binding_1",
        guildId: "100",
        channelId: "200",
        userId: "300",
      },
      grounding: { policy: "required", knowledgeScope: "workspace" },
      providerSession: { mode: "resume", providerSessionRef: "provider_ref_1" },
      processing: { processingProfileRef: "default" },
    });
    expect(request.messages[0]?.attachments?.[0]?.localRef).toBe("local_1");
  });

  it("encodes grounding, artifact, and provider-session events without flattening", () => {
    expect(emitToProto("req_1", {
      kind: "grounding",
      status: "grounded",
      sources: [{ title: "KB", sourceUris: ["kb://workspace"] }],
    }).grounding).toMatchObject({ status: "GROUNDED" });
    expect(emitToProto("req_1", {
      kind: "artifact",
      artifact: {
        id: "img_1",
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 12,
        localRef: "local_1",
      },
    }).artifact).toBeDefined();
    expect(emitToProto("req_1", {
      kind: "providerSession",
      sessionId: "session_1",
      providerSessionRef: "provider_ref_1",
      state: "resumed",
    }).providerSession).toMatchObject({ state: "RESUMED" });
  });
});
