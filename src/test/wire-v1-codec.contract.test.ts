// UC-WIRE-V1 TDD RED — agent domain + stdio/gRPC codec contract.
import { describe, expect, it } from "vitest";
import * as protocol from "../main/adapters/protocol.js";
import * as grpcCodec from "../main/adapters/grpc/grpc-codec.js";
import type { PbChatRequest } from "../main/adapters/grpc/grpc-codec.js";
import {
  ARTIFACT_EVENT,
  ATTACHMENT,
  CODED_ERROR_EVENT,
  DISCORD_CHANNEL,
  EFFECTIVE_LLM_CONFIGS,
  GROUNDING_EVENT,
  GROUNDING_REQUIRED,
  LEGACY_DOMAIN_CHAT,
  LEGACY_STDIO_CHAT,
  PROVIDER_SESSION_EVENT,
  PROVIDER_SESSION_RESUME,
  PROCESSING_DISCLOSURE_EVENT,
  PROCESSING_REQUEST,
} from "./wire-v1-fixtures.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  return value as UnknownRecord;
}

describe("UC-WIRE-V1 inbound codec (T-WIRE-01~04,18)", () => {
  it("T-WIRE-01: text-only stdio request keeps the exact legacy domain shape", () => {
    expect(protocol.decodeRequest(JSON.stringify(LEGACY_STDIO_CHAT))).toEqual(LEGACY_DOMAIN_CHAT);
  });

  it("T-WIRE-01: text-only gRPC request adds no optional wire-v1 fields", () => {
    expect(grpcCodec.chatRequestToDomain({
      requestId: LEGACY_STDIO_CHAT.requestId,
      messages: [...LEGACY_STDIO_CHAT.messages],
    })).toEqual(LEGACY_DOMAIN_CHAT);
  });

  it("T-WIRE-02: stdio preserves a bounded AttachmentRef on a user message", () => {
    const decoded = asRecord(protocol.decodeRequest(JSON.stringify({
      ...LEGACY_STDIO_CHAT,
      messages: [{ role: "user", content: "inspect", attachments: [ATTACHMENT] }],
    })));
    expect(decoded.messages).toEqual([{ role: "user", content: "inspect", attachments: [ATTACHMENT] }]);
  });

  it("T-WIRE-02: gRPC preserves structured attachment refs instead of bytes/base64/path payloads", () => {
    const decoded = asRecord(grpcCodec.chatRequestToDomain({
      requestId: "grpc-attachment",
      messages: [{ role: "user", content: "inspect", attachments: [ATTACHMENT] }],
    }));
    expect(decoded.messages).toEqual([{ role: "user", content: "inspect", attachments: [ATTACHMENT] }]);
  });

  it("T-WIRE-01: proto default empty attachments do not turn assistant history into an attachment message", async () => {
    const decoded = grpcCodec.chatRequestToDomain({
      requestId: "grpc-follow-up",
      messages: [
        { role: "user", content: "first", attachments: [] },
        { role: "assistant", content: "reply", attachments: [] },
        { role: "user", content: "follow up", attachments: [] },
      ],
    });
    expect(decoded.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "follow up" },
    ]);
    const { validateWireChatRequest } = await import("../main/domain/wire-v1.js");
    expect(validateWireChatRequest(decoded)).toMatchObject({ ok: true });
  });
  it("T-WIRE-03: stdio preserves channel and grounding as structured values", () => {
    const decoded = asRecord(protocol.decodeRequest(JSON.stringify({
      ...LEGACY_STDIO_CHAT,
      channel: DISCORD_CHANNEL,
      grounding: GROUNDING_REQUIRED,
    })));
    expect(decoded).toMatchObject({ channel: DISCORD_CHANNEL, grounding: GROUNDING_REQUIRED });
  });

  it("T-WIRE-03: gRPC preserves channel and grounding without prompt injection", () => {
    const decoded = asRecord(grpcCodec.chatRequestToDomain({
      requestId: "grpc-grounding",
      messages: [{ role: "user", content: "What does the workshop cover?" }],
      channel: DISCORD_CHANNEL,
      grounding: GROUNDING_REQUIRED,
    }));
    expect(decoded).toMatchObject({ channel: DISCORD_CHANNEL, grounding: GROUNDING_REQUIRED });
    expect(decoded.systemPrompt).toBeUndefined();
  });

  it("T-WIRE-04: stdio preserves provider-session resume and its local session binding", () => {
    const decoded = asRecord(protocol.decodeRequest(JSON.stringify({
      ...LEGACY_STDIO_CHAT,
      sessionId: "session001",
      providerSession: PROVIDER_SESSION_RESUME,
    })));
    expect(decoded).toMatchObject({
      sessionId: "session001",
      providerSession: PROVIDER_SESSION_RESUME,
    });
  });

  it("T-WIRE-04: gRPC preserves provider-session resume and its local session binding", () => {
    const decoded = asRecord(grpcCodec.chatRequestToDomain({
      requestId: "grpc-session",
      sessionId: "session001",
      messages: [],
      providerSession: PROVIDER_SESSION_RESUME,
    }));
    expect(decoded).toMatchObject({
      sessionId: "session001",
      providerSession: PROVIDER_SESSION_RESUME,
    });
  });

  it("T-WIRE-18: unknown gRPC fields are ignored while known wire-v1 fields survive", () => {
    const request: PbChatRequest & { futureField: string } = {
      requestId: "grpc-unknown",
      messages: [{ role: "user", content: "hello" }],
      channel: { kind: "shell" },
      futureField: "ignored-by-v1",
    };
    const decoded = asRecord(grpcCodec.chatRequestToDomain(request));
    expect(decoded).toEqual({
      kind: "chat",
      requestId: "grpc-unknown",
      messages: [{ role: "user", content: "hello" }],
      channel: { kind: "shell" },
    });
  });

  it("present gRPC ChannelContext with unset/unknown oneof is never promoted to shell", async () => {
    const decoded = grpcCodec.chatRequestToDomain({
      requestId: "grpc-unset-channel",
      messages: [],
      channel: {},
    });
    const loaded = await import("../main/domain/wire-v1.js");
    expect(loaded.validateWireChatRequest(decoded)).toMatchObject({
      ok: false, error: { code: "WIRE_UNSUPPORTED_ENUM", field: "channel.kind" },
    });
  });

  it("T-WIRE-19: processing profile reference round-trips through stdio and gRPC", () => {
    const stdio = asRecord(protocol.decodeRequest(JSON.stringify({
      ...LEGACY_STDIO_CHAT, processing: PROCESSING_REQUEST,
    })));
    expect(stdio.processing).toEqual(PROCESSING_REQUEST);
    const grpc = grpcCodec.chatRequestToDomain({
      requestId: "grpc-processing", messages: [], processing: PROCESSING_REQUEST,
    });
    expect(grpc.processing).toEqual(PROCESSING_REQUEST);
  });
});

describe("UC-WIRE-V1 outbound codec (T-WIRE-05,07,18)", () => {
  it.each([
    ["grounding", GROUNDING_EVENT, {
      type: "grounding",
      requestId: "out-1",
      status: "grounded",
      sources: GROUNDING_EVENT.sources,
    }],
    ["artifact", ARTIFACT_EVENT, {
      type: "artifact",
      requestId: "out-1",
      artifact: ARTIFACT_EVENT.artifact,
    }],
    ["providerSession", PROVIDER_SESSION_EVENT, {
      type: "provider_session",
      requestId: "out-1",
      sessionId: "session001",
      providerSessionRef: "sessionref001",
      state: "resumed",
    }],
    ["coded error", CODED_ERROR_EVENT, {
      type: "error",
      requestId: "out-1",
      message: "Request could not be processed.",
      code: "WIRE_INVALID_ARGUMENT",
    }],
    ["processing disclosure", PROCESSING_DISCLOSURE_EVENT, {
      type: "processing_disclosure", requestId: "out-1", workload: "main_llm",
      destination: "external_cloud", decision: "allowed", processingProfileRef: "profile001",
      provider: "codex", model: "gpt-5",
    }],
  ] as const)("T-WIRE-05: stdio encodes %s without loss", (_name, event, expected) => {
    expect(protocol.encodeEmit("out-1", event)).toEqual(expected);
  });

  it.each([
    ["grounding", GROUNDING_EVENT, { grounding: { status: "GROUNDED", sources: GROUNDING_EVENT.sources } }],
    ["artifact", ARTIFACT_EVENT, { artifact: { artifact: ARTIFACT_EVENT.artifact } }],
    ["providerSession", PROVIDER_SESSION_EVENT, {
      providerSession: {
        sessionId: "session001",
        providerSessionRef: "sessionref001",
        state: "RESUMED",
      },
    }],
    ["coded error", CODED_ERROR_EVENT, {
      error: { message: "Request could not be processed.", code: "WIRE_INVALID_ARGUMENT" },
    }],
    ["processing disclosure", PROCESSING_DISCLOSURE_EVENT, {
      processingDisclosure: {
        workload: "MAIN_LLM", destination: "EXTERNAL_CLOUD", decision: "ALLOWED",
        processingProfileRef: "profile001", provider: "codex", model: "gpt-5",
      },
    }],
  ] as const)("T-WIRE-05: gRPC encodes %s with stdio-equivalent meaning", (_name, event, expectedPart) => {
    expect(grpcCodec.emitToProto("out-1", event)).toMatchObject({
      requestId: "out-1",
      ...expectedPart,
    });
  });

  it("T-WIRE-07: SetWorkspace effective configs round-trip in main/sub/memory order", () => {
    const codec = grpcCodec as UnknownRecord;
    expect(codec.settingsResultToProto).toBeTypeOf("function");
    expect(codec.settingsResultFromProto).toBeTypeOf("function");
    const encoded = (codec.settingsResultToProto as (value: unknown) => unknown)({
      loaded: true,
      provider: "codex",
      model: "gpt-5",
      effectiveLlmConfigs: EFFECTIVE_LLM_CONFIGS,
    });
    const decoded = (codec.settingsResultFromProto as (value: unknown) => unknown)(encoded);
    expect(decoded).toMatchObject({ effectiveLlmConfigs: EFFECTIVE_LLM_CONFIGS });
  });

  it("egress validation normalizes duplicate source URIs and fails closed for invalid artifacts", () => {
    const duplicated = {
      ...GROUNDING_EVENT,
      sources: [{ title: "Workshop notes", sourceUris: ["kb://workshop/intro", "kb://workshop/intro"] }],
    };
    expect(protocol.encodeEmit("out-normalized", duplicated)).toMatchObject({
      sources: [{ sourceUris: ["kb://workshop/intro"] }],
    });
    expect(grpcCodec.emitToProto("out-normalized", duplicated)).toMatchObject({
      grounding: { sources: [{ sourceUris: ["kb://workshop/intro"] }] },
    });
    expect(protocol.encodeEmit("out-invalid", {
      kind: "artifact",
      artifact: { ...ARTIFACT_EVENT.artifact, localRef: "../secret" },
    })).toMatchObject({ type: "error", code: "ATTACHMENT_INVALID_REF" });
  });

  it("grounding egress applies the real channel context for file URI policy", () => {
    const fileGrounding = {
      kind: "grounding" as const,
      status: "grounded" as const,
      sources: [{ title: "local", sourceUris: ["file:///workspace/notes.md"] }],
    };
    expect(protocol.encodeEmit("shell-file", fileGrounding, { kind: "shell" })).toMatchObject({ type: "grounding" });
    expect(protocol.encodeEmit("discord-file", fileGrounding, DISCORD_CHANNEL)).toMatchObject({
      type: "error", code: "WIRE_INVALID_ARGUMENT",
    });
    expect(grpcCodec.emitToProto("shell-file", fileGrounding, { kind: "shell" })).toHaveProperty("grounding");
    expect(grpcCodec.emitToProto("discord-file", fileGrounding, DISCORD_CHANNEL)).toHaveProperty("error");
  });

  it("settings codecs reject malformed effective configs at both boundaries", () => {
    const malformed = {
      loaded: true, provider: "codex", model: "gpt-5",
      effectiveLlmConfigs: [EFFECTIVE_LLM_CONFIGS[0]],
    };
    expect(() => grpcCodec.settingsResultToProto(malformed)).toThrow("invalid effective LLM configuration");
    expect(() => grpcCodec.settingsResultFromProto({
      loaded: true, provider: "codex", model: "gpt-5",
      effectiveLlmConfigs: [{ role: "MAIN" }],
    })).toThrow("invalid effective LLM configuration");
  });
});
