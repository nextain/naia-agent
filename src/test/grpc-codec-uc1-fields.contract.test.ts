// emitToProto 필드 보존 — UC1 리뷰 HIGH fix 의 agent+proto 측 lock(도구결과/승인 페이로드 cross-repo 전송).
import { describe, it, expect } from "vitest";
import { emitToProto } from "../main/adapters/grpc/grpc-codec.js";
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
