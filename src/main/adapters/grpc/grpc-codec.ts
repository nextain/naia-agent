// adapters/grpc/grpc-codec — proto(naia_agent.proto) ↔ domain 순수 매핑.
// stdio 의 protocol.ts(decodeRequest/encodeEmit) 와 동형 — transport 만 다름(직교). gRPC 의존 없음(순수, 테스트 가능).
// proto 메시지는 @grpc/proto-loader 가 런타임 로드하는 plain object → 여기서 도메인 타입으로 변환.
import type { AgentRequest, AgentEmit, ChatMessage } from "../../domain/chat.js";
import { decodeEnvironmentSegments } from "../protocol.js";

// proto-shaped 입력(proto-loader plain object; 필드명 = proto snake_case 또는 camelCase — loader keepCase=false 가정 camelCase).
export interface PbChatRequest {
  requestId: string;
  sessionId?: string;
  messages: {
    role: string;
    content: string;
    toolCallId?: string;
    attachments?: {
      id: string;
      kind: "image";
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      sizeBytes: number;
      localRef: string;
    }[];
  }[];
  systemPrompt?: string;
  /** S4 — 클라 환경 세그먼트(아바타 감정·패널). proto `environment_segments_json` = JSON 문자열(args_json 동형, 무손실). */
  environmentSegmentsJson?: string;
  enableTools?: boolean;
  enableThinking?: boolean;
  gatewayUrl?: string;
  disabledSkills?: string[];
  activityResume?: {
    activityId?: string;
    profileGeneration?: number | string;
    yieldGeneration?: number | string;
    resumeToken?: string;
  };
  channel?: {
    shell?: object;
    discord?: { bindingId?: string; guildId?: string; channelId?: string; userId?: string };
  };
  grounding?: { policy?: number | string; knowledgeScope?: string };
  providerSession?: { mode?: number | string; providerSessionRef?: string };
  processing?: { processingProfileRef?: string; actualDestination?: unknown };
}
export interface PbCancel { requestId: string; activityId?: string }
export interface PbApproval { requestId: string; toolCallId: string; decision: number | string } // 0/REJECT, 1/APPROVE
export interface PbCreds { provider: string; apiKey?: string; naiaKey?: string }
export interface PbToolRequest { requestId: string; toolName: string }

// ── 도메인 chat 요청 조립 (protocol.ts decodeRequest 의 chat_request 분기 이식; provider 제거=정본) ──
const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);
export function chatRequestToDomain(p: PbChatRequest): Extract<AgentRequest, { kind: "chat" }> {
  // role 은 protocol.ts 와 동일하게 passthrough(4종 보존 — "tool" 을 "user" 로 뭉개지 않음). tool_call_id 보존.
  const messages: ChatMessage[] = (p.messages ?? []).map((m) => ({
    role: (VALID_ROLES.has(m.role) ? m.role : "user") as ChatMessage["role"],
    content: String(m.content ?? ""),
    ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    ...(m.attachments !== undefined ? { attachments: m.attachments } : {}),
  }));
  return {
    kind: "chat",
    requestId: String(p.requestId ?? ""),
    messages,
    ...(p.sessionId !== undefined ? { sessionId: String(p.sessionId) } : {}),
    ...(p.systemPrompt !== undefined ? { systemPrompt: p.systemPrompt } : {}),
    ...(p.environmentSegmentsJson ? { environmentSegments: decodeEnvironmentSegments(parseJsonSafe(p.environmentSegmentsJson)) } : {}),
    ...(p.enableTools !== undefined ? { enableTools: p.enableTools } : {}),
    ...(p.enableThinking !== undefined ? { enableThinking: p.enableThinking } : {}),
    ...(p.gatewayUrl !== undefined ? { gatewayUrl: p.gatewayUrl } : {}),
    ...(p.disabledSkills !== undefined ? { disabledSkills: p.disabledSkills } : {}),
    ...(p.activityResume ? {
      activityResume: {
        activityId: String(p.activityResume.activityId ?? ""),
        profileGeneration: Number(p.activityResume.profileGeneration ?? 0),
        yieldGeneration: Number(p.activityResume.yieldGeneration ?? 0),
        resumeToken: String(p.activityResume.resumeToken ?? ""),
      },
    } : {}),
    ...(p.channel?.discord ? {
      channel: {
        kind: "discord" as const,
        bindingId: String(p.channel.discord.bindingId ?? ""),
        guildId: String(p.channel.discord.guildId ?? ""),
        channelId: String(p.channel.discord.channelId ?? ""),
        userId: String(p.channel.discord.userId ?? ""),
      },
    } : p.channel?.shell ? { channel: { kind: "shell" as const } } : {}),
    ...(p.grounding ? {
      grounding: {
        policy: enumText(p.grounding.policy, {
          1: "off",
          2: "available",
          3: "required",
        }) as "off" | "available" | "required",
        knowledgeScope: String(p.grounding.knowledgeScope ?? ""),
      },
    } : {}),
    ...(p.providerSession ? {
      providerSession: p.providerSession.mode === 2
        || p.providerSession.mode === "RESUME"
        || p.providerSession.mode === "resume"
        ? {
            mode: "resume" as const,
            providerSessionRef: String(p.providerSession.providerSessionRef ?? ""),
          }
        : { mode: "new" as const },
    } : {}),
    ...(p.processing ? {
      processing: { processingProfileRef: String(p.processing.processingProfileRef ?? "") },
    } : {}),
  };
}

export function cancelToDomain(p: PbCancel): Extract<AgentRequest, { kind: "cancel" }> {
  return {
    kind: "cancel",
    requestId: String(p.requestId ?? ""),
    ...(p.activityId ? { activityId: String(p.activityId) } : {}),
  };
}
export function approvalToDomain(p: PbApproval): Extract<AgentRequest, { kind: "approvalResponse" }> {
  const approve = p.decision === 1 || p.decision === "APPROVE" || p.decision === "approve";
  return { kind: "approvalResponse", requestId: String(p.requestId ?? ""), toolCallId: String(p.toolCallId ?? ""), decision: approve ? "approve" : "reject" };
}
export function credsToDomain(p: PbCreds): Extract<AgentRequest, { kind: "credsUpdate" }> {
  return {
    kind: "credsUpdate", provider: String(p.provider ?? ""),
    secret: { ...(p.apiKey !== undefined ? { apiKey: p.apiKey } : {}), ...(p.naiaKey !== undefined ? { naiaKey: p.naiaKey } : {}) },
  };
}
export function toolRequestToDomain(p: PbToolRequest): Extract<AgentRequest, { kind: "toolRequest" }> {
  return { kind: "toolRequest", requestId: String(p.requestId ?? ""), toolName: String(p.toolName ?? "") };
}

/** environment_segments_json 안전 파싱 — 손상 JSON = [](디코더가 빈 배열 → 환경 블록 없음, no-throw). */
function parseJsonSafe(s: string): unknown {
  try { return JSON.parse(s); } catch { return []; }
}

// ── 도메인 AgentEmit → proto AgentEvent (protocol.ts encodeEmit 11종 1:1 이식; oneof field 1개 set) ──
export interface PbAgentEvent { requestId: string; [oneof: string]: unknown }
export function emitToProto(requestId: string, e: AgentEmit): PbAgentEvent {
  switch (e.kind) {
    case "text": return { requestId, text: { text: e.text } };
    case "thinking": return { requestId, thinking: { text: e.text } };
    case "toolUse": return { requestId, toolUse: { toolCallId: e.toolCallId, toolName: e.toolName, argsJson: JSON.stringify(e.args ?? null) } };
    case "toolResult": return { requestId, toolResult: { toolCallId: e.toolCallId, output: e.output, toolName: e.toolName, success: e.success } };
    case "approvalRequest": return { requestId, approvalRequest: { toolCallId: e.toolCallId, toolName: e.toolName, tier: e.tier, argsJson: JSON.stringify(e.args ?? null), description: e.description } };
    case "gatewayApprovalRequest": return { requestId, gatewayApprovalRequest: { toolCallId: e.toolCallId, toolName: e.toolName, argsJson: JSON.stringify(e.args ?? null) } };
    case "usage": return { requestId, usage: { inputTokens: e.inputTokens, outputTokens: e.outputTokens, ...(e.cost !== undefined ? { cost: e.cost } : {}), ...(e.model !== undefined ? { model: e.model } : {}) } };
    case "logEntry": return { requestId, logEntry: { level: e.level, message: e.message } };
    case "tokenWarning": return { requestId, tokenWarning: { rawJson: JSON.stringify(e.raw ?? null) } };
    case "compacted": return { requestId, compacted: { droppedCount: e.droppedCount } };
    case "panelToolCall": return { requestId, panelToolCall: { toolCallId: e.toolCallId, toolName: e.toolName, argsJson: JSON.stringify(e.args ?? null) } }; // UC-PANEL FR-PANEL-2
    case "grounding": return { requestId, grounding: { status: enumUpper(e.status), sources: e.sources } };
    case "artifact": return { requestId, artifact: { artifact: e.artifact } };
    case "providerSession": return {
      requestId,
      providerSession: {
        sessionId: e.sessionId,
        providerSessionRef: e.providerSessionRef,
        state: enumUpper(e.state),
      },
    };
    case "processingDisclosure": return {
      requestId,
      processingDisclosure: {
        workload: enumUpper(e.workload),
        destination: enumUpper(e.destination),
        decision: enumUpper(e.decision),
        processingProfileRef: e.processingProfileRef,
        ...(e.provider !== undefined ? { provider: e.provider } : {}),
        ...(e.model !== undefined ? { model: e.model } : {}),
      },
    };
    case "finish": return { requestId, finish: {} };
    case "error": return { requestId, error: { message: e.message, ...(e.code ? { code: e.code } : {}) } };
  }
}

function enumUpper(value: string): string {
  return value.toUpperCase();
}

function enumText(value: unknown, numeric: Readonly<Record<number, string>>): string {
  if (typeof value === "number") return numeric[value] ?? "";
  return String(value ?? "").toLowerCase().replaceAll("_", "-");
}
