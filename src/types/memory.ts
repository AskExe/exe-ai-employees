/**
 * Memory record — plaintext representation used by all callers.
 * Schema: id, agent_id, agent_role, session_id, timestamp,
 * tool_name, project_name, has_error, raw_text, vector(1024).
 */
export interface MemoryRecord {
  /** UUID v4 unique identifier */
  id: string;
  /** Employee identifier, e.g. "yoshi", "exe", "gen" */
  agent_id: string;
  /** Employee role, e.g. "CTO", "COO" */
  agent_role: string;
  /** Claude Code session identifier */
  session_id: string;
  /** ISO 8601 timestamp of when the memory was created */
  timestamp: string;
  /** Tool that produced this memory: "Bash", "Write", "Read", etc. */
  tool_name: string;
  /** Project directory name where the tool was called */
  project_name: string;
  /** True if tool output contained error patterns */
  has_error: boolean;
  /** Serialized tool output text */
  raw_text: string;
  /** Float32 embedding vector, exactly 1024 dimensions (Jina v5-small Q4_K_M). Null if embedding failed (pending backfill). */
  vector: number[] | null;
  /** Optional task ID — links this memory to the task being worked on when created. */
  task_id?: string | null;
}

/**
 * Database row format — plaintext columns (SQLCipher encrypts the page).
 * Replaces EncryptedMemoryRow from v1.x (no more per-field encryption).
 */
export interface MemoryDbRow {
  id: string;
  agent_id: string;
  agent_role: string;
  session_id: string;
  timestamp: string;
  tool_name: string;
  project_name: string;
  has_error: number;                 // 0 or 1 (SQLite INTEGER)
  raw_text: string;
  vector: number[] | Float32Array | null;
  version: number;                   // monotonic sync version
  task_id?: string | null;           // trajectory forward-compat
}

/**
 * Encrypted sync blob stored in the cloud (zero-knowledge).
 */
export interface SyncBlob {
  deviceId: string;
  version: number;
  blob: string;        // base64(AES-256-GCM(Brotli(JSON)))
  createdAt: string;   // ISO 8601
}

/** Expected embedding dimension for Jina v5-small */
export const EMBEDDING_DIM = 1024;

/** Fields required on every MemoryRecord (used for validation) */
export const MEMORY_RECORD_FIELDS = [
  "id", "agent_id", "agent_role", "session_id", "timestamp",
  "tool_name", "project_name", "has_error", "raw_text", "vector",
] as const;
