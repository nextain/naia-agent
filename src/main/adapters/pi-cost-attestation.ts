import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PiCostAttestation, PiCostAttestationVerifier } from "../benchmark/pi-cost-comparison.js";

const DOMAIN = "naia-pi-cost-comparison-attestation-v1";
const HEX_64 = /^[0-9a-f]{64}$/u;

export interface PiCostAttestationAuthority {
  /** External secret. It must never be serialized into benchmark evidence. */
  readonly integrityKey: string;
  /** Frozen public identifier, normally copied from the benchmark contract. */
  readonly expectedKeyId: string;
}

export function piCostIntegrityKeyId(integrityKey: string): string {
  const key = integrityKeyBytes(integrityKey);
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

export function attestPiCostEvidence(evidence: Readonly<Record<string, unknown>>,
  authority: PiCostAttestationAuthority): PiCostAttestation {
  assertAuthority(authority);
  const evidenceDigest = digestEvidence(evidence);
  return { schemaVersion: 1, algorithm: "hmac-sha256", keyId: authority.expectedKeyId,
    evidenceDigest, mac: macFor(evidenceDigest, authority.integrityKey) };
}

export function makePiCostAttestationVerifier(authority: PiCostAttestationAuthority): PiCostAttestationVerifier {
  return (evidence, raw) => verifyPiCostEvidenceAttestation(evidence, raw, authority);
}

export function verifyPiCostEvidenceAttestation(evidence: Readonly<Record<string, unknown>>,
  raw: unknown, authority: PiCostAttestationAuthority): readonly string[] {
  const problems: string[] = [];
  try { assertAuthority(authority); } catch { return ["benchmark attestation authority is invalid"]; }
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.algorithm !== "hmac-sha256"
    || typeof raw.keyId !== "string" || typeof raw.evidenceDigest !== "string" || typeof raw.mac !== "string") {
    return ["benchmark attestation is malformed"];
  }
  if (raw.keyId !== authority.expectedKeyId) problems.push("benchmark attestation key identity mismatch");
  let evidenceDigest: string;
  try { evidenceDigest = digestEvidence(evidence); }
  catch { return ["benchmark evidence cannot be canonicalized"]; }
  if (raw.evidenceDigest !== evidenceDigest) problems.push("benchmark attestation evidence digest mismatch");
  const expectedMac = macFor(evidenceDigest, authority.integrityKey);
  if (!HEX_64.test(raw.mac) || !safeHexEqual(raw.mac, expectedMac)) problems.push("benchmark attestation MAC mismatch");
  return problems;
}

function assertAuthority(authority: PiCostAttestationAuthority): void {
  const actual = piCostIntegrityKeyId(authority.integrityKey);
  if (!/^sha256:[0-9a-f]{64}$/u.test(authority.expectedKeyId) || authority.expectedKeyId !== actual) {
    throw new Error("benchmark attestation key does not match the frozen key identity");
  }
}

function integrityKeyBytes(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 32) throw new Error("benchmark attestation key must contain at least 32 bytes");
  return bytes;
}

function digestEvidence(evidence: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(evidence)).digest("hex")}`;
}

function macFor(evidenceDigest: string, integrityKey: string): string {
  return createHmac("sha256", integrityKeyBytes(integrityKey)).update(`${DOMAIN}\0${evidenceDigest}`).digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex"); const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("benchmark evidence contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new Error("benchmark evidence contains a non-JSON value");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
