/**
 * Migration from field-encrypted (v1.x) database to SQLCipher (v2.0).
 *
 * Detects the database format and migrates if needed:
 * - "new": no file exists → create fresh SQLCipher DB
 * - "sqlcipher": file exists, can't open without key → already migrated
 * - "field_v1x": file exists, has agent_id_hash column → migrate
 * - "unencrypted": file exists, has hash columns but plaintext values → migrate
 *
 * Migration: read all legacy records → decrypt field-level → create new SQLCipher DB → insert plaintext.
 *
 * @module migration
 */

import { createClient, type Client } from "@libsql/client";
import { existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import crypto from "node:crypto";

// -- Legacy crypto helpers (v1.x compat — private to migration module) ------

const LEGACY_ALGORITHM = "aes-256-gcm";
const LEGACY_IV_LENGTH = 12;
const LEGACY_TAG_LENGTH = 16;
const LEGACY_COMPRESSION_MARKER = 0x01;

function legacyDecrypt(ciphertext: string, key: Buffer): string {
  const combined = Buffer.from(ciphertext, "base64");
  if (combined.length < LEGACY_IV_LENGTH + LEGACY_TAG_LENGTH + 1) {
    throw new Error("Ciphertext too short");
  }
  const iv = combined.subarray(0, LEGACY_IV_LENGTH);
  const tag = combined.subarray(combined.length - LEGACY_TAG_LENGTH);
  const encrypted = combined.subarray(LEGACY_IV_LENGTH, combined.length - LEGACY_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function legacyDecryptRaw(ciphertext: string, key: Buffer): Buffer {
  const combined = Buffer.from(ciphertext, "base64");
  if (combined.length < LEGACY_IV_LENGTH + LEGACY_TAG_LENGTH + 1) {
    throw new Error("Ciphertext too short");
  }
  const iv = combined.subarray(0, LEGACY_IV_LENGTH);
  const tag = combined.subarray(combined.length - LEGACY_TAG_LENGTH);
  const encrypted = combined.subarray(LEGACY_IV_LENGTH, combined.length - LEGACY_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function legacyDecryptRawText(ciphertext: string, key: Buffer): string {
  const rawBytes = legacyDecryptRaw(ciphertext, key);
  if (rawBytes.length > 0 && rawBytes[0] === LEGACY_COMPRESSION_MARKER) {
    // v1.2: marker byte + Brotli compressed
    const { decompress } = require("./compress.js") as { decompress: (b: Buffer) => Buffer };
    return decompress(rawBytes.subarray(1)).toString("utf8");
  }
  // v1.1: plain UTF-8
  return rawBytes.toString("utf8");
}

// -- Public API -------------------------------------------------------------

export type DbFormat = "new" | "sqlcipher" | "field_v1x" | "unencrypted";

/**
 * Detect the encryption format of an existing database.
 */
export async function detectFormat(dbPath: string): Promise<DbFormat> {
  if (!existsSync(dbPath)) {
    return "new";
  }

  // Try opening without encryption key
  let client: Client | null = null;
  try {
    client = createClient({ url: `file:${dbPath}` });
    // If we can query, it's either field_v1x or unencrypted
    const tableInfo = await client.execute("PRAGMA table_info(memories)");
    const columnNames = tableInfo.rows.map((r) => r.name as string);

    if (!columnNames.includes("agent_id_hash")) {
      // No hash columns — could be a new-format db opened without key somehow,
      // or a truly unencrypted db without the old schema
      client.close();
      return "unencrypted";
    }

    // Has hash columns — check if fields are encrypted (base64-like) or plaintext
    const sampleResult = await client.execute("SELECT agent_id FROM memories LIMIT 1");
    if (sampleResult.rows.length > 0) {
      const agentId = sampleResult.rows[0]!.agent_id as string;
      // Base64 encrypted values are typically longer and match base64 pattern
      const isBase64 = /^[A-Za-z0-9+/]{20,}={0,2}$/.test(agentId);
      client.close();
      return isBase64 ? "field_v1x" : "unencrypted";
    }

    // Empty table with hash columns — treat as field_v1x schema
    client.close();
    return "field_v1x";
  } catch {
    // Can't open without key — it's SQLCipher encrypted
    if (client) client.close();
    return "sqlcipher";
  }
}

export interface MigrationResult {
  recordsMigrated: number;
  recordsSkipped: number;
}

/**
 * Migrate a legacy field-encrypted database to SQLCipher format.
 *
 * 1. Open old DB without encryption
 * 2. Read and decrypt all records
 * 3. Create new SQLCipher-encrypted DB
 * 4. Insert plaintext records
 * 5. Verify row counts
 * 6. Swap files (old → .bak, new → original path)
 */
export async function migrateToSqlcipher(
  dbPath: string,
  masterKey: Buffer,
): Promise<MigrationResult> {
  const newDbPath = dbPath + ".new";
  let oldClient: Client | null = null;
  let newClient: Client | null = null;

  try {
    // Step 1: Open old DB
    oldClient = createClient({ url: `file:${dbPath}` });

    // Step 2: Read all records
    const allRows = await oldClient.execute(
      "SELECT id, agent_id, agent_role, session_id, timestamp, tool_name, project_name, has_error, raw_text, vector FROM memories"
    );

    // Step 3: Decrypt records
    const plainRecords: Array<Record<string, unknown>> = [];
    let skipped = 0;

    for (const row of allRows.rows) {
      try {
        const agentId = row.agent_id as string;
        // Detect if fields are encrypted (base64) or plaintext
        const isEncrypted = /^[A-Za-z0-9+/]{20,}={0,2}$/.test(agentId);

        if (isEncrypted) {
          plainRecords.push({
            id: row.id as string,
            agent_id: legacyDecrypt(row.agent_id as string, masterKey),
            agent_role: legacyDecrypt(row.agent_role as string, masterKey),
            session_id: row.session_id as string,
            timestamp: row.timestamp as string,
            tool_name: legacyDecrypt(row.tool_name as string, masterKey),
            project_name: legacyDecrypt(row.project_name as string, masterKey),
            has_error: row.has_error as number,
            raw_text: legacyDecryptRawText(row.raw_text as string, masterKey),
            vector: row.vector,
          });
        } else {
          // Already plaintext (unencrypted db)
          plainRecords.push({
            id: row.id as string,
            agent_id: row.agent_id as string,
            agent_role: row.agent_role as string,
            session_id: row.session_id as string,
            timestamp: row.timestamp as string,
            tool_name: row.tool_name as string,
            project_name: row.project_name as string,
            has_error: row.has_error as number,
            raw_text: row.raw_text as string,
            vector: row.vector,
          });
        }
      } catch (err) {
        process.stderr.write(
          `[exe-mem] Skipped 1 corrupt record during migration: ${err instanceof Error ? err.message : String(err)}\n`
        );
        skipped++;
      }
    }

    oldClient.close();
    oldClient = null;

    // Step 4: Create new SQLCipher DB
    newClient = createClient({
      url: `file:${newDbPath}`,
      encryptionKey: masterKey.toString("hex"),
    });

    // Create schema (without FTS5 triggers for now — they'll be added by ensureSchema later)
    await newClient.executeMultiple(`
      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        agent_role    TEXT NOT NULL,
        session_id    TEXT NOT NULL,
        timestamp     TEXT NOT NULL,
        tool_name     TEXT NOT NULL,
        project_name  TEXT NOT NULL,
        has_error     INTEGER NOT NULL DEFAULT 0,
        raw_text      TEXT NOT NULL,
        vector        F32_BLOB(1024),
        version       INTEGER NOT NULL DEFAULT 0
      );
    `);

    // Step 5: Insert plaintext records
    if (plainRecords.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < plainRecords.length; i += batchSize) {
        const batch = plainRecords.slice(i, i + batchSize);
        const stmts = batch.map((rec, idx) => ({
          sql: `INSERT INTO memories (id, agent_id, agent_role, session_id, timestamp,
                tool_name, project_name, has_error, raw_text, vector, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            rec.vector as string,
            i + idx + 1, // version
          ],
        }));
        await newClient.batch(stmts, "write");
      }
    }

    // Step 6: Verify row counts
    const countResult = await newClient.execute("SELECT COUNT(*) as cnt FROM memories");
    const newCount = Number(countResult.rows[0]!.cnt);
    newClient.close();
    newClient = null;

    if (newCount !== plainRecords.length) {
      // Rollback: delete new DB
      if (existsSync(newDbPath)) await unlink(newDbPath);
      throw new Error(
        `Migration failed: row count mismatch (expected ${plainRecords.length}, got ${newCount}). Original database preserved.`
      );
    }

    // Step 7: Swap files
    await rename(dbPath, dbPath + ".bak");
    await rename(newDbPath, dbPath);

    return {
      recordsMigrated: plainRecords.length,
      recordsSkipped: skipped,
    };
  } catch (error) {
    // Cleanup on failure
    if (oldClient) oldClient.close();
    if (newClient) newClient.close();
    if (existsSync(newDbPath)) {
      try { await unlink(newDbPath); } catch { /* ignore */ }
    }
    throw error;
  }
}
