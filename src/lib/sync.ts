/**
 * E2EE sync module: push/pull encrypted blobs to/from cloud.
 *
 * Local data is plaintext in RAM (SQLCipher encrypts on disk).
 * For sync, records are serialized → Brotli compressed → AES-256-GCM encrypted
 * before upload. Cloud sees only opaque blobs (zero-knowledge).
 *
 * @module sync
 */

import { createClient, type Client } from "@libsql/client";
import { getClient } from "./turso.js";
import { initSyncCrypto, encryptSyncBlob, decryptSyncBlob, isSyncCryptoInitialized } from "./crypto.js";
import { compress, decompress } from "./compress.js";
import { randomUUID } from "node:crypto";

let _cloudClient: Client | null = null;
let _deviceId: string | null = null;
let _initialized = false;

export interface SyncConfig {
  /** Cloud endpoint URL (Turso database or local file for testing) */
  url: string;
  /** Auth token for cloud endpoint (optional for local file URLs) */
  authToken?: string;
  /** Master key for sync encryption (32 bytes) */
  masterKey: Buffer;
}

/**
 * Initialize the sync module.
 * Sets up the cloud client and ensures the sync_blobs table exists remotely.
 */
export async function initSync(config: SyncConfig): Promise<void> {
  // Initialize sync crypto if not already done
  if (!isSyncCryptoInitialized()) {
    initSyncCrypto(config.masterKey);
  }

  // Create cloud client
  const opts: Parameters<typeof createClient>[0] = {
    url: config.url,
  };
  if (config.authToken) {
    opts.authToken = config.authToken;
  }

  _cloudClient = createClient(opts);

  // Ensure cloud schema
  await _cloudClient.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sync_blobs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id  TEXT NOT NULL,
      version    INTEGER NOT NULL,
      blob       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(device_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_blobs_device_version
      ON sync_blobs(device_id, version);
  `);

  // Get or create device ID
  const localClient = getClient();
  const deviceResult = await localClient.execute(
    "SELECT value FROM sync_meta WHERE key = 'device_id'"
  );
  if (deviceResult.rows.length > 0) {
    _deviceId = deviceResult.rows[0]!.value as string;
  } else {
    _deviceId = randomUUID();
    await localClient.execute({
      sql: "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('device_id', ?)",
      args: [_deviceId],
    });
  }

  _initialized = true;
}

/**
 * Push local changes to the cloud.
 * Serializes records with version > last_push_version, compresses, encrypts, uploads.
 * @returns Number of records pushed (0 if nothing to push or sync not initialized).
 */
export async function pushChanges(): Promise<number> {
  if (!_initialized || !_cloudClient || !_deviceId) return 0;

  try {
    const localClient = getClient();

    // Get last push version
    const metaResult = await localClient.execute(
      "SELECT value FROM sync_meta WHERE key = 'last_push_version'"
    );
    const lastPushVersion = metaResult.rows.length > 0
      ? Number(metaResult.rows[0]!.value)
      : 0;

    // Get changed records
    const recordsResult = await localClient.execute({
      sql: `SELECT id, agent_id, agent_role, session_id, timestamp,
                   tool_name, project_name, has_error, raw_text, version
            FROM memories WHERE version > ? ORDER BY version ASC`,
      args: [lastPushVersion],
    });

    if (recordsResult.rows.length === 0) return 0;

    // Serialize to JSON
    const records = recordsResult.rows.map((row) => ({
      id: row.id,
      agent_id: row.agent_id,
      agent_role: row.agent_role,
      session_id: row.session_id,
      timestamp: row.timestamp,
      tool_name: row.tool_name,
      project_name: row.project_name,
      has_error: row.has_error,
      raw_text: row.raw_text,
      version: row.version,
    }));

    const json = JSON.stringify(records);
    const compressed = compress(Buffer.from(json, "utf8"));
    const encrypted = encryptSyncBlob(compressed);

    // Get max version from pushed records
    const maxVersion = Number(records[records.length - 1]!.version);

    // Upload to cloud
    await _cloudClient.execute({
      sql: `INSERT INTO sync_blobs (device_id, version, blob, created_at)
            VALUES (?, ?, ?, ?)`,
      args: [_deviceId, maxVersion, encrypted, new Date().toISOString()],
    });

    // Update last push version
    await localClient.execute({
      sql: "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_push_version', ?)",
      args: [String(maxVersion)],
    });

    return records.length;
  } catch (error) {
    process.stderr.write(
      `[exe-mem] Sync push failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 0;
  }
}

/**
 * Pull changes from the cloud.
 * Downloads blobs newer than last_pull_version, decrypts, decompresses, upserts locally.
 * @returns Number of records pulled (0 if nothing to pull or sync not initialized).
 */
export async function pullChanges(): Promise<number> {
  if (!_initialized || !_cloudClient || !_deviceId) return 0;

  try {
    const localClient = getClient();

    // Get last pull version
    const metaResult = await localClient.execute(
      "SELECT value FROM sync_meta WHERE key = 'last_pull_version'"
    );
    const lastPullVersion = metaResult.rows.length > 0
      ? Number(metaResult.rows[0]!.value)
      : 0;

    // Fetch blobs from other devices
    const blobsResult = await _cloudClient.execute({
      sql: `SELECT id, device_id, version, blob, created_at
            FROM sync_blobs
            WHERE device_id != ? AND version > ?
            ORDER BY version ASC`,
      args: [_deviceId, lastPullVersion],
    });

    if (blobsResult.rows.length === 0) return 0;

    let totalRecords = 0;
    let maxVersion = lastPullVersion;

    for (const blobRow of blobsResult.rows) {
      try {
        const encrypted = blobRow.blob as string;
        const compressed = decryptSyncBlob(encrypted);
        const json = decompress(compressed).toString("utf8");
        const records = JSON.parse(json) as Array<Record<string, unknown>>;

        // Upsert records into local db
        const stmts = records.map((rec) => ({
          sql: `INSERT OR REPLACE INTO memories
                (id, agent_id, agent_role, session_id, timestamp,
                 tool_name, project_name, has_error, raw_text, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            rec.id as string,
            rec.agent_id as string,
            rec.agent_role as string,
            rec.session_id as string,
            rec.timestamp as string,
            rec.tool_name as string,
            rec.project_name as string,
            rec.has_error as number,
            rec.raw_text as string,
            rec.version as number,
          ],
        }));

        if (stmts.length > 0) {
          await localClient.batch(stmts, "write");
        }

        totalRecords += records.length;
        const blobVersion = Number(blobRow.version);
        if (blobVersion > maxVersion) maxVersion = blobVersion;
      } catch (blobError) {
        process.stderr.write(
          `[exe-mem] Sync blob decryption failed: ${blobError instanceof Error ? blobError.message : String(blobError)}\n`
        );
        // Skip this blob, continue with others
        continue;
      }
    }

    // Update last pull version
    if (maxVersion > lastPullVersion) {
      await localClient.execute({
        sql: "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_pull_version', ?)",
        args: [String(maxVersion)],
      });
    }

    return totalRecords;
  } catch (error) {
    process.stderr.write(
      `[exe-mem] Sync pull failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return 0;
  }
}

/**
 * Dispose the sync module: close cloud client.
 */
export async function disposeSync(): Promise<void> {
  if (_cloudClient) {
    _cloudClient.close();
    _cloudClient = null;
  }
  _deviceId = null;
  _initialized = false;
}
