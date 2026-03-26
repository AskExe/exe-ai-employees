/**
 * Tests for src/lib/crypto.ts — Sync-level AES-256-GCM encryption
 *
 * SQLCipher handles local at-rest encryption.
 * This module tests ONLY the sync blob encryption layer:
 *   - HKDF key derivation from master key
 *   - AES-256-GCM encrypt/decrypt for sync blobs
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

import {
  initSyncCrypto,
  encryptSyncBlob,
  decryptSyncBlob,
  isSyncCryptoInitialized,
} from "../../src/lib/crypto.js";

describe("crypto.ts — sync blob encryption", () => {
  const masterKey = crypto.randomBytes(32);

  beforeEach(() => {
    initSyncCrypto(masterKey);
  });

  describe("initSyncCrypto", () => {
    test("accepts a valid 32-byte key", () => {
      expect(() => initSyncCrypto(crypto.randomBytes(32))).not.toThrow();
    });

    test("rejects a 16-byte key", () => {
      expect(() => initSyncCrypto(crypto.randomBytes(16))).toThrow(
        /must be 32 bytes/
      );
    });

    test("rejects a 64-byte key", () => {
      expect(() => initSyncCrypto(crypto.randomBytes(64))).toThrow(
        /must be 32 bytes/
      );
    });

    test("rejects an empty buffer", () => {
      expect(() => initSyncCrypto(Buffer.alloc(0))).toThrow(
        /must be 32 bytes/
      );
    });
  });

  describe("isSyncCryptoInitialized", () => {
    test("returns true after initSyncCrypto", () => {
      expect(isSyncCryptoInitialized()).toBe(true);
    });
  });

  describe("encryptSyncBlob / decryptSyncBlob round-trip", () => {
    test("round-trips a simple buffer", () => {
      const data = Buffer.from("hello world");
      const encrypted = encryptSyncBlob(data);
      const decrypted = decryptSyncBlob(encrypted);
      expect(decrypted.toString()).toBe("hello world");
    });

    test("round-trips binary data", () => {
      const data = crypto.randomBytes(256);
      const encrypted = encryptSyncBlob(data);
      const decrypted = decryptSyncBlob(encrypted);
      expect(Buffer.compare(decrypted, data)).toBe(0);
    });

    test("round-trips a large buffer", () => {
      const data = crypto.randomBytes(100_000);
      const encrypted = encryptSyncBlob(data);
      const decrypted = decryptSyncBlob(encrypted);
      expect(Buffer.compare(decrypted, data)).toBe(0);
    });

    test("round-trips JSON serialized data", () => {
      const obj = { agent_id: "test", raw_text: "memory content", version: 42 };
      const data = Buffer.from(JSON.stringify(obj));
      const encrypted = encryptSyncBlob(data);
      const decrypted = decryptSyncBlob(encrypted);
      expect(JSON.parse(decrypted.toString())).toEqual(obj);
    });

    test("encrypted output is valid base64", () => {
      const data = Buffer.from("test");
      const encrypted = encryptSyncBlob(data);
      expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
      const decoded = Buffer.from(encrypted, "base64");
      // IV(12) + at least 1 byte ciphertext + tag(16) = minimum 29 bytes
      expect(decoded.length).toBeGreaterThanOrEqual(29);
    });
  });

  describe("non-deterministic encryption", () => {
    test("two encryptions of the same data produce different ciphertext", () => {
      const data = Buffer.from("determinism check");
      const ct1 = encryptSyncBlob(data);
      const ct2 = encryptSyncBlob(data);
      expect(ct1).not.toBe(ct2);
    });

    test("different IVs per encryption (first 12 bytes differ)", () => {
      const data = Buffer.from("iv check");
      const ct1 = Buffer.from(encryptSyncBlob(data), "base64");
      const ct2 = Buffer.from(encryptSyncBlob(data), "base64");
      const iv1 = ct1.subarray(0, 12);
      const iv2 = ct2.subarray(0, 12);
      expect(Buffer.compare(iv1, iv2)).not.toBe(0);
    });

    test("both ciphertexts decrypt to the same plaintext", () => {
      const data = Buffer.from("both should decrypt");
      const ct1 = encryptSyncBlob(data);
      const ct2 = encryptSyncBlob(data);
      expect(decryptSyncBlob(ct1).toString()).toBe("both should decrypt");
      expect(decryptSyncBlob(ct2).toString()).toBe("both should decrypt");
    });
  });

  describe("decryptSyncBlob fails with wrong key", () => {
    test("throws when decrypting with a different master key", () => {
      const data = Buffer.from("secret payload");
      const encrypted = encryptSyncBlob(data);

      // Re-init with a different key
      initSyncCrypto(crypto.randomBytes(32));

      expect(() => decryptSyncBlob(encrypted)).toThrow();
    });

    test("throws on tampered ciphertext", () => {
      const data = Buffer.from("tamper test");
      const encrypted = encryptSyncBlob(data);
      const buf = Buffer.from(encrypted, "base64");
      buf[buf.length - 1] ^= 0xff; // flip last byte of auth tag
      const tampered = buf.toString("base64");
      expect(() => decryptSyncBlob(tampered)).toThrow();
    });

    test("throws on truncated ciphertext", () => {
      expect(() => decryptSyncBlob("AAAA")).toThrow();
    });
  });
});
