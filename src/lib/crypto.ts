/**
 * Sync-level encryption for E2EE cloud sync.
 *
 * SQLCipher handles local at-rest encryption (via encryptionKey on libSQL client).
 * This module handles ONLY the sync blob encryption layer:
 *   - HKDF-SHA256 key derivation from master key → sync key
 *   - AES-256-GCM encrypt/decrypt for sync blobs
 *
 * Field-level encryption (v1.x) has been removed — SQLCipher replaces it.
 *
 * @module crypto
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SYNC_HKDF_INFO = "exe-mem-sync-v2";

let _syncKey: Buffer | null = null;

/**
 * Initialize the sync crypto module by deriving a sync key from the master key.
 * Uses HKDF-SHA256 with info="exe-mem-sync-v2".
 * Must be called before encryptSyncBlob/decryptSyncBlob.
 */
export function initSyncCrypto(masterKey: Buffer): void {
  if (masterKey.length !== 32) {
    throw new Error(`Master key must be 32 bytes, got ${masterKey.length}`);
  }
  _syncKey = Buffer.from(
    crypto.hkdfSync("sha256", masterKey, "", SYNC_HKDF_INFO, 32)
  );
}

/**
 * Check whether the sync crypto module has been initialized.
 */
export function isSyncCryptoInitialized(): boolean {
  return _syncKey !== null;
}

function requireSyncKey(): Buffer {
  if (!_syncKey) {
    throw new Error("Sync crypto not initialized. Call initSyncCrypto(masterKey) first.");
  }
  return _syncKey;
}

/**
 * Encrypt a data buffer for sync transport using AES-256-GCM.
 * Returns base64(IV[12] || ciphertext || authTag[16]).
 */
export function encryptSyncBlob(data: Buffer): string {
  const key = requireSyncKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/**
 * Decrypt a base64 sync blob back to the original data buffer.
 * Throws on tampered data or wrong key.
 */
export function decryptSyncBlob(ciphertext: string): Buffer {
  const key = requireSyncKey();
  const combined = Buffer.from(ciphertext, "base64");

  if (combined.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Sync blob too short to contain IV + tag");
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}
