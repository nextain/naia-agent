// AES-256-GCM crypto envelope — standalone utility for encrypting small
// blobs (auth tokens, configs, memory snapshots) with a user password.
//
// Binary layout reuses the naia-memory v6 backup format so a future
// implementation can interop, but this module is **decoupled** from the
// BackupCapable adapter API (cross-review §9.1 — naia-memory's adapter is
// bound to MemoryStore shape and one SQLite path is a stub). Copy of the
// envelope pattern only, not an import.
//
// Layout (49-byte fixed header + ciphertext):
//   [4 bytes]  magic   "NAIA" (ASCII)
//   [1 byte]   version 0x01
//   [16 bytes] salt    (PBKDF2-SHA256 input)
//   [12 bytes] nonce   (AES-GCM IV, random per encryption)
//   [16 bytes] authTag (AES-GCM authentication tag)
//   [N bytes]  ciphertext
//
// PBKDF2-SHA256 iterations: 200_000 (matches naia-memory v6).
// Integrity is provided by the GCM authTag — no separate SHA-256 over
// plaintext is required, GCM already authenticates the ciphertext under
// the derived key.
//
// General-purpose: no model/tier/profile awareness, no auth-token shape
// awareness. Caller frames its own plaintext.

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2,
  randomBytes,
} from "node:crypto";
import { promisify } from "node:util";

const pbkdf2Async = promisify(pbkdf2);

const MAGIC = "NAIA";
const VERSION: number = 0x01;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32; // AES-256
const PBKDF2_ITERATIONS = 200_000;
const HEADER_SIZE = 4 + 1 + SALT_LEN + NONCE_LEN + AUTH_TAG_LEN; // 49

/**
 * Encrypt a plaintext blob with a password.
 *
 * Each call generates a fresh random salt + nonce, so the ciphertext for
 * the same (plaintext, password) pair is different every time — no nonce
 * reuse across encryptions of the same key.
 *
 * @param plaintext bytes to encrypt (may be empty)
 * @param password  user-supplied passphrase (must be non-empty)
 * @returns         encrypted blob (49-byte header + ciphertext)
 */
export async function encryptEnvelope(
  plaintext: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  if (!password) throw new Error("Password must not be empty");

  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = await pbkdf2Async(password, salt, PBKDF2_ITERATIONS, KEY_LEN, "sha256");

  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const magic = Buffer.from(MAGIC, "ascii");
  const version = Buffer.from([VERSION]);
  return new Uint8Array(Buffer.concat([magic, version, salt, nonce, authTag, ciphertext]));
}

/**
 * Decrypt a blob produced by {@link encryptEnvelope}.
 *
 * Throws an explicit error on any failure path:
 *   - blob shorter than the 49-byte header
 *   - bad magic (not "NAIA")
 *   - unsupported version
 *   - empty password
 *   - wrong password or tampered ciphertext (GCM authTag check)
 *
 * @param blob      encrypted blob from {@link encryptEnvelope}
 * @param password  user-supplied passphrase
 * @returns         decrypted plaintext bytes
 */
export async function decryptEnvelope(
  blob: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  if (!password) throw new Error("Password must not be empty");

  // Header must fit; ciphertext may legitimately be 0 bytes (empty plaintext).
  if (blob.length < HEADER_SIZE) {
    throw new Error("Invalid envelope: blob too short");
  }
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);

  const magic = buf.subarray(0, 4).toString("ascii");
  if (magic !== MAGIC) {
    throw new Error("Invalid envelope: bad magic");
  }

  const blobVersion = buf[4];
  if (blobVersion !== VERSION) {
    throw new Error(`Unsupported envelope version: ${blobVersion}`);
  }

  const salt = buf.subarray(5, 5 + SALT_LEN);
  const nonce = buf.subarray(5 + SALT_LEN, 5 + SALT_LEN + NONCE_LEN);
  const authTag = buf.subarray(
    5 + SALT_LEN + NONCE_LEN,
    5 + SALT_LEN + NONCE_LEN + AUTH_TAG_LEN,
  );
  const ciphertext = buf.subarray(HEADER_SIZE);

  const key = await pbkdf2Async(password, salt, PBKDF2_ITERATIONS, KEY_LEN, "sha256");

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: AUTH_TAG_LEN });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("Decryption failed: wrong password or corrupted blob");
  }
}

/**
 * Generate a cryptographically random master password as a hex string.
 * Default 32 bytes = 64 hex chars (256 bits of entropy).
 */
export function generateMasterPassword(byteLength: number = 32): string {
  if (byteLength <= 0 || !Number.isInteger(byteLength)) {
    throw new Error("byteLength must be a positive integer");
  }
  return randomBytes(byteLength).toString("hex");
}
