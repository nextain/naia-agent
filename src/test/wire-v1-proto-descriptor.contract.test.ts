// UC-WIRE-V1 TDD RED — descriptor-level compatibility and additive field lock (T-WIRE-07,14,18).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXISTING_PROTO_SNAPSHOT } from "./wire-v1-fixtures.js";

type FieldShape = { number: number; type: string };
type MessageShape = Record<string, FieldShape>;

const protoPath = fileURLToPath(new URL("../main/adapters/grpc/naia_agent.proto", import.meta.url));
const proto = readFileSync(protoPath, "utf8");

function messageBody(name: string): string {
  const startPattern = new RegExp(`\\bmessage\\s+${name}\\s*\\{`, "g");
  const match = startPattern.exec(proto);
  if (!match) return "";
  const open = proto.indexOf("{", match.index);
  let depth = 0;
  for (let i = open; i < proto.length; i++) {
    if (proto[i] === "{") depth++;
    if (proto[i] === "}") {
      depth--;
      if (depth === 0) return proto.slice(open + 1, i);
    }
  }
  return "";
}

function fieldsOf(name: string): MessageShape {
  const body = messageBody(name);
  const result: MessageShape = {};
  const fieldPattern = /(?:^|[;{])\s*(?:optional\s+|repeated\s+)?([A-Za-z_][\w.]*)\s+([a-z_][\w]*)\s*=\s*(\d+)\s*;/gm;
  for (const match of body.matchAll(fieldPattern)) {
    result[match[2]!] = { type: match[1]!, number: Number(match[3]) };
  }
  return result;
}

function expectExistingFieldsUnchanged(message: keyof typeof EXISTING_PROTO_SNAPSHOT): void {
  const actual = fieldsOf(message);
  for (const [field, expected] of Object.entries(EXISTING_PROTO_SNAPSHOT[message])) {
    expect(actual[field], `${message}.${field}`).toEqual(expected);
  }
}

describe("UC-WIRE-V1 proto descriptor", () => {
  it("T-WIRE-14: every existing field keeps its number/name/type", () => {
    expectExistingFieldsUnchanged("SetWorkspaceResult");
    expectExistingFieldsUnchanged("ChatRequest");
    expectExistingFieldsUnchanged("AgentEvent");
  });

  it("T-WIRE-02~04: Message adds attachments; ChatRequest adds channel/grounding/provider-session additively", () => {
    const messageFields = fieldsOf("Message");
    expect(messageFields.attachments).toMatchObject({ type: "AttachmentRef" });
    expect(messageFields.attachments!.number).toBeGreaterThan(3);

    const requestFields = fieldsOf("ChatRequest");
    expect(requestFields.channel).toMatchObject({ type: "ChannelContext" });
    expect(requestFields.grounding).toMatchObject({ type: "GroundingRequest" });
    expect(requestFields.provider_session).toMatchObject({ type: "ProviderSessionRequest" });
    for (const name of ["channel", "grounding", "provider_session"]) {
      expect(requestFields[name]!.number).toBeGreaterThan(10);
    }
  });

  it("T-WIRE-05: AgentEvent adds grounding/artifact/provider-session and enum-coded ErrorEvent.code", () => {
    const eventFields = fieldsOf("AgentEvent");
    expect(eventFields.grounding).toMatchObject({ type: "GroundingEvent" });
    expect(eventFields.artifact).toMatchObject({ type: "ArtifactEvent" });
    expect(eventFields.provider_session).toMatchObject({ type: "ProviderSessionEvent" });
    expect(fieldsOf("ArtifactEvent").artifact).toEqual({ type: "ImageArtifact", number: 1 });
    expect(fieldsOf("ErrorEvent").code).toEqual({ type: "WireErrorCode", number: 2 });
  });

  it("T-WIRE-19: processing request/event field numbers are additive and locked", () => {
    expect(fieldsOf("ChatRequest").processing).toEqual({ type: "ProcessingRequest", number: 14 });
    expect(fieldsOf("AgentEvent").processing_disclosure).toEqual({ type: "ProcessingDisclosureEvent", number: 20 });
  });

  it("T-WIRE-07: SetWorkspaceResult adds repeated effective configs", () => {
    expect(fieldsOf("SetWorkspaceResult").effective_llm_configs).toMatchObject({
      type: "EffectiveLlmConfig",
    });
  });

  it.each([
    "GroundingStatus",
    "ConfigProvenance",
    "ProviderSessionMode",
    "ProviderSessionState",
    "WireErrorCode",
    "ProcessingDestination",
    "ProcessingWorkload",
    "ProcessingDecision",
  ])("T-WIRE-08: %s reserves UNSPECIFIED = 0", (enumName) => {
    const enumMatch = proto.match(new RegExp(`enum\\s+${enumName}\\s*\\{([^}]*)\\}`));
    expect(enumMatch, `${enumName} descriptor`).not.toBeNull();
    expect(enumMatch?.[1]).toMatch(/\b[A-Z][A-Z0-9_]*_UNSPECIFIED\s*=\s*0\s*;/);
  });

  it("T-WIRE-10,18: proto contains refs, not image bytes/base64/raw knowledge payload fields", () => {
    expect(proto).toContain("message AttachmentRef");
    expect(proto).toContain("message ImageArtifact");
    expect(proto).not.toMatch(/\b(bytes|base64|raw_thread_id|knowledge_body|credential_secret)\s*=/);
  });
});
