/**
 * Tests for src/lib/config.ts — updated config with Turso + legacy r2 handling
 *
 * Covers: AC-CFG-01, AC-CFG-02
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig, loadConfigSync, saveConfig } from "../../src/lib/config.js";
import type { ExeAiConfig } from "../../src/lib/config.js";

describe("config.ts — Turso config + legacy handling", () => {
  let tmpDir: string;
  let originalConfigPath: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-config-"));
    // Tests will need to override CONFIG_PATH — implementation detail
    // For now, test via the public API using EXE_MEM_DIR env var
    originalConfigPath = process.env.EXE_MEM_DIR;
    process.env.EXE_MEM_DIR = tmpDir;
  });

  afterEach(async () => {
    if (originalConfigPath !== undefined) {
      process.env.EXE_MEM_DIR = originalConfigPath;
    } else {
      delete process.env.EXE_MEM_DIR;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // AC-CFG-01: Updated config schema
  describe("new config schema", () => {
    it("default config has dbPath field", async () => {
      const config = await loadConfig();
      expect(config.dbPath).toBeDefined();
      expect(typeof config.dbPath).toBe("string");
      expect(config.dbPath).toContain("memories.db");
    });

    it("default config has no turso field", async () => {
      const config = await loadConfig();
      expect(config.turso).toBeUndefined();
    });

    it("default config has no r2 field", async () => {
      const config = await loadConfig();
      expect((config as Record<string, unknown>).r2).toBeUndefined();
    });

    it("default config has no syncIntervalMs field", async () => {
      const config = await loadConfig();
      expect((config as Record<string, unknown>).syncIntervalMs).toBeUndefined();
    });

    it("saves and loads turso config", async () => {
      const config = await loadConfig();
      config.turso = {
        url: "libsql://test-db.turso.io",
        authToken: "test-token-123",
        syncUrl: "libsql://test-db.turso.io",
      };
      await saveConfig(config);

      const loaded = await loadConfig();
      expect(loaded.turso).toBeDefined();
      expect(loaded.turso!.url).toBe("libsql://test-db.turso.io");
      expect(loaded.turso!.authToken).toBe("test-token-123");
    });
  });

  // AC-CFG-02: Legacy r2 config handled
  describe("legacy r2 config migration", () => {
    it("strips r2 field from loaded config", async () => {
      // Write a v1.0 style config
      const legacyConfig = {
        r2: {
          accountId: "old-account",
          accessKeyId: "old-key",
          secretAccessKey: "old-secret",
          bucketName: "old-bucket",
        },
        modelFile: "jina-embeddings-v5-small-q8_0.gguf",
        embeddingDim: 1024,
        syncIntervalMs: 30000,
        batchSize: 20,
        flushIntervalMs: 10000,
        autoIngestion: true,
        autoRetrieval: true,
        searchMode: "hybrid",
        hookSearchMode: "fts",
      };
      const configPath = path.join(tmpDir, "config.json");
      await fs.writeFile(configPath, JSON.stringify(legacyConfig, null, 2));

      // Capture stderr for deprecation warning
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const config = await loadConfig();

      // r2 should be stripped
      expect((config as Record<string, unknown>).r2).toBeUndefined();

      // Other fields should be preserved
      expect(config.modelFile).toBe("jina-embeddings-v5-small-q8_0.gguf");
      expect(config.batchSize).toBe(20);

      // New defaults should be applied
      expect(config.dbPath).toBeDefined();

      stderrSpy.mockRestore();
    });

    it("loadConfig does not error on legacy config", async () => {
      const legacyConfig = { r2: { accountId: "test" }, modelFile: "test.gguf" };
      const configPath = path.join(tmpDir, "config.json");
      await fs.writeFile(configPath, JSON.stringify(legacyConfig));

      await expect(loadConfig()).resolves.not.toThrow();
    });
  });

  describe("loadConfigSync", () => {
    it("returns defaults when no config file", () => {
      const config = loadConfigSync();
      expect(config.modelFile).toBeDefined();
      expect(config.batchSize).toBe(20);
    });
  });
});
