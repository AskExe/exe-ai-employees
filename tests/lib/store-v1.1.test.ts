/**
 * Tests for src/lib/store.ts — plaintext libSQL store with SQLCipher encryption
 *
 * SQLCipher encrypts the entire database at rest (page-level).
 * All writes/reads operate on plaintext in RAM — no per-field encryption.
 * Queries filter by agent_id, project_name, tool_name directly in SQL.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  initStore,
  writeMemory,
  flushBatch,
  searchMemories,
  disposeStore,
} from "../../src/lib/store.js";
import type { MemoryRecord } from "../../src/types/memory.js";
import { EMBEDDING_DIM } from "../../src/types/memory.js";

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: crypto.randomUUID(),
    agent_id: "test-agent",
    agent_role: "tester",
    session_id: "session-001",
    timestamp: new Date().toISOString(),
    tool_name: "Bash",
    project_name: "test-project",
    has_error: false,
    raw_text: "test output content for store testing",
    vector: Array.from({ length: EMBEDDING_DIM }, () => Math.random()),
    ...overrides,
  };
}

describe("store.ts — plaintext libSQL store with SQLCipher", () => {
  let tmpDir: string;
  const masterKey = crypto.randomBytes(32);

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-store-"));
    await initStore({
      dbPath: path.join(tmpDir, "test.db"),
      masterKey,
      batchSize: 3,
      flushIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    await disposeStore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("writeMemory — plaintext inserts", () => {
    test("inserts a record that can be retrieved", async () => {
      const record = makeRecord({
        raw_text: "plaintext memory content",
        project_name: "my-project",
        tool_name: "Write",
      });
      await writeMemory(record);
      await flushBatch();

      const results = await searchMemories(record.vector, record.agent_id, {
        limit: 1,
      });
      expect(results.length).toBe(1);
      expect(results[0]!.raw_text).toBe("plaintext memory content");
      expect(results[0]!.project_name).toBe("my-project");
      expect(results[0]!.tool_name).toBe("Write");
    });

    test("round-trips all fields correctly", async () => {
      const record = makeRecord();
      await writeMemory(record);
      await flushBatch();

      const results = await searchMemories(record.vector, record.agent_id, {
        limit: 1,
      });
      expect(results.length).toBe(1);

      const result = results[0]!;
      expect(result.id).toBe(record.id);
      expect(result.agent_id).toBe(record.agent_id);
      expect(result.agent_role).toBe(record.agent_role);
      expect(result.session_id).toBe(record.session_id);
      expect(result.tool_name).toBe(record.tool_name);
      expect(result.project_name).toBe(record.project_name);
      expect(result.has_error).toBe(record.has_error);
      expect(result.raw_text).toBe(record.raw_text);
    });
  });

  describe("flushBatch — batch inserts", () => {
    test("auto-flushes when batchSize reached", async () => {
      // batchSize is 3, write 3 records
      await writeMemory(makeRecord({ id: "r1" }));
      await writeMemory(makeRecord({ id: "r2" }));
      await writeMemory(makeRecord({ id: "r3" })); // triggers auto-flush

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "test-agent", { limit: 10 });
      expect(results.length).toBe(3);
    });

    test("manual flushBatch writes buffered records", async () => {
      await writeMemory(makeRecord({ id: "r1" }));
      await writeMemory(makeRecord({ id: "r2" }));
      // Only 2 records, below batchSize of 3

      const flushed = await flushBatch();
      expect(flushed).toBe(2);

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "test-agent", { limit: 10 });
      expect(results.length).toBe(2);
    });

    test("flushBatch returns 0 when buffer empty", async () => {
      const flushed = await flushBatch();
      expect(flushed).toBe(0);
    });
  });

  describe("searchMemories — vector + agentId", () => {
    test("returns results ordered by cosine distance", async () => {
      const qv = Array.from({ length: EMBEDDING_DIM }, () => 0.5);

      const similar = makeRecord({
        id: "similar",
        raw_text: "similar record",
        vector: qv.map((v) => v + Math.random() * 0.01), // very close
      });
      const different = makeRecord({
        id: "different",
        raw_text: "different record",
        vector: Array.from({ length: EMBEDDING_DIM }, () => -0.5), // opposite direction
      });

      await writeMemory(similar);
      await writeMemory(different);
      await flushBatch();

      const results = await searchMemories(qv, "test-agent", { limit: 2 });
      expect(results.length).toBe(2);
      expect(results[0]!.id).toBe("similar");
    });

    test("filters by agent_id", async () => {
      await writeMemory(makeRecord({ agent_id: "agent-a", id: "a1" }));
      await writeMemory(makeRecord({ agent_id: "agent-b", id: "b1" }));
      await flushBatch();

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "agent-a", { limit: 10 });

      expect(results.length).toBe(1);
      expect(results[0]!.agent_id).toBe("agent-a");
    });

    test("respects limit parameter", async () => {
      for (let i = 0; i < 5; i++) {
        await writeMemory(makeRecord({ id: `r${i}` }));
      }
      await flushBatch();

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "test-agent", { limit: 3 });
      expect(results.length).toBe(3);
    });

    test("returns empty array when no records match", async () => {
      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "nonexistent-agent", {
        limit: 10,
      });
      expect(results).toEqual([]);
    });
  });

  describe("searchMemories — SQL filters", () => {
    test("filters by projectName in SQL", async () => {
      await writeMemory(makeRecord({ id: "p1", project_name: "project-a" }));
      await writeMemory(makeRecord({ id: "p2", project_name: "project-b" }));
      await flushBatch();

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "test-agent", {
        projectName: "project-a",
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0]!.project_name).toBe("project-a");
    });

    test("filters by toolName in SQL", async () => {
      await writeMemory(makeRecord({ id: "t1", tool_name: "Bash" }));
      await writeMemory(makeRecord({ id: "t2", tool_name: "Write" }));
      await flushBatch();

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "test-agent", {
        toolName: "Write",
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0]!.tool_name).toBe("Write");
    });

    test("filters by hasError in SQL", async () => {
      await writeMemory(makeRecord({ id: "err", has_error: true }));
      await writeMemory(makeRecord({ id: "ok", has_error: false }));
      await flushBatch();

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "test-agent", {
        hasError: true,
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0]!.has_error).toBe(true);
    });

    test("combines multiple filters", async () => {
      await writeMemory(
        makeRecord({
          id: "match",
          project_name: "proj-x",
          tool_name: "Bash",
          has_error: true,
        })
      );
      await writeMemory(
        makeRecord({
          id: "wrong-project",
          project_name: "proj-y",
          tool_name: "Bash",
          has_error: true,
        })
      );
      await writeMemory(
        makeRecord({
          id: "wrong-tool",
          project_name: "proj-x",
          tool_name: "Write",
          has_error: true,
        })
      );
      await flushBatch();

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "test-agent", {
        projectName: "proj-x",
        toolName: "Bash",
        hasError: true,
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0]!.id).toBe("match");
    });
  });

  describe("disposeStore — flushes and closes", () => {
    test("flushes pending records on dispose", async () => {
      await writeMemory(makeRecord({ id: "pending-1" }));
      await writeMemory(makeRecord({ id: "pending-2" }));
      // Do NOT call flushBatch — disposeStore should flush

      await disposeStore();

      // Re-init to verify the records were flushed to disk
      await initStore({
        dbPath: path.join(tmpDir, "test.db"),
        masterKey,
        batchSize: 3,
        flushIntervalMs: 60_000,
      });

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      const results = await searchMemories(qv, "test-agent", { limit: 10 });
      expect(results.length).toBe(2);
    });

    test("safe to call multiple times", async () => {
      await disposeStore();
      await expect(disposeStore()).resolves.not.toThrow();
    });
  });
});
