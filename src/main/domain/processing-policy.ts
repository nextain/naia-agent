import type {
  ProcessingDecision,
  ProcessingDestination,
  ProcessingWorkload,
} from "./chat.js";

export type ProcessingProfile = "local_only" | "cloud_enabled" | "ask_before_external";

export type EndpointClassification =
  | { readonly ok: true; readonly destination: ProcessingDestination }
  | { readonly ok: false; readonly code: "PROCESSING_DESTINATION_UNKNOWN" };

export interface ProcessingPolicyInput {
  readonly profile: ProcessingProfile;
  readonly workload: ProcessingWorkload;
  readonly destination: ProcessingDestination;
}

export interface ProcessingPolicyDecision {
  readonly decision: ProcessingDecision;
  readonly code?: "EXTERNAL_PROCESSING_FORBIDDEN" | "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED";
}

function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets as unknown as readonly [number, number, number, number]
    : null;
}

function classifyIpv4(octets: readonly [number, number, number, number]): ProcessingDestination {
  const [a, b] = octets;
  if (a === 127) return "local_device";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 169 && b === 254)) {
    return "private_managed";
  }
  return "external_cloud";
}

/**
 * URL text alone may prove loopback/private numeric addresses, but a hostname is
 * never promoted to local/private without trusted endpoint metadata. This keeps
 * DNS rebinding and names such as `runpod.internal` on the external side.
 */
export function classifyProcessingEndpoint(value: unknown): EndpointClassification {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    return { ok: false, code: "PROCESSING_DESTINATION_UNKNOWN" };
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    return { ok: false, code: "PROCESSING_DESTINATION_UNKNOWN" };
  }
  if (endpoint.username || endpoint.password) {
    return { ok: false, code: "PROCESSING_DESTINATION_UNKNOWN" };
  }
  if (endpoint.protocol === "unix:") {
    return endpoint.pathname
      ? { ok: true, destination: "local_device" }
      : { ok: false, code: "PROCESSING_DESTINATION_UNKNOWN" };
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    return { ok: false, code: "PROCESSING_DESTINATION_UNKNOWN" };
  }
  const host = endpoint.hostname.toLowerCase();
  if (!host) return { ok: false, code: "PROCESSING_DESTINATION_UNKNOWN" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: true, destination: "local_device" };
  }
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const classified = classifyIpv4(ipv4);
    return {
      ok: true,
      destination: classified === "private_managed"
        ? "external_cloud"
        : classified,
    };
  }
  const ipv6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (ipv6 === "::1") return { ok: true, destination: "local_device" };
  if (/^f[cd][0-9a-f]{2}:/i.test(ipv6) || /^fe[89ab][0-9a-f]:/i.test(ipv6)) {
    return {
      ok: true,
      destination: "external_cloud",
    };
  }
  return { ok: true, destination: "external_cloud" };
}

export function decideProcessingPolicy(value: ProcessingPolicyInput): ProcessingPolicyDecision {
  if (!["local_only", "cloud_enabled", "ask_before_external"].includes(value.profile)
    || !["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"].includes(value.workload)
    || !["local_device", "private_managed", "external_cloud"].includes(value.destination)) {
    return { decision: "blocked", code: "EXTERNAL_PROCESSING_FORBIDDEN" };
  }
  if (value.destination === "local_device") return { decision: "allowed" };
  if (value.profile === "local_only") {
    return { decision: "blocked", code: "EXTERNAL_PROCESSING_FORBIDDEN" };
  }
  if (value.profile === "cloud_enabled" || value.destination === "private_managed") {
    return { decision: "allowed" };
  }
  return {
    decision: "confirmation_required",
    code: "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED",
  };
}
