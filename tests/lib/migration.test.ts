/**
 * Tests for src/lib/migration.ts — Database format detection and migration
 *
 * Covers:
 *   - detectFormat: identifies new, sqlcipher, field_v1x, unencrypted databases
 *   - migrateToSqlcipher: migrates plaintext records, preserves data, creates .bak
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createClient } from "@libsql/client";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { detectFormat, migrateToSqlcipher } from "../../src/lib/migration.js";

describe("migration.ts — format detection and migration", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-migration-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -- Helper: create a legacy v1.x schema with hash columns ----------------

  async function createLegacyDb(
    rows: Array<{
      id: string;
      agent_id: string;
      agent_role: string;
      session_id: string;
      timestamp: string;
      tool_name: string;
      project_name: string;
      has_error: number;
      raw_text: string;
    }>,
  ) {
    const client = createClient({ url: `file:${dbPath}` });
    await client.executeMultiple(`
      CREATE TABLE IF NOT EXISTS memories (
        id              TEXT PRIMARY KEY,
        agent_id        TEXT NOT NULL,
        agent_id_hash   TEXT,
        agent_role      TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        timestamp       TEXT NOT NULL,
        tool_name       TEXT NOT NULL,
        tool_name_hash  TEXT,
        project_name    TEXT NOT NULL,
        project_name_hash TEXT,
        has_error       INTEGER NOT NULL DEFAULT 0,
        raw_text        TEXT NOT NULL,
        vector          F32_BLOB(1024)
      );
    `);
    for (const row of rows) {
      await client.execute({
        sql: `INSERT INTO memories (id, agent_id, agent_id_hash, agent_role, session_id,
              timestamp, tool_name, tool_name_hash, project_name, project_name_hash,
              has_error, raw_text)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          row.id,
          row.agent_id,
          "hash_" + row.agent_id,
          row.agent_role,
          row.session_id,
          row.timestamp,
          row.tool_name,
          "hash_" + row.tool_name,
          row.project_name,
          "hash_" + row.project_name,
          row.has_error,
          row.raw_text,
        ],
      });
    }
    client.close();
  }

  // ---------------------------------------------------------------------------
  // detectFormat
  // ---------------------------------------------------------------------------

  describe("detectFormat", () => {
    test("returns 'new' when database file does not exist", async () => {
      const result = await detectFormat(path.join(tmpDir, "nonexistent.db"));
      expect(result).toBe("new");
    });

    test("returns 'sqlcipher' when file exists but cannot be opened without key", async () => {
      // Create an encrypted database using SQLCipher
      const encKey = crypto.randomBytes(32).toString("hex");
      const client = createClient({
        url: `file:${dbPath}`,
        encryptionKey: encKey,
      });
      await client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL
        );
      `);
      client.close();

      const result = await detectFormat(dbPath);
      expect(result).toBe("sqlcipher");
    });

    test("returns 'field_v1x' when file has agent_id_hash column with base64 values", async () => {
      // Create a base64-like agent_id to simulate v1.x field-encrypted values
      // A long enough base64 string (20+ chars) matching the regex in migration.ts
      const fakeEncryptedAgentId = crypto.randomBytes(24).toString("base64");

      const client = createClient({ url: `file:${dbPath}` });
      await client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS memories (
          id              TEXT PRIMARY KEY,
          agent_id        TEXT NOT NULL,
          agent_id_hash   TEXT,
          agent_role      TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          timestamp       TEXT NOT NULL,
          tool_name       TEXT NOT NULL,
          project_name    TEXT NOT NULL,
          has_error       INTEGER NOT NULL DEFAULT 0,
          raw_text        TEXT NOT NULL,
          vector          F32_BLOB(1024)
        );
      `);
      await client.execute({
        sql: `INSERT INTO memories (id, agent_id, agent_id_hash, agent_role, session_id,
              timestamp, tool_name, project_name, has_error, raw_text)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          "rec-1",
          fakeEncryptedAgentId,
          "somehash",
          "role",
          "sess-1",
          "2026-01-01T00:00:00Z",
          "Bash",
          "project-x",
          0,
          "raw text content",
        ],
      });
      client.close();

      const result = await detectFormat(dbPath);
      expect(result).toBe("field_v1x");
    });

    test("returns 'unencrypted' when file has hash columns but plaintext values", async () => {
      await createLegacyDb([
        {
          id: "rec-1",
          agent_id: "yoshi",         // plaintext, not base64
          agent_role: "CTO",
          session_id: "sess-1",
          timestamp: "2026-01-01T00:00:00Z",
          tool_name: "Bash",
          project_name: "my-project",
          has_error: 0,
          raw_text: "some tool output",
        },
      ]);

      const result = await detectFormat(dbPath);
      expect(result).toBe("unencrypted");
    });

    test("returns 'unencrypted' when schema has no agent_id_hash column", async () => {
      // A DB that can be opened but doesn't have hash columns at all
      const client = createClient({ url: `file:${dbPath}` });
      await client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS memories (
          id         TEXT PRIMARY KEY,
          agent_id   TEXT NOT NULL,
          agent_role TEXT NOT NULL,
          session_id TEXT NOT NULL,
          timestamp  TEXT NOT NULL,
          tool_name  TEXT NOT NULL,
          project_name TEXT NOT NULL,
          has_error  INTEGER NOT NULL DEFAULT 0,
          raw_text   TEXT NOT NULL,
          vector     F32_BLOB(1024),
          version    INTEGER NOT NULL DEFAULT 0
        );
      `);
      client.close();

      const result = await detectFormat(dbPath);
      expect(result).toBe("unencrypted");
    });

    test("returns 'field_v1x' for empty table with hash columns", async () => {
      // Empty table with agent_id_hash column → treated as field_v1x
      const client = createClient({ url: `file:${dbPath}` });
      await client.executeMultiple(`
        CREATE TABLE IF NOT EXISTS memories (
          id              TEXT PRIMARY KEY,
          agent_id        TEXT NOT NULL,
          agent_id_hash   TEXT,
          agent_role      TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          timestamp       TEXT NOT NULL,
          tool_name       TEXT NOT NULL,
          project_name    TEXT NOT NULL,
          has_error       INTEGER NOT NULL DEFAULT 0,
          raw_text        TEXT NOT NULL,
          vector          F32_BLOB(1024)
        );
      `);
      client.close();

      const result = await detectFormat(dbPath);
      expect(result).toBe("field_v1x");
    });
  });

  // ---------------------------------------------------------------------------
  // migrateToSqlcipher
  // ---------------------------------------------------------------------------

  describe("migrateToSqlcipher", () => {
    const masterKey = crypto.randomBytes(32);

    const sampleRows = [
      {
        id: "rec-1",
        agent_id: "yoshi",
        agent_role: "CTO",
        session_id: "sess-1",
        timestamp: "2026-01-01T00:00:00Z",
        tool_name: "Bash",
        project_name: "project-alpha",
        has_error: 0,
        raw_text: "ls -la output here",
      },
      {
        id: "rec-2",
        agent_id: "gen",
        agent_role: "AI",
        session_id: "sess-2",
        timestamp: "2026-01-02T00:00:00Z",
        tool_name: "Read",
        project_name: "project-beta",
        has_error: 1,
        raw_text: "file not found error",
      },
      {
        id: "rec-3",
        agent_id: "dev-agent",
        agent_role: "engineer",
        session_id: "sess-3",
        timestamp: "2026-01-03T00:00:00Z",
        tool_name: "Write",
        project_name: "project-alpha",
        has_error: 0,
        raw_text: "wrote 42 lines to config.ts",
      },
    ];

    test("migrates plaintext records correctly", async () => {
      await createLegacyDb(sampleRows);

      const result = await migrateToSqlcipher(dbPath, masterKey);

      expect(result.recordsMigrated).toBe(sampleRows.length);
      expect(result.recordsSkipped).toBe(0);

      // Verify records exist in the new SQLCipher database
      const newClient = createClient({
        url: `file:${dbPath}`,
        encryptionKey: masterKey.toString("hex"),
      });

      const allRows = await newClient.execute(
        "SELECT id, agent_id, agent_role, tool_name, project_name, has_error, raw_text FROM memories ORDER BY id"
      );
      expect(allRows.rows.length).toBe(sampleRows.length);

      // Verify first record's fields match (without asserting string literals in responses)
      const firstRow = allRows.rows.find((r) => r.id === sampleRows[0]!.id);
      expect(firstRow).toBeDefined();
      expect(firstRow!.agent_id).toBe(sampleRows[0]!.agent_id);
      expect(firstRow!.agent_role).toBe(sampleRows[0]!.agent_role);
      expect(firstRow!.tool_name).toBe(sampleRows[0]!.tool_name);
      expect(firstRow!.project_name).toBe(sampleRows[0]!.project_name);
      expect(firstRow!.has_error).toBe(sampleRows[0]!.has_error);
      expect(firstRow!.raw_text).toBe(sampleRows[0]!.raw_text);

      newClient.close();
    });

    test("preserves data integrity — row counts match", async () => {
      await createLegacyDb(sampleRows);

      const result = await migrateToSqlcipher(dbPath, masterKey);

      const newClient = createClient({
        url: `file:${dbPath}`,
        encryptionKey: masterKey.toString("hex"),
      });

      const countResult = await newClient.execute("SELECT COUNT(*) as cnt FROM memories");
      const count = Number(countResult.rows[0]!.cnt);

      expect(count).toBe(result.recordsMigrated);
      expect(count).toBe(sampleRows.length);

      newClient.close();
    });

    test("creates .bak file of original database", async () => {
      await createLegacyDb(sampleRows);

      await migrateToSqlcipher(dbPath, masterKey);

      expect(existsSync(dbPath + ".bak")).toBe(true);
    });

    test("cleans up .new file on failure", async () => {
      // Use a non-existent db path to trigger an error during migration
      // (trying to open a file that doesn't exist as a source db)
      const badDbPath = path.join(tmpDir, "nonexistent.db");

      await expect(migrateToSqlcipher(badDbPath, masterKey)).rejects.toThrow();

      // The temporary .new file should not remain
      expect(existsSync(badDbPath + ".new")).toBe(false);
    });

    test("all records have sequential version numbers", async () => {
      await createLegacyDb(sampleRows);

      await migrateToSqlcipher(dbPath, masterKey);

      const newClient = createClient({
        url: `file:${dbPath}`,
        encryptionKey: masterKey.toString("hex"),
      });

      const allRows = await newClient.execute(
        "SELECT version FROM memories ORDER BY version ASC"
      );

      const versions = allRows.rows.map((r) => Number(r.version));
      // Versions should be sequential starting from 1
      for (let i = 0; i < versions.length; i++) {
        expect(versions[i]).toBe(i + 1);
      }

      newClient.close();
    });

    test("migrated db cannot be opened without encryption key", async () => {
      await createLegacyDb(sampleRows);

      await migrateToSqlcipher(dbPath, masterKey);

      // After migration, db should be SQLCipher-encrypted
      const format = await detectFormat(dbPath);
      expect(format).toBe("sqlcipher");
    });
  });
});
