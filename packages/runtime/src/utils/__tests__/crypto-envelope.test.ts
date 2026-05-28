// Unit tests for AES-256-GCM crypto envelope (#337 Phase 2a).

import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptEnvelope,
  decryptEnvelope,
  generateMasterPassword,
} from "../crypto-envelope.js";

const HEADER_SIZE = 49;
const PASSWORD = "correct-horse-battery-staple";

describe("crypto-envelope", () => {
  it("round-trips plaintext through encrypt/decrypt", async () => {
    const plaintext = new TextEncoder().encode("hello naia auth token");
    const blob = await encryptEnvelope(plaintext, PASSWORD);
    const out = await decryptEnvelope(blob, PASSWORD);
    expect(Buffer.from(out)).toEqual(Buffer.from(plaintext));
  });

  it("rejects with explicit error on wrong password", async () => {
    const plaintext = new TextEncoder().encode("secret");
    const blob = await encryptEnvelope(plaintext, PASSWORD);
    await expect(decryptEnvelope(blob, "wrong-password")).rejects.toThrow(/Decryption failed/);
  });

  it("rejects when a byte in the ciphertext is flipped (authTag check)", async () => {
    const plaintext = new TextEncoder().encode("integrity matters");
    const blob = await encryptEnvelope(plaintext, PASSWORD);
    // Flip a byte inside the ciphertext region (after the 49-byte header).
    const tampered = new Uint8Array(blob);
    expect(tampered.length).toBeGreaterThan(HEADER_SIZE);
    const idx = HEADER_SIZE; // first ciphertext byte
    tampered[idx] = (tampered[idx]! ^ 0xff) & 0xff;
    await expect(decryptEnvelope(tampered, PASSWORD)).rejects.toThrow(/Decryption failed/);
  });

  it("rejects a truncated blob (< 49 bytes) with explicit error", async () => {
    const truncated = new Uint8Array(HEADER_SIZE - 1); // 48 bytes
    await expect(decryptEnvelope(truncated, PASSWORD)).rejects.toThrow(/too short/);
  });

  it("rejects a blob with bad magic ('XXXX')", async () => {
    const plaintext = new TextEncoder().encode("hi");
    const blob = await encryptEnvelope(plaintext, PASSWORD);
    const corrupt = new Uint8Array(blob);
    // Overwrite the first 4 bytes (magic) with "XXXX".
    const xxxx = Buffer.from("XXXX", "ascii");
    corrupt.set(xxxx, 0);
    await expect(decryptEnvelope(corrupt, PASSWORD)).rejects.toThrow(/bad magic/);
  });

  it("rejects unsupported version (0x02)", async () => {
    const plaintext = new TextEncoder().encode("hi");
    const blob = await encryptEnvelope(plaintext, PASSWORD);
    const corrupt = new Uint8Array(blob);
    corrupt[4] = 0x02;
    await expect(decryptEnvelope(corrupt, PASSWORD)).rejects.toThrow(/Unsupported envelope version/);
  });

  it("round-trips empty plaintext correctly", async () => {
    const plaintext = new Uint8Array(0);
    const blob = await encryptEnvelope(plaintext, PASSWORD);
    expect(blob.length).toBe(HEADER_SIZE); // header only, no ciphertext bytes
    const out = await decryptEnvelope(blob, PASSWORD);
    expect(out.length).toBe(0);
  });

  it("round-trips a 1 MB random plaintext", async () => {
    const plaintext = new Uint8Array(randomBytes(1024 * 1024));
    const blob = await encryptEnvelope(plaintext, PASSWORD);
    const out = await decryptEnvelope(blob, PASSWORD);
    expect(out.length).toBe(plaintext.length);
    // Compare via Buffer equality to avoid per-byte assertion noise on 1 MB.
    expect(Buffer.from(out).equals(Buffer.from(plaintext))).toBe(true);
  });

  it("produces different ciphertext for same plaintext+password (fresh salt/nonce)", async () => {
    const plaintext = new TextEncoder().encode("deterministic?");
    const a = await encryptEnvelope(plaintext, PASSWORD);
    const b = await encryptEnvelope(plaintext, PASSWORD);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    // Both must still decrypt back to the original plaintext.
    expect(Buffer.from(await decryptEnvelope(a, PASSWORD))).toEqual(Buffer.from(plaintext));
    expect(Buffer.from(await decryptEnvelope(b, PASSWORD))).toEqual(Buffer.from(plaintext));
  });

  it("generateMasterPassword() default returns 64 hex chars", () => {
    const pw = generateMasterPassword();
    expect(pw).toHaveLength(64);
    expect(pw).toMatch(/^[0-9a-f]{64}$/);
    // Two consecutive calls should virtually never collide.
    expect(generateMasterPassword()).not.toBe(pw);
  });
});
