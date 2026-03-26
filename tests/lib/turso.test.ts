/**
 * Tests for src/lib/turso.ts — libSQL client with SQLCipher + schema management
 *
 * Covers: initTurso (plain + encrypted), ensureSchema (memories, FTS5, sync_meta),
 * getClient, disposeTurso.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  initTurso,
  getClient,
  ensureSchema,
  disposeTurso,
} from "../../src/lib/turso.js";

describe("turso.ts — libSQL client with SQLCipher", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-turso-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(async () => {
    await disposeTurso();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("initTurso", () => {
    test("initializes with dbPath only (no encryption)", async () => {
      await initTurso({ dbPath });
      expect(() => getClient()).not.toThrow();
    });

    test("initializes with dbPath and encryptionKey", async () => {
      const encryptionKey = crypto.randomBytes(32).toString("hex");
      await initTurso({ dbPath, encryptionKey });
      expect(() => getClient()).not.toThrow();
    });

    test("creates a database file on disk after schema setup", async () => {
      await initTurso({ dbPath });
      await ensureSchema();
      const exists = await fs
        .access(dbPath)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });
  });

  describe("ensureSchema — memories table", () => {
    test("creates memories table with correct columns (no hash columns, has version)", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute("PRAGMA table_info(memories)");
      const columnNames = result.rows.map((r) => r.name as string);

      // Expected columns present
      const expected = [
        "id",
        "agent_id",
        "agent_role",
        "session_id",
        "timestamp",
        "tool_name",
        "project_name",
        "has_error",
        "raw_text",
        "vector",
        "version",
      ];
      for (const col of expected) {
        expect(columnNames).toContain(col);
      }

      // Hash columns must NOT exist (removed in v2)
      expect(columnNames).not.toContain("agent_id_hash");
      expect(columnNames).not.toContain("tool_name_hash");
      expect(columnNames).not.toContain("project_name_hash");
    });

    test("id is PRIMARY KEY", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute("PRAGMA table_info(memories)");
      const idCol = result.rows.find((r) => r.name === "id");
      expect(idCol?.pk).toBe(1);
    });

    test("version column exists with default 0", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute("PRAGMA table_info(memories)");
      const versionCol = result.rows.find((r) => r.name === "version");
      expect(versionCol).toBeDefined();
      expect(versionCol?.dflt_value).toBe("0");
    });

    test("is idempotent (safe to call multiple times)", async () => {
      await initTurso({ dbPath });
      await ensureSchema();
      await expect(ensureSchema()).resolves.not.toThrow();
    });
  });

  describe("ensureSchema — FTS5 table and triggers", () => {
    test("creates memories_fts virtual table", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"
      );
      expect(result.rows.length).toBe(1);
    });

    test("creates FTS insert trigger", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='memories_fts_ai'"
      );
      expect(result.rows.length).toBe(1);
    });

    test("creates FTS delete trigger", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='memories_fts_ad'"
      );
      expect(result.rows.length).toBe(1);
    });

    test("creates FTS update trigger", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='memories_fts_au'"
      );
      expect(result.rows.length).toBe(1);
    });
  });

  describe("ensureSchema — sync_meta table", () => {
    test("creates sync_meta table", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_meta'"
      );
      expect(result.rows.length).toBe(1);
    });

    test("sync_meta has key and value columns", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute("PRAGMA table_info(sync_meta)");
      const columnNames = result.rows.map((r) => r.name as string);
      expect(columnNames).toContain("key");
      expect(columnNames).toContain("value");
    });

    test("sync_meta key is PRIMARY KEY", async () => {
      await initTurso({ dbPath });
      await ensureSchema();

      const client = getClient();
      const result = await client.execute("PRAGMA table_info(sync_meta)");
      const keyCol = result.rows.find((r) => r.name === "key");
      expect(keyCol?.pk).toBe(1);
    });
  });

  describe("getClient", () => {
    test("throws when not initialized", () => {
      expect(() => getClient()).toThrow();
    });

    test("returns client after init", async () => {
      await initTurso({ dbPath });
      expect(() => getClient()).not.toThrow();
    });
  });

  describe("disposeTurso", () => {
    test("closes client and getClient throws after dispose", async () => {
      await initTurso({ dbPath });
      await disposeTurso();
      expect(() => getClient()).toThrow();
    });

    test("safe to call multiple times", async () => {
      await initTurso({ dbPath });
      await disposeTurso();
      await expect(disposeTurso()).resolves.not.toThrow();
    });
  });
});
