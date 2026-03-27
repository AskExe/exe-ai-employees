/**
 * libSQL database client with SQLCipher encryption.
 *
 * Local-only mode: SQLCipher-encrypted SQLite at dbPath.
 * Sync is handled separately by the sync module (E2EE blob sync).
 *
 * @module turso
 */

import { createClient, type Client } from "@libsql/client";

let _client: Client | null = null;

export interface TursoInitConfig {
  /** Local database file path */
  dbPath: string;
  /** SQLCipher encryption key (hex-encoded 32-byte master key) */
  encryptionKey?: string;
}

/**
 * Initialize the libSQL client with optional SQLCipher encryption.
 */
export async function initTurso(config: TursoInitConfig): Promise<void> {
  if (_client) {
    _client.close();
    _client = null;
  }

  const opts: Parameters<typeof createClient>[0] = {
    url: `file:${config.dbPath}`,
  };

  if (config.encryptionKey) {
    opts.encryptionKey = config.encryptionKey;
  }

  _client = createClient(opts);
}

/**
 * Check whether the libSQL client has been initialized.
 */
export function isInitialized(): boolean {
  return _client !== null;
}

/**
 * Get the initialized libSQL client. Throws if not initialized.
 */
export function getClient(): Client {
  if (!_client) {
    throw new Error("Turso client not initialized. Call initTurso() first.");
  }
  return _client;
}

/**
 * Run schema migrations — creates the memories table, indexes, FTS5 table, and sync_meta.
 * Idempotent (safe to call multiple times).
 */
export async function ensureSchema(): Promise<void> {
  const client = getClient();

  // Enable WAL mode + busy timeout for multi-agent concurrent access.
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("PRAGMA busy_timeout = 5000");

  // Main memories table — plaintext columns (SQLCipher encrypts at page level)
  await client.executeMultiple(`
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

    CREATE INDEX IF NOT EXISTS idx_memories_agent
      ON memories(agent_id);

    CREATE INDEX IF NOT EXISTS idx_memories_timestamp
      ON memories(timestamp);

    CREATE INDEX IF NOT EXISTS idx_memories_session
      ON memories(session_id);

    CREATE INDEX IF NOT EXISTS idx_memories_project
      ON memories(project_name);

    CREATE INDEX IF NOT EXISTS idx_memories_tool
      ON memories(tool_name);

    CREATE INDEX IF NOT EXISTS idx_memories_version
      ON memories(version);

    CREATE INDEX IF NOT EXISTS idx_memories_agent_project
      ON memories(agent_id, project_name);
  `);

  // FTS5 virtual table for full-text search on raw_text
  await client.executeMultiple(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      raw_text,
      content='memories',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, raw_text) VALUES (new.rowid, new.raw_text);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, raw_text) VALUES('delete', old.rowid, old.raw_text);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, raw_text) VALUES('delete', old.rowid, old.raw_text);
      INSERT INTO memories_fts(rowid, raw_text) VALUES (new.rowid, new.raw_text);
    END;
  `);

  // Behaviors table — persistent per-agent patterns and corrections
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS behaviors (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      project_name  TEXT,
      domain        TEXT,
      content       TEXT NOT NULL,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_behaviors_agent
      ON behaviors(agent_id);

    CREATE INDEX IF NOT EXISTS idx_behaviors_agent_active
      ON behaviors(agent_id, active);
  `);

  // Tasks table — bare-bones task tracking
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      assigned_to TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_assignee
      ON tasks(assigned_to);

    CREATE INDEX IF NOT EXISTS idx_tasks_status
      ON tasks(status);
  `);

  // Messages table — local inter-agent message queue
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      from_agent      TEXT NOT NULL,
      target_agent    TEXT NOT NULL,
      target_project  TEXT,
      content         TEXT NOT NULL,
      priority        TEXT NOT NULL DEFAULT 'normal',
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL,
      delivered_at    TEXT,
      processed_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_target
      ON messages(target_agent, status);

    CREATE INDEX IF NOT EXISTS idx_messages_status
      ON messages(status);
  `);

  // Sync metadata table
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Close the client and release resources.
 */
export async function disposeTurso(): Promise<void> {
  if (_client) {
    _client.close();
    _client = null;
  }
}
