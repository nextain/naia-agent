import { describe, expect, it } from "vitest";
import {
  classifyProcessingEndpoint,
  decideProcessingPolicy,
  type ProcessingProfile,
} from "../main/domain/processing-policy.js";
import type { ProcessingDestination, ProcessingWorkload } from "../main/domain/chat.js";

describe("processing endpoint classification", () => {
  it.each([
    ["http://localhost:11434", "local_device"],
    ["http://model.localhost:8000", "local_device"],
    ["http://127.1:8000", "local_device"],
    ["http://[::1]:8000", "local_device"],
    ["unix:///run/naia/model.sock", "local_device"],
    ["http://10.0.0.2:8000", "external_cloud"],
    ["https://172.31.4.9", "external_cloud"],
    ["https://192.168.0.7", "external_cloud"],
    ["https://[fc00::1]", "external_cloud"],
    ["https://api.openai.com/v1", "external_cloud"],
    ["https://runpod.internal", "external_cloud"],
    ["https://203.0.113.3", "external_cloud"],
  ] as const)("%s → %s", (endpoint, destination) => {
    expect(classifyProcessingEndpoint(endpoint)).toEqual({ ok: true, destination });
  });

  it.each([
    "",
    "not a url",
    "file:///tmp/model",
    "https://user:secret@example.com",
    "x".repeat(4_097),
  ])("ambiguous or credential-bearing endpoint fails closed", (endpoint) => {
    expect(classifyProcessingEndpoint(endpoint)).toEqual({
      ok: false,
      code: "PROCESSING_DESTINATION_UNKNOWN",
    });
  });

});

describe("AI-independent processing policy matrix", () => {
  const workloads: readonly ProcessingWorkload[] = [
    "main_llm", "sub_llm", "memory_llm", "embedding", "network_tool",
  ];
  const destinations: readonly ProcessingDestination[] = [
    "local_device", "private_managed", "external_cloud",
  ];
  const profiles: readonly ProcessingProfile[] = [
    "local_only", "cloud_enabled", "ask_before_external",
  ];

  it("local fast path is allowed for every workload and profile", () => {
    for (const workload of workloads) {
      for (const profile of profiles) {
        expect(decideProcessingPolicy({
          profile, workload, destination: "local_device",
        })).toEqual({ decision: "allowed" });
      }
    }
  });

  it("local_only blocks every non-local workload, including embedding", () => {
    for (const workload of workloads) {
      for (const destination of destinations.filter((item) => item !== "local_device")) {
        expect(decideProcessingPolicy({ profile: "local_only", workload, destination }))
          .toEqual({ decision: "blocked", code: "EXTERNAL_PROCESSING_FORBIDDEN" });
      }
    }
  });

  it("cloud_enabled allows cloud LLM and embedding without per-request confirmation", () => {
    for (const workload of workloads) {
      expect(decideProcessingPolicy({
        profile: "cloud_enabled", workload, destination: "external_cloud",
      })).toEqual({ decision: "allowed" });
    }
  });

  it("ask_before_external requires consent only at the external-cloud boundary", () => {
    expect(decideProcessingPolicy({
      profile: "ask_before_external", workload: "embedding", destination: "private_managed",
    })).toEqual({ decision: "allowed" });
    expect(decideProcessingPolicy({
      profile: "ask_before_external", workload: "embedding", destination: "external_cloud",
    })).toEqual({
      decision: "confirmation_required",
      code: "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED",
    });
  });

  it("constructed unknown values fail closed", () => {
    expect(decideProcessingPolicy({
      profile: "unknown",
      workload: "embedding",
      destination: "external_cloud",
    } as never)).toEqual({
      decision: "blocked",
      code: "EXTERNAL_PROCESSING_FORBIDDEN",
    });
  });
});
