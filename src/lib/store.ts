/**
 * Local-first libSQL store with batch writes and partitioned queries.
 *
 * SQLCipher encrypts the entire database at rest (page-level).
 * All writes/reads operate on plaintext in RAM — no per-field encryption.
 * Queries filter by agent_id directly (no HMAC hashing needed).
 * Vector similarity via libSQL's vector_distance_cos().
 *
 * @module store
 */

import type { MemoryRecord, MemoryDbRow } from "../types/memory.js";
import { EMBEDDING_DIM } from "../types/memory.js";
import { initTurso, getClient, ensureSchema, disposeTurso } from "./turso.js";
import { getMasterKey } from "./keychain.js";
import { loadConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _pendingRecords: MemoryDbRow[] = [];
let _batchSize = 20;
let _flushIntervalMs = 10_000;
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _flushing = false;
let _nextVersion = 1;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export interface StoreOptions {
  /** Override the SQLite database path (useful for tests) */
  dbPath?: string;
  /** Master key for SQLCipher encryption (32 bytes). If not provided, loaded from keychain. */
  masterKey?: Buffer;
  /** Number of records to buffer before auto-flush (default 20) */
  batchSize?: number;
  /** Milliseconds between timer-based flushes (default 10_000) */
  flushIntervalMs?: number;
}

/**
 * Initialize (or reinitialize) the local store.
 *
 * Sets up libSQL client with SQLCipher encryption and runs schema migrations.
 * Must be called before writeMemory / searchMemories.
 */
export async function initStore(options?: StoreOptions): Promise<void> {
  // Clean up any previous state
  if (_flushTimer !== null) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  _pendingRecords = [];
  _flushing = false;

  _batchSize = options?.batchSize ?? 20;
  _flushIntervalMs = options?.flushIntervalMs ?? 10_000;

  // Determine database path
  let dbPath = options?.dbPath;
  if (!dbPath) {
    const config = await loadConfig();
    dbPath = config.dbPath;
  }

  // Get master key
  let masterKey = options?.masterKey ?? null;
  if (!masterKey) {
    masterKey = await getMasterKey();
    if (!masterKey) {
      throw new Error(
        "No encryption key found. Run /exe:setup to generate one."
      );
    }
  }

  // Initialize libSQL client with SQLCipher encryption
  await initTurso({
    dbPath,
    encryptionKey: masterKey.toString("hex"),
  });
  await ensureSchema();

  // Determine next version from existing data
  const client = getClient();
  const vResult = await client.execute("SELECT MAX(version) as max_v FROM memories");
  _nextVersion = (Number(vResult.rows[0]?.max_v) || 0) + 1;
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

/**
 * Buffer a memory record for batch writing.
 * Records are stored as plaintext — SQLCipher encrypts at the page level.
 */
export async function writeMemory(record: MemoryRecord): Promise<void> {
  if (record.vector !== null && record.vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `Expected ${EMBEDDING_DIM}-dim vector, got ${record.vector.length}`
    );
  }

  const dbRow: MemoryDbRow = {
    id: record.id,
    agent_id: record.agent_id,
    agent_role: record.agent_role,
    session_id: record.session_id,
    timestamp: record.timestamp,
    tool_name: record.tool_name,
    project_name: record.project_name,
    has_error: record.has_error ? 1 : 0,
    raw_text: record.raw_text,
    vector: record.vector,
    version: _nextVersion++,
  };

  _pendingRecords.push(dbRow);

  // Start the straggler timer on first write
  if (_flushTimer === null) {
    _flushTimer = setInterval(() => {
      void flushBatch();
    }, _flushIntervalMs);

    if (_flushTimer && typeof _flushTimer === "object" && "unref" in _flushTimer) {
      _flushTimer.unref();
    }
  }

  if (_pendingRecords.length >= _batchSize) {
    await flushBatch();
  }
}

/**
 * Flush all pending records to libSQL.
 * Uses a batch INSERT OR IGNORE with plaintext values.
 * @returns The number of records flushed.
 */
export async function flushBatch(): Promise<number> {
  if (_flushing || _pendingRecords.length === 0) return 0;

  _flushing = true;
  try {
    const batch = _pendingRecords.splice(0);
    const client = getClient();

    const stmts = batch.map((row) => {
      const hasVector = row.vector !== null;
      return {
        sql: hasVector
          ? `INSERT OR IGNORE INTO memories
              (id, agent_id, agent_role, session_id, timestamp,
               tool_name, project_name,
               has_error, raw_text, vector, version)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, vector32(?), ?)`
          : `INSERT OR IGNORE INTO memories
              (id, agent_id, agent_role, session_id, timestamp,
               tool_name, project_name,
               has_error, raw_text, vector, version)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        args: hasVector
          ? [
              row.id, row.agent_id, row.agent_role, row.session_id,
              row.timestamp, row.tool_name, row.project_name,
              row.has_error, row.raw_text, vectorToBlob(row.vector!), row.version,
            ]
          : [
              row.id, row.agent_id, row.agent_role, row.session_id,
              row.timestamp, row.tool_name, row.project_name,
              row.has_error, row.raw_text, row.version,
            ],
      };
    });

    await client.batch(stmts, "write");

    return batch.length;
  } finally {
    _flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Query path
// ---------------------------------------------------------------------------

export interface SearchOptions {
  projectName?: string;
  hasError?: boolean;
  toolName?: string;
  limit?: number;
  since?: string; // ISO 8601 — filter to memories at or after this timestamp
}

/**
 * Search memories using vector similarity, always filtered by agent_id.
 * All filters applied in SQL — no post-decrypt filtering needed.
 * Returns plaintext MemoryRecord objects.
 */
export async function searchMemories(
  queryVector: number[],
  agentId: string,
  options?: SearchOptions
): Promise<MemoryRecord[]> {
  const client = getClient();
  const limit = options?.limit ?? 10;

  // No degradation check needed — hybridSearch always runs FTS in parallel via RRF,
  // so partial vector results are still useful (they boost FTS matches).

  // Build WHERE clause — all filters on plaintext columns
  let sql = `SELECT id, agent_id, agent_role, session_id, timestamp,
                    tool_name, project_name,
                    has_error, raw_text, vector
             FROM memories
             WHERE agent_id = ?
               AND vector IS NOT NULL`;
  const args: (string | number)[] = [agentId];

  if (options?.projectName) {
    sql += ` AND project_name = ?`;
    args.push(options.projectName);
  }

  if (options?.toolName) {
    sql += ` AND tool_name = ?`;
    args.push(options.toolName);
  }

  if (options?.hasError !== undefined) {
    sql += ` AND has_error = ?`;
    args.push(options.hasError ? 1 : 0);
  }

  if (options?.since) {
    sql += ` AND timestamp >= ?`;
    args.push(options.since);
  }

  sql += ` ORDER BY vector_distance_cos(vector, vector32(?))`;
  args.push(vectorToBlob(queryVector) as unknown as string);

  sql += ` LIMIT ?`;
  args.push(limit);

  const result = await client.execute({ sql, args });

  // Map rows directly to MemoryRecord — no decryption needed
  return result.rows.map((row) => ({
    id: row.id as string,
    agent_id: row.agent_id as string,
    agent_role: row.agent_role as string,
    session_id: row.session_id as string,
    timestamp: row.timestamp as string,
    tool_name: row.tool_name as string,
    project_name: row.project_name as string,
    has_error: (row.has_error as number) === 1,
    raw_text: row.raw_text as string,
    vector: row.vector == null
      ? []
      : Array.isArray(row.vector)
        ? row.vector
        : Array.from(row.vector as unknown as Float32Array),
  }));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Dispose the store: flush pending records, clear timers, release connections.
 */
export async function disposeStore(): Promise<void> {
  if (_flushTimer !== null) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }

  if (_pendingRecords.length > 0) {
    await flushBatch();
  }

  await disposeTurso();
  _pendingRecords = [];
  _nextVersion = 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a number[] or Float32Array to the binary format libSQL expects for F32_BLOB.
 */
export function vectorToBlob(vector: number[] | Float32Array): string {
  const f32 = vector instanceof Float32Array ? vector : new Float32Array(vector);
  return JSON.stringify(Array.from(f32));
}
