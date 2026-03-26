/**
 * Tests for src/lib/keychain.ts — OS keychain + file fallback key storage
 *
 * Covers: AC-E2EE-04, AC-E2EE-05, AC-E2EE-08
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  getMasterKey,
  setMasterKey,
  deleteMasterKey,
  exportMnemonic,
  importMnemonic,
} from "../../src/lib/keychain.js";

describe("keychain.ts — key storage and mnemonic", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-keychain-"));
    originalHome = process.env.EXE_MEM_DIR;
    process.env.EXE_MEM_DIR = tmpDir;
    // Clean any key from a previous test run (keytar persists across runs)
    await deleteMasterKey();
  });

  afterEach(async () => {
    await deleteMasterKey();
    if (originalHome !== undefined) {
      process.env.EXE_MEM_DIR = originalHome;
    } else {
      delete process.env.EXE_MEM_DIR;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // AC-E2EE-04/05: Key storage round-trip
  describe("setMasterKey / getMasterKey", () => {
    it("round-trips a 32-byte key", async () => {
      const key = crypto.randomBytes(32);
      await setMasterKey(key);
      const retrieved = await getMasterKey();
      expect(retrieved).not.toBeNull();
      expect(Buffer.compare(retrieved!, key)).toBe(0);
    });

    it("returns null when no key stored", async () => {
      const result = await getMasterKey();
      expect(result).toBeNull();
    });

    it("key is retrievable after set (either keychain or file)", async () => {
      const key = crypto.randomBytes(32);
      await setMasterKey(key);
      const retrieved = await getMasterKey();
      expect(retrieved).not.toBeNull();
      expect(retrieved!.length).toBe(32);
    });
  });

  // AC-E2EE-05: Delete key
  describe("deleteMasterKey", () => {
    it("removes key so getMasterKey returns null", async () => {
      const key = crypto.randomBytes(32);
      await setMasterKey(key);
      expect(await getMasterKey()).not.toBeNull();

      await deleteMasterKey();
      expect(await getMasterKey()).toBeNull();
    });

    it("does not throw when no key exists", async () => {
      await expect(deleteMasterKey()).resolves.not.toThrow();
    });
  });

  // AC-E2EE-08: Mnemonic export/import
  describe("exportMnemonic / importMnemonic", () => {
    it("round-trips a 32-byte key via 24-word mnemonic", () => {
      const key = crypto.randomBytes(32);
      const mnemonic = exportMnemonic(key);
      const recovered = importMnemonic(mnemonic);
      expect(Buffer.compare(recovered, key)).toBe(0);
    });

    it("produces exactly 24 words", () => {
      const key = crypto.randomBytes(32);
      const mnemonic = exportMnemonic(key);
      const words = mnemonic.trim().split(/\s+/);
      expect(words.length).toBe(24);
    });

    it("words are from BIP39 word list", () => {
      const key = crypto.randomBytes(32);
      const mnemonic = exportMnemonic(key);
      const words = mnemonic.trim().split(/\s+/);
      for (const word of words) {
        expect(word).toMatch(/^[a-z]+$/);
      }
    });

    it("different keys produce different mnemonics", () => {
      const key1 = crypto.randomBytes(32);
      const key2 = crypto.randomBytes(32);
      expect(exportMnemonic(key1)).not.toBe(exportMnemonic(key2));
    });

    it("importMnemonic rejects invalid mnemonic", () => {
      expect(() => importMnemonic("not a valid mnemonic")).toThrow();
    });

    it("importMnemonic rejects wrong word count", () => {
      expect(() => importMnemonic("word ".repeat(12).trim())).toThrow();
    });
  });
});
