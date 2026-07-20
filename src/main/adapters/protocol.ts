// adapters/protocol — wire ↔ domain 변환 (계약 §B.4). 공유 wire(H-agent) conform.
// os AgentOutbound(wire) → AgentRequest(domain) decode / AgentEmit(domain) → os AgentMessage(wire) encode.
import type {
  AgentRequest,
  AgentEmit,
  ProviderConfig,
  ChatMessage,
  EnvironmentSegment,
  GroundingRequest,
  ProviderSessionRequest,
} from "../domain/chat.js";

/** wire environmentSegments(unknown) → EnvironmentSegment[] 안전 디코드(S4). 화이트리스트(avatarEmotion|panel|responseStyle) 외 드롭.
 *  비배열/잘못된 모양 = []. panel.entries 는 {type:string, data} 만 채택(자유 텍스트 위조 주입 차단 — 코어 domain 이 격리).
 *  responseStyle 은 style enum("brief"|"normal") 만 채택(미지 style=normal 폴백, 자유 텍스트 주입 경로 없음). */
export function decodeEnvironmentSegments(v: unknown): EnvironmentSegment[] {
  if (!Array.isArray(v)) return [];
  const out: EnvironmentSegment[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") continue;
    const kind = (s as Record<string, unknown>)["kind"];
    if (kind === "avatarEmotion") {
      out.push({ kind: "avatarEmotion" });
    } else if (kind === "panel") {
      const rawEntries = (s as Record<string, unknown>)["entries"];
      const entries = Array.isArray(rawEntries)
        ? rawEntries
            .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as Record<string, unknown>)["type"] === "string")
            .map((e) => ({ type: String(e["type"]), data: e["data"] }))
        : [];
      out.push({ kind: "panel", entries });
    } else if (kind === "responseStyle") {
      // style 은 enum 만 — "brief" 만 효과, 그 외(미지정 포함)는 "normal"(무영향)로 정규화. 자유 텍스트 주입 경로 없음.
      const style = (s as Record<string, unknown>)["style"] === "brief" ? "brief" : "normal";
      out.push({ kind: "responseStyle", style });
    }
    // 그 외 kind = 드롭(화이트리스트).
  }
  return out;
}

/** wire line → AgentRequest. parseRequest(관대): type 화이트리스트, 미지=null. */
export function decodeRequest(line: string): AgentRequest | null {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null; // ⚠️ "null"/"3"/"true" 등 = TypeError 방지(baseline parseRequest 가드)
  const o = parsed as Record<string, unknown>;
  const type = typeof o["type"] === "string" ? (o["type"] as string) : undefined;
  switch (type) {
    case "chat_request": {
      // provider override 는 비어있지 않은 provider 문자열이 있을 때만 채택. 없거나 빈 객체 = undefined →
      // agent 가 기동 시 naia-settings 로딩한 defaultConfig 사용(정본: "대화는 메시지만"). 빈 {} 가 default 를 덮지 않게.
      const prov = o["provider"];
      const hasProv = !!prov && typeof prov === "object" && typeof (prov as Record<string, unknown>)["provider"] === "string" && (prov as Record<string, unknown>)["provider"] !== "";
      return {
        kind: "chat",
        requestId: str(o["requestId"]),
        ...(hasProv ? { provider: prov as ProviderConfig } : {}),
        messages: (Array.isArray(o["messages"]) ? o["messages"] : []) as ChatMessage[],
        // ⚠️ systemPrompt override(C2/C1 신뢰모델): wire 의 systemPrompt 는 코어 조립(persona⊕workspace⊕
        // environment)을 *무조건 덮는다*. 이는 **신뢰 로컬 단일유저** 모델(C1)에서만 수용 — 클라(naia-os
        // --system/voice/discord)는 신뢰됨(악성 클라면 .keys 를 직접 읽으므로 systemPrompt 게이팅은 무의미,
        // GLM 위협모델). naia-os **텍스트 채팅은 systemPrompt 를 안 보내고 environmentSegments 만** 보내
        // persona 가 보존된다(S4). 원격/멀티테넌트 전개 시엔 override 게이팅 필요(미래 — NFR-PERSONA-trust-model).
        ...(o["systemPrompt"] !== undefined ? { systemPrompt: str(o["systemPrompt"]) } : {}),
        ...(o["environmentSegments"] !== undefined ? { environmentSegments: decodeEnvironmentSegments(o["environmentSegments"]) } : {}),
        ...(o["enableTools"] !== undefined ? { enableTools: !!o["enableTools"] } : {}),
        ...(o["enableThinking"] !== undefined ? { enableThinking: !!o["enableThinking"] } : {}),
        ...(o["gatewayUrl"] !== undefined ? { gatewayUrl: str(o["gatewayUrl"]) } : {}),
        ...(o["disabledSkills"] !== undefined ? { disabledSkills: o["disabledSkills"] as string[] } : {}),
        ...(decodeChannel(o["channel"]) ? { channel: decodeChannel(o["channel"])! } : {}),
        ...(o["grounding"] && typeof o["grounding"] === "object"
          ? { grounding: o["grounding"] as GroundingRequest }
          : {}),
        ...(o["providerSession"] && typeof o["providerSession"] === "object"
          ? { providerSession: o["providerSession"] as ProviderSessionRequest }
          : {}),
        ...(o["processing"] && typeof o["processing"] === "object" ? {
          processing: {
            processingProfileRef: str((o["processing"] as Record<string, unknown>)["processingProfileRef"]),
          },
        } : {}),
      };
    }
    case "cancel_stream":
      return { kind: "cancel", requestId: str(o["requestId"]) };
    case "approval_response":
      return { kind: "approvalResponse", requestId: str(o["requestId"]), toolCallId: str(o["toolCallId"]), decision: o["decision"] === "approve" ? "approve" : "reject" };
    case "creds_update":
      return { kind: "credsUpdate", provider: str(o["provider"]), secret: { ...(o["apiKey"] !== undefined ? { apiKey: str(o["apiKey"]) } : {}), ...(o["naiaKey"] !== undefined ? { naiaKey: str(o["naiaKey"]) } : {}) } };
    case "tool_request":
      // old-core standalone 스킬 호출 — new-core 미지원. router 가 즉시 error 응답(셸 120s 행 방지).
      return { kind: "toolRequest", requestId: str(o["requestId"]), toolName: str(o["toolName"]) };
    default:
      return null; // 미지 = router 가 무시+log
  }
}

/** AgentEmit(domain) → os AgentMessage(wire). kind(camel)→type(snake), requestId 결속. */
export function encodeEmit(requestId: string, e: AgentEmit): Record<string, unknown> {
  switch (e.kind) {
    case "text": return { type: "text", requestId, text: e.text };
    case "thinking": return { type: "thinking", requestId, text: e.text };
    case "toolUse": return { type: "tool_use", requestId, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args };
    case "toolResult": return { type: "tool_result", requestId, toolCallId: e.toolCallId, output: e.output, toolName: e.toolName, success: e.success }; // UC1 리뷰: success/toolName
    case "approvalRequest": return { type: "approval_request", requestId, toolCallId: e.toolCallId, toolName: e.toolName, tier: e.tier, args: e.args, description: e.description }; // UC1 리뷰: args/description
    case "gatewayApprovalRequest": return { type: "gateway_approval_request", requestId, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args };
    case "usage": return { type: "usage", requestId, inputTokens: e.inputTokens, outputTokens: e.outputTokens, ...(e.cost !== undefined ? { cost: e.cost } : {}), ...(e.model !== undefined ? { model: e.model } : {}) };
    case "logEntry": return { type: "log_entry", requestId, level: e.level, message: e.message };
    case "tokenWarning": return { type: "token_warning", requestId, raw: e.raw };
    case "compacted": return { type: "compacted", requestId, droppedCount: e.droppedCount };
    case "panelToolCall": return { type: "panel_tool_call", requestId, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args }; // UC-PANEL FR-PANEL-2
    case "grounding": return { type: "grounding", requestId, status: e.status, sources: e.sources };
    case "artifact": return { type: "artifact", requestId, artifact: e.artifact };
    case "providerSession": return {
      type: "provider_session",
      requestId,
      sessionId: e.sessionId,
      providerSessionRef: e.providerSessionRef,
      state: e.state,
    };
    case "processingDisclosure": return {
      type: "processing_disclosure",
      requestId,
      workload: e.workload,
      destination: e.destination,
      decision: e.decision,
      processingProfileRef: e.processingProfileRef,
      ...(e.provider !== undefined ? { provider: e.provider } : {}),
      ...(e.model !== undefined ? { model: e.model } : {}),
    };
    case "finish": return { type: "finish", requestId };
    case "error": return { type: "error", requestId, message: e.message, ...(e.code ? { code: e.code } : {}) };
  }
}

function str(v: unknown): string { return typeof v === "string" ? v : v == null ? "" : String(v); }

function decodeChannel(value: unknown): Extract<AgentRequest, { kind: "chat" }>["channel"] {
  if (!value || typeof value !== "object") return undefined;
  const channel = value as Record<string, unknown>;
  if (channel.kind === "shell") return { kind: "shell" };
  if (channel.kind !== "discord") return undefined;
  return {
    kind: "discord",
    bindingId: str(channel.bindingId),
    guildId: str(channel.guildId),
    channelId: str(channel.channelId),
    userId: str(channel.userId),
  };
}
