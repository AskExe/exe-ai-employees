/**
 * Tests for src/lib/hybrid-search.ts — RRF hybrid search + FTS5.
 *
 * SQLCipher handles encryption transparently; no per-field crypto.
 * hybridSearch runs BOTH vector + FTS, merges with Reciprocal Rank Fusion.
 * lightweightSearch uses FTS5 MATCH queries (not JS keyword matching).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  initStore,
  writeMemory,
  flushBatch,
  disposeStore,
} from "../../src/lib/store.js";
import { hybridSearch, lightweightSearch, rrfMerge } from "../../src/lib/hybrid-search.js";
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
    raw_text: "default test content",
    vector: Array.from({ length: EMBEDDING_DIM }, () => Math.random()),
    ...overrides,
  };
}

describe("hybrid-search.ts — search with SQLCipher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-hybrid-"));
    await initStore({
      dbPath: path.join(tmpDir, "test.db"),
      masterKey: crypto.randomBytes(32),
      batchSize: 100, // high batch size so we control flushes
      flushIntervalMs: 60_000,
    });
  });

  afterEach(async () => {
    await disposeStore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // rrfMerge — unit tests for the merge algorithm
  // -------------------------------------------------------------------------
  describe("rrfMerge", () => {
    it("boosts records appearing in both lists", () => {
      const shared = makeRecord({ id: "shared", raw_text: "shared record" });
      const ftsOnly = makeRecord({ id: "fts-only", raw_text: "fts only" });
      const vecOnly = makeRecord({ id: "vec-only", raw_text: "vec only" });

      // shared is #1 in FTS, #1 in vector → double boosted
      // ftsOnly is #2 in FTS only
      // vecOnly is #2 in vector only
      const result = rrfMerge(
        [shared, ftsOnly],
        [shared, vecOnly],
        10,
      );

      expect(result[0]!.id).toBe("shared");
      // shared score: 1/(60+1) + 1/(60+1) = 2/61 ≈ 0.0328
      // ftsOnly score: 1/(60+2) = 1/62 ≈ 0.0161
      // vecOnly score: 1/(60+2) = 1/62 ≈ 0.0161
      expect(result.length).toBe(3);
    });

    it("respects limit parameter", () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        makeRecord({ id: `rec-${i}` })
      );

      const result = rrfMerge(records, [], 2);
      expect(result.length).toBe(2);
    });

    it("handles empty lists gracefully", () => {
      const records = [makeRecord({ id: "a" }), makeRecord({ id: "b" })];

      expect(rrfMerge([], records, 10).length).toBe(2);
      expect(rrfMerge(records, [], 10).length).toBe(2);
      expect(rrfMerge([], [], 10).length).toBe(0);
    });

    it("ranks higher-positioned items above lower-positioned", () => {
      const first = makeRecord({ id: "first" });
      const second = makeRecord({ id: "second" });
      const third = makeRecord({ id: "third" });

      // Only one list — rank order should be preserved
      const result = rrfMerge([first, second, third], [], 10);
      expect(result[0]!.id).toBe("first");
      expect(result[1]!.id).toBe("second");
      expect(result[2]!.id).toBe("third");
    });
  });

  // -------------------------------------------------------------------------
  // hybridSearch — integration tests
  // -------------------------------------------------------------------------
  describe("hybridSearch", () => {
    it("returns MemoryRecord[] combining FTS and vector results", async () => {
      // Create a known query vector
      const targetVector = Array.from({ length: EMBEDDING_DIM }, (_, i) =>
        Math.sin(i / 100)
      );

      // Record with vector very similar to target AND matching keywords
      const relevant = makeRecord({
        id: "relevant",
        raw_text: "relevant deployment logs showing error",
        vector: targetVector.map((v) => v + Math.random() * 0.001),
      });

      // Record with very different vector but no keyword match
      const irrelevant = makeRecord({
        id: "irrelevant",
        raw_text: "something completely unrelated",
        vector: targetVector.map((v) => -v), // opposite direction
      });

      await writeMemory(relevant);
      await writeMemory(irrelevant);
      await flushBatch();

      // Mock embedder to return our target vector
      vi.doMock("../../src/lib/embedder.js", () => ({
        embed: vi.fn().mockResolvedValue(targetVector),
      }));

      const results = await hybridSearch("deployment errors", "test-agent", {
        limit: 2,
      });

      expect(results.length).toBe(2);
      // "relevant" should be first — it matches both FTS ("deployment") and vector similarity
      expect(results[0]!.id).toBe("relevant");
      expect(results[0]!.raw_text).toBe(
        "relevant deployment logs showing error"
      );
      expect(results[0]!.agent_id).toBe("test-agent");
    });

    it("filters by agent_id (only returns requesting agent's records)", async () => {
      await writeMemory(
        makeRecord({ id: "mine", agent_id: "agent-a", raw_text: "my memory about deployment" })
      );
      await writeMemory(
        makeRecord({
          id: "theirs",
          agent_id: "agent-b",
          raw_text: "their memory about deployment",
        })
      );
      await flushBatch();

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      vi.doMock("../../src/lib/embedder.js", () => ({
        embed: vi.fn().mockResolvedValue(qv),
      }));

      const results = await hybridSearch("memory deployment", "agent-a", { limit: 10 });
      expect(results.every((r) => r.agent_id === "agent-a")).toBe(true);
    });

    it("applies optional project_name filter", async () => {
      await writeMemory(
        makeRecord({
          id: "p1",
          project_name: "alpha",
          raw_text: "alpha work on deployment",
        })
      );
      await writeMemory(
        makeRecord({ id: "p2", project_name: "beta", raw_text: "beta work on deployment" })
      );
      await flushBatch();

      const qv = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      vi.doMock("../../src/lib/embedder.js", () => ({
        embed: vi.fn().mockResolvedValue(qv),
      }));

      const results = await hybridSearch("work deployment", "test-agent", {
        projectName: "alpha",
        limit: 10,
      });
      expect(results.length).toBe(1);
      expect(results[0]!.project_name).toBe("alpha");
    });

    it("falls back to FTS-only when embed daemon unavailable", async () => {
      await writeMemory(
        makeRecord({
          id: "fts-hit",
          raw_text: "critical deployment failure in production",
        })
      );
      await flushBatch();

      // Mock embedder to throw (daemon unavailable)
      vi.doMock("../../src/lib/embedder.js", () => ({
        embed: vi.fn().mockRejectedValue(new Error("daemon down")),
      }));

      const results = await hybridSearch("deployment failure", "test-agent", {
        limit: 5,
      });

      // Should still find the record via FTS
      expect(results.some((r) => r.id === "fts-hit")).toBe(true);
    });

    it("finds records with NULL vectors via FTS in RRF merge", async () => {
      // Record WITH vector
      await writeMemory(
        makeRecord({
          id: "with-vec",
          raw_text: "deployment monitoring dashboard setup",
        })
      );
      // Record WITHOUT vector (simulate backfill stall)
      const nullVecRecord = makeRecord({
        id: "no-vec",
        raw_text: "deployment pipeline configuration yaml",
      });
      await writeMemory(nullVecRecord);
      await flushBatch();

      // NULL out the vector for one record
      const { getClient } = await import("../../src/lib/turso.js");
      await getClient().execute({
        sql: `UPDATE memories SET vector = NULL WHERE id = ?`,
        args: ["no-vec"],
      });

      const targetVector = Array.from({ length: EMBEDDING_DIM }, () => Math.random());
      vi.doMock("../../src/lib/embedder.js", () => ({
        embed: vi.fn().mockResolvedValue(targetVector),
      }));

      const results = await hybridSearch("deployment pipeline", "test-agent", {
        limit: 10,
      });

      // Both should be found — "no-vec" via FTS, "with-vec" via FTS + vector
      expect(results.some((r) => r.id === "no-vec")).toBe(true);
      expect(results.some((r) => r.id === "with-vec")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // lightweightSearch — FTS5 MATCH queries
  // -------------------------------------------------------------------------
  describe("lightweightSearch", () => {
    it("uses FTS5 MATCH to find records by keyword", async () => {
      await writeMemory(
        makeRecord({
          id: "match",
          raw_text: "deployment failed with exit code 1",
          timestamp: "2026-03-19T10:00:00Z",
        })
      );
      await writeMemory(
        makeRecord({
          id: "nomatch",
          raw_text: "everything is fine nothing to see",
          timestamp: "2026-03-19T09:00:00Z",
        })
      );
      await flushBatch();

      const results = await lightweightSearch("deployment failed", "test-agent", {
        limit: 5,
      });

      // Should find the matching record via FTS5
      expect(results.some((r) => r.id === "match")).toBe(true);
      expect(results.find((r) => r.id === "match")?.raw_text).toContain(
        "deployment failed"
      );
    });

    it("filters by agent_id", async () => {
      await writeMemory(
        makeRecord({
          id: "agent-a-rec",
          agent_id: "agent-a",
          raw_text: "deployment logs from agent alpha",
        })
      );
      await writeMemory(
        makeRecord({
          id: "agent-b-rec",
          agent_id: "agent-b",
          raw_text: "deployment logs from agent bravo",
        })
      );
      await flushBatch();

      const results = await lightweightSearch("deployment logs", "agent-a", {
        limit: 10,
      });

      expect(results.length).toBe(1);
      expect(results[0]!.agent_id).toBe("agent-a");
      expect(results[0]!.id).toBe("agent-a-rec");
    });

    it("returns empty array for non-matching terms", async () => {
      await writeMemory(
        makeRecord({
          raw_text: "completely unrelated content xyz123",
        })
      );
      await flushBatch();

      const results = await lightweightSearch(
        "nonexistent_query_abc789",
        "test-agent",
        { limit: 5 }
      );
      expect(results).toEqual([]);
    });

    it("handles commas in query without FTS5 syntax error", async () => {
      await writeMemory(
        makeRecord({
          id: "arch-rec",
          raw_text: "architecture decisions and deployment tasks completed",
        })
      );
      await flushBatch();

      // This exact pattern caused "fts5: syntax error near ','" before the fix
      const results = await lightweightSearch(
        "recent work, architecture decisions, tasks completed",
        "test-agent",
        { limit: 5 }
      );

      // Should not throw — and should find the matching record
      expect(results.some((r) => r.id === "arch-rec")).toBe(true);
    });

    it("handles FTS5 special characters in query", async () => {
      await writeMemory(
        makeRecord({
          id: "special-rec",
          raw_text: "debugging session with error stack trace",
        })
      );
      await flushBatch();

      // Parens, colons, plus, asterisk — all FTS5 syntax chars
      const results = await lightweightSearch(
        'debugging (session): error + "stack"',
        "test-agent",
        { limit: 5 }
      );

      expect(results.some((r) => r.id === "special-rec")).toBe(true);
    });

    it("handles null vector in returned rows without throwing", async () => {
      // Write a record, then NULL out its vector directly via SQL
      const rec = makeRecord({
        id: "null-vec",
        raw_text: "record with null vector for testing",
      });
      await writeMemory(rec);
      await flushBatch();

      const { getClient } = await import("../../src/lib/turso.js");
      await getClient().execute({
        sql: `UPDATE memories SET vector = NULL WHERE id = ?`,
        args: ["null-vec"],
      });

      const results = await lightweightSearch(
        "record null vector testing",
        "test-agent",
        { limit: 5 }
      );

      // Should return the record with an empty array for vector, not throw
      const match = results.find((r) => r.id === "null-vec");
      expect(match).toBeDefined();
      expect(match!.vector).toEqual([]);
    });

    it("falls back to recent records when query has no meaningful terms", async () => {
      // Insert records with known timestamps
      await writeMemory(
        makeRecord({
          id: "recent",
          raw_text: "recent work on the api",
          timestamp: "2026-03-19T12:00:00Z",
        })
      );
      await writeMemory(
        makeRecord({
          id: "older",
          raw_text: "older task completed",
          timestamp: "2026-03-01T12:00:00Z",
        })
      );
      await flushBatch();

      // Query with only short/meaningless terms (< 3 chars) triggers fallback
      const results = await lightweightSearch("a b", "test-agent", {
        limit: 5,
      });

      // Should get recent records ordered by timestamp DESC
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.id).toBe("recent");
    });
  });
});
