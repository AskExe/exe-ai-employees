/**
 * Tests for embedding reliability: NULL vector handling, search degradation,
 * backfill job, and writeMemory with null vectors.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initStore, writeMemory, flushBatch, searchMemories, disposeStore, vectorToBlob } from "../../src/lib/store.js";
import { getClient } from "../../src/lib/turso.js";
import crypto from "node:crypto";
import { EMBEDDING_DIM } from "../../src/types/memory.js";
import path from "node:path";
import os from "node:os";
import { mkdirSync, rmSync } from "node:fs";

const TEST_DB = path.join(os.tmpdir(), `embed-reliability-test-${Date.now()}.db`);
const TEST_KEY = Buffer.alloc(32, 0xab);

function makeVector(): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i * 0.1));
}

function makeId(): string {
  return crypto.randomUUID();
}

beforeAll(async () => {
  await initStore({ dbPath: TEST_DB, masterKey: TEST_KEY });
});

afterAll(async () => {
  await disposeStore();
  try { rmSync(TEST_DB); } catch { /* ignore */ }
  try { rmSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { rmSync(TEST_DB + "-shm"); } catch { /* ignore */ }
});

describe("writeMemory with null vectors", () => {
  it("accepts null vector and writes to DB", async () => {
    const id = makeId();
    await writeMemory({
      id,
      agent_id: "test-agent",
      agent_role: "CTO",
      session_id: "test-session",
      timestamp: new Date().toISOString(),
      tool_name: "Bash",
      project_name: "test-project",
      has_error: false,
      raw_text: "null vector test memory",
      vector: null,
    });
    await flushBatch();

    const client = getClient();
    const result = await client.execute({
      sql: "SELECT id, vector FROM memories WHERE id = ?",
      args: [id],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.vector).toBeNull();
  });

  it("accepts valid vector and writes to DB", async () => {
    const id = makeId();
    const vector = makeVector();
    await writeMemory({
      id,
      agent_id: "test-agent",
      agent_role: "CTO",
      session_id: "test-session",
      timestamp: new Date().toISOString(),
      tool_name: "Write",
      project_name: "test-project",
      has_error: false,
      raw_text: "valid vector test memory",
      vector,
    });
    await flushBatch();

    const client = getClient();
    const result = await client.execute({
      sql: "SELECT id, vector FROM memories WHERE id = ?",
      args: [id],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.vector).not.toBeNull();
  });

  it("rejects wrong-dimension vector", async () => {
    await expect(
      writeMemory({
        id: makeId(),
        agent_id: "test-agent",
        agent_role: "CTO",
        session_id: "test-session",
        timestamp: new Date().toISOString(),
        tool_name: "Bash",
        project_name: "test-project",
        has_error: false,
        raw_text: "bad vector",
        vector: [1, 2, 3],
      }),
    ).rejects.toThrow(/Expected 1024-dim vector/);
  });
});

describe("search with NULL vectors", () => {
  const agentId = "search-test-agent";

  beforeAll(async () => {
    // Write some memories with vectors and some without
    for (let i = 0; i < 5; i++) {
      await writeMemory({
        id: makeId(),
        agent_id: agentId,
        agent_role: "CTO",
        session_id: "s1",
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        tool_name: "Bash",
        project_name: "test-project",
        has_error: false,
        raw_text: `memory with vector number ${i} about embedding search`,
        vector: makeVector(),
      });
    }
    for (let i = 0; i < 3; i++) {
      await writeMemory({
        id: makeId(),
        agent_id: agentId,
        agent_role: "CTO",
        session_id: "s1",
        timestamp: new Date(Date.now() - (i + 5) * 1000).toISOString(),
        tool_name: "Write",
        project_name: "test-project",
        has_error: false,
        raw_text: `null vector memory number ${i} about embedding search`,
        vector: null,
      });
    }
    await flushBatch();
  });

  it("vector search excludes NULL vector rows (no crash)", async () => {
    const queryVector = makeVector();
    const results = await searchMemories(queryVector, agentId, { limit: 10 });

    // Should return results (small dataset, no degradation trigger)
    expect(results.length).toBeGreaterThan(0);

    // None of the results should have null vectors
    for (const r of results) {
      expect(r.vector).not.toBeNull();
    }
  });

  it("vector search does not return more results than available vectored memories", async () => {
    const queryVector = makeVector();
    const results = await searchMemories(queryVector, agentId, { limit: 100 });

    // We wrote 5 with vectors — should get at most 5
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

describe("search degradation with mostly NULL vectors", () => {
  const agentId = "degraded-search-agent";

  beforeAll(async () => {
    // Write 25 memories with NULL vectors and only 5 with real vectors
    for (let i = 0; i < 25; i++) {
      await writeMemory({
        id: makeId(),
        agent_id: agentId,
        agent_role: "CTO",
        session_id: "s1",
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        tool_name: "Bash",
        project_name: "test-project",
        has_error: false,
        raw_text: `null vector degraded memory ${i}`,
        vector: null,
      });
    }
    for (let i = 0; i < 5; i++) {
      await writeMemory({
        id: makeId(),
        agent_id: agentId,
        agent_role: "CTO",
        session_id: "s1",
        timestamp: new Date(Date.now() - (i + 25) * 1000).toISOString(),
        tool_name: "Bash",
        project_name: "test-project",
        has_error: false,
        raw_text: `vectored degraded memory ${i}`,
        vector: makeVector(),
      });
    }
    await flushBatch();
  });

  it("returns available vectored results even when most records lack vectors (RRF handles merging)", async () => {
    const queryVector = makeVector();
    const results = await searchMemories(queryVector, agentId, { limit: 10 });

    // With RRF, searchMemories returns whatever vectors exist — hybridSearch
    // merges them with FTS results. No degradation gate needed.
    expect(results).toHaveLength(5); // the 5 vectored memories
  });
});

describe("vectorToBlob", () => {
  it("converts number array to JSON string", () => {
    const vec = [1.0, 2.0, 3.0];
    const blob = vectorToBlob(vec);
    expect(typeof blob).toBe("string");
    const parsed = JSON.parse(blob);
    expect(parsed).toHaveLength(3);
  });

  it("converts Float32Array to JSON string", () => {
    const vec = new Float32Array([1.0, 2.0, 3.0]);
    const blob = vectorToBlob(vec);
    const parsed = JSON.parse(blob);
    expect(parsed).toHaveLength(3);
  });
});
