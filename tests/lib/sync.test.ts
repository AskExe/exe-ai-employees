/**
 * Tests for src/lib/sync.ts — E2EE sync module (Turso BYOK)
 *
 * Uses file-based libSQL as both local and "cloud" clients (no real network).
 * Crypto is initialized with a random 32-byte master key.
 *
 * Covers:
 *   - initSync: cloud client setup, sync_blobs table, device_id generation/reuse
 *   - pushChanges: returns 0 when not init'd, pushes + encrypts records, updates version
 *   - pullChanges: returns 0 when not init'd, pulls + decrypts, skips own device, handles corrupt blobs
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createClient } from "@libsql/client";

import { initTurso, getClient, ensureSchema, disposeTurso } from "../../src/lib/turso.js";
import { initSync, pushChanges, pullChanges, disposeSync } from "../../src/lib/sync.js";
import { initSyncCrypto, encryptSyncBlob } from "../../src/lib/crypto.js";
import { compress } from "../../src/lib/compress.js";

describe("sync.ts — E2EE sync module", () => {
  let tmpDir: string;
  let localDbPath: string;
  let cloudDbPath: string;
  const masterKey = crypto.randomBytes(32);

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-sync-"));
    localDbPath = path.join(tmpDir, "local.db");
    cloudDbPath = path.join(tmpDir, "cloud.db");

    // Initialize local turso client (used by sync module via getClient())
    await initTurso({ dbPath: localDbPath });
    await ensureSchema();
  });

  afterEach(async () => {
    await disposeSync();
    await disposeTurso();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Helper: insert records directly into local memories table
  async function insertLocalRecords(
    records: Array<{
      id: string;
      agent_id: string;
      agent_role: string;
      session_id: string;
      timestamp: string;
      tool_name: string;
      project_name: string;
      has_error: number;
      raw_text: string;
      version: number;
    }>,
  ) {
    const client = getClient();
    for (const rec of records) {
      await client.execute({
        sql: `INSERT INTO memories (id, agent_id, agent_role, session_id, timestamp,
              tool_name, project_name, has_error, raw_text, version)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          rec.id, rec.agent_id, rec.agent_role, rec.session_id,
          rec.timestamp, rec.tool_name, rec.project_name,
          rec.has_error, rec.raw_text, rec.version,
        ],
      });
    }
  }

  const sampleRecords = [
    {
      id: "rec-1",
      agent_id: "yoshi",
      agent_role: "CTO",
      session_id: "sess-1",
      timestamp: "2026-01-01T00:00:00Z",
      tool_name: "Bash",
      project_name: "project-alpha",
      has_error: 0,
      raw_text: "ls output here",
      version: 1,
    },
    {
      id: "rec-2",
      agent_id: "gen",
      agent_role: "AI",
      session_id: "sess-2",
      timestamp: "2026-01-02T00:00:00Z",
      tool_name: "Read",
      project_name: "project-beta",
      has_error: 0,
      raw_text: "file contents here",
      version: 2,
    },
  ];

  // ---------------------------------------------------------------------------
  // initSync
  // ---------------------------------------------------------------------------

  describe("initSync", () => {
    test("creates cloud client and sync_blobs table", async () => {
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      // Verify sync_blobs table exists in cloud db
      const cloudClient = createClient({ url: `file:${cloudDbPath}` });
      const result = await cloudClient.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sync_blobs'"
      );
      expect(result.rows.length).toBe(1);
      cloudClient.close();
    });

    test("generates device_id on first init", async () => {
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const localClient = getClient();
      const result = await localClient.execute(
        "SELECT value FROM sync_meta WHERE key = 'device_id'"
      );
      expect(result.rows.length).toBe(1);
      const deviceId = result.rows[0]!.value as string;
      // UUID v4 format: 8-4-4-4-12 hex chars
      expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    test("reuses existing device_id on subsequent inits", async () => {
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const localClient = getClient();
      const firstResult = await localClient.execute(
        "SELECT value FROM sync_meta WHERE key = 'device_id'"
      );
      const firstDeviceId = firstResult.rows[0]!.value as string;

      // Dispose and re-init (simulates restart)
      await disposeSync();
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const secondResult = await localClient.execute(
        "SELECT value FROM sync_meta WHERE key = 'device_id'"
      );
      const secondDeviceId = secondResult.rows[0]!.value as string;

      expect(secondDeviceId).toBe(firstDeviceId);
    });

    test("creates sync_blobs index in cloud db", async () => {
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const cloudClient = createClient({ url: `file:${cloudDbPath}` });
      const result = await cloudClient.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_blobs_device_version'"
      );
      expect(result.rows.length).toBe(1);
      cloudClient.close();
    });
  });

  // ---------------------------------------------------------------------------
  // pushChanges
  // ---------------------------------------------------------------------------

  describe("pushChanges", () => {
    test("returns 0 when not initialized", async () => {
      // Don't call initSync — module is not initialized
      const result = await pushChanges();
      expect(result).toBe(0);
    });

    test("returns 0 when there are no new records", async () => {
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const result = await pushChanges();
      expect(result).toBe(0);
    });

    test("pushes records to cloud and updates last_push_version", async () => {
      await insertLocalRecords(sampleRecords);
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const pushed = await pushChanges();
      expect(pushed).toBe(sampleRecords.length);

      // Verify cloud has the blob
      const cloudClient = createClient({ url: `file:${cloudDbPath}` });
      const blobsResult = await cloudClient.execute("SELECT COUNT(*) as cnt FROM sync_blobs");
      expect(Number(blobsResult.rows[0]!.cnt)).toBeGreaterThan(0);
      cloudClient.close();

      // Verify last_push_version was updated
      const localClient = getClient();
      const metaResult = await localClient.execute(
        "SELECT value FROM sync_meta WHERE key = 'last_push_version'"
      );
      expect(metaResult.rows.length).toBe(1);
      const lastPushVersion = Number(metaResult.rows[0]!.value);
      expect(lastPushVersion).toBe(2); // max version of sample records
    });

    test("compresses and encrypts records before upload", async () => {
      await insertLocalRecords(sampleRecords);
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      await pushChanges();

      // Read the blob from cloud
      const cloudClient = createClient({ url: `file:${cloudDbPath}` });
      const blobResult = await cloudClient.execute("SELECT blob FROM sync_blobs LIMIT 1");
      const blobValue = blobResult.rows[0]!.blob as string;
      cloudClient.close();

      // Blob should be a base64 string (encrypted)
      expect(typeof blobValue).toBe("string");
      expect(blobValue.length).toBeGreaterThan(0);

      // Should not contain plaintext record data
      expect(blobValue).not.toContain(sampleRecords[0]!.agent_id);
      expect(blobValue).not.toContain(sampleRecords[0]!.raw_text);
    });

    test("does not re-push already pushed records", async () => {
      await insertLocalRecords(sampleRecords);
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const firstPush = await pushChanges();
      expect(firstPush).toBe(sampleRecords.length);

      // Second push with no new records
      const secondPush = await pushChanges();
      expect(secondPush).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // pullChanges
  // ---------------------------------------------------------------------------

  describe("pullChanges", () => {
    test("returns 0 when not initialized", async () => {
      const result = await pullChanges();
      expect(result).toBe(0);
    });

    test("returns 0 when there are no blobs to pull", async () => {
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const result = await pullChanges();
      expect(result).toBe(0);
    });

    test("pulls and decrypts records from other devices", async () => {
      // Initialize sync crypto for manual blob creation
      initSyncCrypto(masterKey);

      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      // Simulate another device pushing records directly into cloud
      const otherDeviceId = "other-device-" + crypto.randomUUID();
      const remoteRecords = [
        {
          id: "remote-1",
          agent_id: "remote-agent",
          agent_role: "engineer",
          session_id: "remote-sess",
          timestamp: "2026-02-01T00:00:00Z",
          tool_name: "Bash",
          project_name: "remote-project",
          has_error: 0,
          raw_text: "remote tool output",
          version: 5,
        },
      ];

      const json = JSON.stringify(remoteRecords);
      const compressed = compress(Buffer.from(json, "utf8"));
      const encrypted = encryptSyncBlob(compressed);

      const cloudClient = createClient({ url: `file:${cloudDbPath}` });
      await cloudClient.execute({
        sql: `INSERT INTO sync_blobs (device_id, version, blob, created_at)
              VALUES (?, ?, ?, ?)`,
        args: [otherDeviceId, 5, encrypted, new Date().toISOString()],
      });
      cloudClient.close();

      // Pull changes
      const pulled = await pullChanges();
      expect(pulled).toBe(remoteRecords.length);

      // Verify record was inserted locally
      const localClient = getClient();
      const localResult = await localClient.execute(
        "SELECT id, agent_id, raw_text FROM memories WHERE id = 'remote-1'"
      );
      expect(localResult.rows.length).toBe(1);
      expect(localResult.rows[0]!.agent_id).toBe(remoteRecords[0]!.agent_id);
      expect(localResult.rows[0]!.raw_text).toBe(remoteRecords[0]!.raw_text);
    });

    test("skips own device's blobs", async () => {
      await insertLocalRecords(sampleRecords);
      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      // Push our own records
      await pushChanges();

      // Try to pull — should get 0 since all blobs are from our own device
      const pulled = await pullChanges();
      expect(pulled).toBe(0);
    });

    test("handles corrupt blobs gracefully", async () => {
      initSyncCrypto(masterKey);

      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      // Insert a corrupt blob from another device
      const otherDeviceId = "corrupt-device-" + crypto.randomUUID();
      const cloudClient = createClient({ url: `file:${cloudDbPath}` });
      await cloudClient.execute({
        sql: `INSERT INTO sync_blobs (device_id, version, blob, created_at)
              VALUES (?, ?, ?, ?)`,
        args: [otherDeviceId, 1, "not-valid-encrypted-data", new Date().toISOString()],
      });
      cloudClient.close();

      // Should not throw, should return 0 (corrupt blob skipped)
      const pulled = await pullChanges();
      expect(pulled).toBe(0);
    });

    test("processes valid blobs even when some are corrupt", async () => {
      initSyncCrypto(masterKey);

      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const otherDeviceId = "mixed-device-" + crypto.randomUUID();

      // Create one valid blob
      const validRecords = [
        {
          id: "valid-1",
          agent_id: "valid-agent",
          agent_role: "AI",
          session_id: "valid-sess",
          timestamp: "2026-03-01T00:00:00Z",
          tool_name: "Bash",
          project_name: "valid-project",
          has_error: 0,
          raw_text: "valid content",
          version: 10,
        },
      ];
      const json = JSON.stringify(validRecords);
      const compressed = compress(Buffer.from(json, "utf8"));
      const encrypted = encryptSyncBlob(compressed);

      const cloudClient = createClient({ url: `file:${cloudDbPath}` });

      // Insert corrupt blob first (version 1)
      await cloudClient.execute({
        sql: `INSERT INTO sync_blobs (device_id, version, blob, created_at)
              VALUES (?, ?, ?, ?)`,
        args: [otherDeviceId, 1, "garbage-data", new Date().toISOString()],
      });

      // Insert valid blob second (version 10)
      await cloudClient.execute({
        sql: `INSERT INTO sync_blobs (device_id, version, blob, created_at)
              VALUES (?, ?, ?, ?)`,
        args: [otherDeviceId, 10, encrypted, new Date().toISOString()],
      });
      cloudClient.close();

      const pulled = await pullChanges();
      // Only the valid blob's records should be counted
      expect(pulled).toBe(validRecords.length);

      // Verify the valid record was inserted
      const localClient = getClient();
      const result = await localClient.execute(
        "SELECT id FROM memories WHERE id = 'valid-1'"
      );
      expect(result.rows.length).toBe(1);
    });

    test("updates last_pull_version after successful pull", async () => {
      initSyncCrypto(masterKey);

      await initSync({ url: `file:${cloudDbPath}`, masterKey });

      const otherDeviceId = "version-device-" + crypto.randomUUID();
      const records = [
        {
          id: "ver-1",
          agent_id: "agent",
          agent_role: "AI",
          session_id: "sess",
          timestamp: "2026-03-15T00:00:00Z",
          tool_name: "Read",
          project_name: "proj",
          has_error: 0,
          raw_text: "data",
          version: 7,
        },
      ];
      const json = JSON.stringify(records);
      const compressed = compress(Buffer.from(json, "utf8"));
      const encrypted = encryptSyncBlob(compressed);

      const cloudClient = createClient({ url: `file:${cloudDbPath}` });
      await cloudClient.execute({
        sql: `INSERT INTO sync_blobs (device_id, version, blob, created_at)
              VALUES (?, ?, ?, ?)`,
        args: [otherDeviceId, 7, encrypted, new Date().toISOString()],
      });
      cloudClient.close();

      await pullChanges();

      const localClient = getClient();
      const metaResult = await localClient.execute(
        "SELECT value FROM sync_meta WHERE key = 'last_pull_version'"
      );
      expect(metaResult.rows.length).toBe(1);
      expect(Number(metaResult.rows[0]!.value)).toBe(7);
    });
  });
});
