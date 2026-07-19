import type {
  ProcessingDecision,
  ProcessingDestination,
  ProcessingWorkload,
} from "./chat.js";

export type ProcessingProfile = "local_only" | "cloud_enabled" | "ask_before_external";

export type EndpointClassification =
  | { readonly ok: true; readonly destination: ProcessingDestination }
  | { readonly ok: false; readonly code: "PROCESSING_DESTINATION_UNKNOWN" };

function parseIpv4(host: string): readonly [number, number, number, number] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets as unknown as readonly [number, number, number, number]
    : undefined;
}

/**
 * URL text proves only loopback. Private-looking network addresses remain
 * external until a trusted endpoint registry explicitly marks them managed.
 */
export function classifyProcessingEndpoint(value: unknown): EndpointClassification {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096) {
    return { ok: false, code: "PROCESSING_DESTINATION_UNKNOWN" };
  }
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { return { ok: false, code: "PROCESSING_DESTINATION_UNKNOWN" }; }
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
  if (ipv4?.[0] === 127) return { ok: true, destination: "local_device" };
  const ipv6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (ipv6 === "::1") return { ok: true, destination: "local_device" };
  return { ok: true, destination: "external_cloud" };
}

/** A trusted registry label may promote only addresses that are non-public by construction. */
export function isNonPublicManagedEndpoint(value: string): boolean {
  try {
    const endpoint = new URL(value);
    if (!["http:", "https:"].includes(endpoint.protocol)) return false;
    const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const ipv4 = parseIpv4(host);
    if (ipv4) {
      return ipv4[0] === 10
        || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
        || (ipv4[0] === 192 && ipv4[1] === 168)
        || (ipv4[0] === 169 && ipv4[1] === 254)
        || (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127);
    }
    return /^f[cd][0-9a-f]:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host);
  } catch {
    return false;
  }
}

export function decideProcessingPolicy(input: {
  readonly profile: ProcessingProfile;
  readonly workload: ProcessingWorkload;
  readonly destination: ProcessingDestination;
}): { readonly decision: ProcessingDecision; readonly code?:
  "EXTERNAL_PROCESSING_FORBIDDEN" | "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED" } {
  if (!["local_only", "cloud_enabled", "ask_before_external"].includes(input.profile)
    || !["main_llm", "sub_llm", "memory_llm", "embedding", "network_tool"].includes(input.workload)
    || !["local_device", "private_managed", "external_cloud"].includes(input.destination)) {
    return { decision: "blocked", code: "EXTERNAL_PROCESSING_FORBIDDEN" };
  }
  if (input.destination === "local_device") return { decision: "allowed" };
  if (input.profile === "local_only") {
    return { decision: "blocked", code: "EXTERNAL_PROCESSING_FORBIDDEN" };
  }
  if (input.profile === "cloud_enabled" || input.destination === "private_managed") {
    return { decision: "allowed" };
  }
  return {
    decision: "confirmation_required",
    code: "EXTERNAL_PROCESSING_CONFIRMATION_REQUIRED",
  };
}
