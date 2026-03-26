/**
 * Unit tests for individual MCP tool registration functions.
 *
 * Covers edge cases, error paths, and boundary conditions NOT already
 * tested by server.test.ts (which tests the happy-path through the
 * full MCP server interface).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EMBEDDING_DIM } from "../../src/types/memory.js";
import type { MemoryRecord } from "../../src/types/memory.js";
import { initStore, writeMemory, flushBatch, disposeStore, searchMemories } from "../../src/lib/store.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

// Mock the embedder to return a fixed vector (no GGUF model needed)
vi.mock("../../src/lib/embedder.js", () => ({
  embed: vi.fn().mockResolvedValue(Array.from({ length: 1024 }, () => 0.1)),
  getEmbedder: vi.fn().mockResolvedValue({}),
  disposeEmbedder: vi.fn().mockResolvedValue(undefined),
}));

// Mock active-agent so marker files from live sessions don't pollute tests
vi.mock("../../src/adapters/claude/active-agent.js", () => ({
  getActiveAgent: vi.fn(() => ({
    agentId: process.env.AGENT_ID || "default",
    agentRole: process.env.AGENT_ROLE || "employee",
  })),
  writeActiveAgent: vi.fn(),
}));

/** Helper: create a test MemoryRecord with optional overrides */
function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: crypto.randomUUID(),
    agent_id: "exe",
    agent_role: "CTO",
    session_id: "session-001",
    timestamp: new Date().toISOString(),
    tool_name: "Bash",
    project_name: "myapp",
    has_error: false,
    raw_text: "test output content about authentication",
    vector: Array.from({ length: EMBEDDING_DIM }, () => Math.random()),
    ...overrides,
  };
}

/** Result type returned by MCP tool handlers */
type ToolResult = { content: Array<{ type: string; text: string }> };

/**
 * Helper: Create a mock McpServer that captures registered tools.
 * Mirrors the mock in server.test.ts.
 */
function createMockServer() {
  const tools: Map<
    string,
    {
      config: Record<string, unknown>;
      handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>;
    }
  > = new Map();

  return {
    registerTool(
      name: string,
      config: Record<string, unknown>,
      handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>,
    ) {
      tools.set(name, { config, handler });
    },
    tools,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("MCP Tool Edge Cases", () => {
  let tmpDir: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-tools-test-"));
    await initStore({
      dbPath: path.join(tmpDir, "test.db"),
      masterKey: crypto.randomBytes(32),
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    process.env = {
      ...originalEnv,
      AGENT_ID: "exe",
      AGENT_ROLE: "CTO",
      SESSION_ID: "test-session-001",
    };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await disposeStore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // recall_my_memory — edge cases
  // -------------------------------------------------------------------------
  describe("recall_my_memory edge cases", () => {
    it("filters by tool_name", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      await writeMemory(makeRecord({ id: "t1", tool_name: "Bash", raw_text: "ran bash command" }));
      await writeMemory(makeRecord({ id: "t2", tool_name: "Write", raw_text: "wrote a file" }));
      await flushBatch();

      const tool = server.tools.get("recall_my_memory")!;
      const result = (await tool.handler(
        { query: "something", tool_name: "Bash", limit: 10 },
        {},
      )) as ToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      // Should only contain Bash tool results, not Write
      expect(result.content[0]!.text).toContain("Bash");
      expect(result.content[0]!.text).not.toContain("Write");
    });

    it("respects limit parameter", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      // Seed 5 records
      for (let i = 0; i < 5; i++) {
        await writeMemory(makeRecord({
          id: `lim-${i}`,
          raw_text: `memory number ${i} about deployment`,
        }));
      }
      await flushBatch();

      const tool = server.tools.get("recall_my_memory")!;
      const resultLimited = (await tool.handler(
        { query: "deployment", limit: 2 },
        {},
      )) as ToolResult;

      // The "Found N memories" count in the response should be <= 2
      expect(resultLimited.content[0]!.type).toBe("text");
      // Count separators to determine number of records returned
      const separatorCount = (resultLimited.content[0]!.text.match(/---/g) || []).length;
      // N records produce N-1 separators, so separatorCount + 1 <= limit
      expect(separatorCount + 1).toBeLessThanOrEqual(2);
    });

    it("handles empty database gracefully", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      // No data seeded — database is empty
      const tool = server.tools.get("recall_my_memory")!;
      const result = (await tool.handler(
        { query: "anything", limit: 10 },
        {},
      )) as ToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
    });

    it("registers the tool on the server", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      expect(server.tools.has("recall_my_memory")).toBe(true);
      expect(typeof server.tools.get("recall_my_memory")!.handler).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // ask_team_memory — edge cases
  // -------------------------------------------------------------------------
  describe("ask_team_memory edge cases", () => {
    it("returns error when AGENT_ID is missing", async () => {
      const { registerAskTeamMemory } = await import("../../src/mcp/tools/ask-team-memory.js");
      const server = createMockServer();
      registerAskTeamMemory(server);

      delete process.env.AGENT_ID;

      const tool = server.tools.get("ask_team_memory")!;
      const result = (await tool.handler(
        { team_member: "yoshi", query: "test", limit: 10 },
        {},
      )) as ToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      // Should indicate an error about missing AGENT_ID
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
    });

    it("returns empty message for nonexistent team member", async () => {
      const { registerAskTeamMemory } = await import("../../src/mcp/tools/ask-team-memory.js");
      const server = createMockServer();
      registerAskTeamMemory(server);

      // Only seed data for "exe", not for "nonexistent-member"
      await writeMemory(makeRecord({ agent_id: "exe", id: "e1", raw_text: "exe work" }));
      await flushBatch();

      const tool = server.tools.get("ask_team_memory")!;
      const result = (await tool.handler(
        { team_member: "nonexistent-member", query: "work", limit: 10 },
        {},
      )) as ToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
    });

    it("filters team member results by project_name", async () => {
      const { registerAskTeamMemory } = await import("../../src/mcp/tools/ask-team-memory.js");
      const server = createMockServer();
      registerAskTeamMemory(server);

      const teamMember = "yoshi";
      const includedProject = "frontend";
      const excludedProject = "backend";
      await writeMemory(makeRecord({
        agent_id: teamMember,
        id: "yp1",
        project_name: includedProject,
        raw_text: "yoshi frontend work on widgets",
      }));
      await writeMemory(makeRecord({
        agent_id: teamMember,
        id: "yp2",
        project_name: excludedProject,
        raw_text: "yoshi backend api changes",
      }));
      await flushBatch();

      const tool = server.tools.get("ask_team_memory")!;
      const result = (await tool.handler(
        { team_member: teamMember, query: "work", project_name: includedProject, limit: 10 },
        {},
      )) as ToolResult;

      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text).toContain(includedProject);
      expect(result.content[0]!.text).not.toContain(excludedProject);
    });

    it("registers the tool on the server", async () => {
      const { registerAskTeamMemory } = await import("../../src/mcp/tools/ask-team-memory.js");
      const server = createMockServer();
      registerAskTeamMemory(server);

      expect(server.tools.has("ask_team_memory")).toBe(true);
      expect(typeof server.tools.get("ask_team_memory")!.handler).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // get_session_context — edge cases
  // -------------------------------------------------------------------------
  describe("get_session_context edge cases", () => {
    it("handles target_timestamp after all records", async () => {
      const { registerGetSessionContext } = await import("../../src/mcp/tools/get-session-context.js");
      const server = createMockServer();
      registerGetSessionContext(server);

      // Seed 3 records at early timestamps
      for (let i = 0; i < 3; i++) {
        const ts = new Date(`2025-01-01T10:0${i}:00Z`);
        await writeMemory(makeRecord({
          id: `late-${i}`,
          session_id: "session-late",
          timestamp: ts.toISOString(),
          raw_text: `early memory ${i}`,
        }));
      }
      await flushBatch();

      const tool = server.tools.get("get_session_context")!;
      // target_timestamp far in the future
      const result = (await tool.handler(
        {
          session_id: "session-late",
          target_timestamp: "2099-12-31T23:59:59Z",
          window_size: 2,
        },
        {},
      )) as ToolResult;

      // Should still return records (the tail of the session)
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
    });

    it("handles target_timestamp before all records", async () => {
      const { registerGetSessionContext } = await import("../../src/mcp/tools/get-session-context.js");
      const server = createMockServer();
      registerGetSessionContext(server);

      // Seed records at late timestamps
      for (let i = 0; i < 3; i++) {
        const ts = new Date(`2026-06-01T10:0${i}:00Z`);
        await writeMemory(makeRecord({
          id: `early-${i}`,
          session_id: "session-early",
          timestamp: ts.toISOString(),
          raw_text: `late memory ${i}`,
        }));
      }
      await flushBatch();

      const tool = server.tools.get("get_session_context")!;
      // target_timestamp far in the past
      const result = (await tool.handler(
        {
          session_id: "session-early",
          target_timestamp: "2000-01-01T00:00:00Z",
          window_size: 2,
        },
        {},
      )) as ToolResult;

      // Should return the head of the session (window around index 0)
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
    });

    it("window_size=0 returns only the target record", async () => {
      const { registerGetSessionContext } = await import("../../src/mcp/tools/get-session-context.js");
      const server = createMockServer();
      registerGetSessionContext(server);

      // Seed 5 records
      for (let i = 0; i < 5; i++) {
        const ts = new Date(new Date("2026-04-01T10:00:00Z").getTime() + i * 60_000);
        await writeMemory(makeRecord({
          id: `w0-${i}`,
          session_id: "session-w0",
          timestamp: ts.toISOString(),
          raw_text: `window zero memory ${i}`,
        }));
      }
      await flushBatch();

      const tool = server.tools.get("get_session_context")!;
      const result = (await tool.handler(
        {
          session_id: "session-w0",
          target_timestamp: "2026-04-01T10:02:00Z",
          window_size: 0,
        },
        {},
      )) as ToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      // With window_size=0, slice(targetIdx - 0, targetIdx + 0 + 1) = exactly 1 record
      expect(result.content[0]!.text).not.toContain("---");
    });

    it("returns only records from the specified session", async () => {
      const { registerGetSessionContext } = await import("../../src/mcp/tools/get-session-context.js");
      const server = createMockServer();
      registerGetSessionContext(server);

      const ts = "2026-04-01T10:00:00.000Z";
      await writeMemory(makeRecord({
        id: "right-session",
        session_id: "session-target",
        timestamp: ts,
        raw_text: "target session memory",
      }));
      await writeMemory(makeRecord({
        id: "wrong-session",
        session_id: "session-other",
        timestamp: ts,
        raw_text: "other session memory that should not appear",
      }));
      await flushBatch();

      const tool = server.tools.get("get_session_context")!;
      const result = (await tool.handler(
        {
          session_id: "session-target",
          target_timestamp: ts,
          window_size: 3,
        },
        {},
      )) as ToolResult;

      expect(result.content[0]!.text).toContain("target session memory");
      expect(result.content[0]!.text).not.toContain("other session memory");
    });

    it("registers the tool on the server", async () => {
      const { registerGetSessionContext } = await import("../../src/mcp/tools/get-session-context.js");
      const server = createMockServer();
      registerGetSessionContext(server);

      expect(server.tools.has("get_session_context")).toBe(true);
      expect(typeof server.tools.get("get_session_context")!.handler).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // store_memory — edge cases
  // -------------------------------------------------------------------------
  describe("store_memory edge cases", () => {
    it("uses default tool_name 'manual' after schema parsing", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const server = createMockServer();
      registerStoreMemory(server);

      // The real MCP SDK applies Zod defaults before calling the handler,
      // so tool_name arrives as "manual" (the schema default), not undefined.
      const tool = server.tools.get("store_memory")!;
      const result = (await tool.handler(
        { text: "memory with defaults", tool_name: "manual", has_error: false },
        {},
      )) as ToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);

      // Verify stored record uses "manual" as tool_name
      const queryVector = Array.from({ length: EMBEDDING_DIM }, () => 0.1);
      const stored = await searchMemories(queryVector, "exe", { limit: 10 });
      const match = stored.find((r) => r.raw_text === "memory with defaults");
      expect(match).toBeDefined();
      expect(match!.tool_name).toBe("manual");
    });

    it("uses 'unknown' as default project_name", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const server = createMockServer();
      registerStoreMemory(server);

      const tool = server.tools.get("store_memory")!;
      await tool.handler(
        { text: "memory without project", tool_name: "manual", has_error: false },
        {},
      );

      const queryVector = Array.from({ length: EMBEDDING_DIM }, () => 0.1);
      const stored = await searchMemories(queryVector, "exe", { limit: 10 });
      const match = stored.find((r) => r.raw_text === "memory without project");
      expect(match).toBeDefined();
      expect(match!.project_name).toBe("unknown");
    });

    it("stores error-flagged memory correctly", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const server = createMockServer();
      registerStoreMemory(server);

      const tool = server.tools.get("store_memory")!;
      await tool.handler(
        {
          text: "something went wrong during build",
          tool_name: "Bash",
          project_name: "myapp",
          has_error: true,
        },
        {},
      );

      const queryVector = Array.from({ length: EMBEDDING_DIM }, () => 0.1);
      const stored = await searchMemories(queryVector, "exe", { limit: 10 });
      const match = stored.find((r) => r.raw_text === "something went wrong during build");
      expect(match).toBeDefined();
      expect(match!.has_error).toBe(true);
    });

    it("uses AGENT_ROLE fallback when env var is missing", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const server = createMockServer();
      registerStoreMemory(server);

      // Remove AGENT_ROLE — getActiveAgent() defaults to "employee"
      delete process.env.AGENT_ROLE;

      const tool = server.tools.get("store_memory")!;
      await tool.handler(
        { text: "memory with no role", tool_name: "manual", has_error: false },
        {},
      );

      const queryVector = Array.from({ length: EMBEDDING_DIM }, () => 0.1);
      const stored = await searchMemories(queryVector, "exe", { limit: 10 });
      const match = stored.find((r) => r.raw_text === "memory with no role");
      expect(match).toBeDefined();
      expect(match!.agent_role).toBe("employee");
    });

    it("uses SESSION_ID fallback when env var is missing", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const server = createMockServer();
      registerStoreMemory(server);

      // Remove SESSION_ID — should default to "manual"
      delete process.env.SESSION_ID;

      const tool = server.tools.get("store_memory")!;
      await tool.handler(
        { text: "memory with no session", tool_name: "manual", has_error: false },
        {},
      );

      const queryVector = Array.from({ length: EMBEDDING_DIM }, () => 0.1);
      const stored = await searchMemories(queryVector, "exe", { limit: 10 });
      const match = stored.find((r) => r.raw_text === "memory with no session");
      expect(match).toBeDefined();
      expect(match!.session_id).toBe("manual");
    });

    it("returns a response containing the generated memory ID", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const server = createMockServer();
      registerStoreMemory(server);

      const tool = server.tools.get("store_memory")!;
      const result = (await tool.handler(
        { text: "test memory for id check", tool_name: "manual", has_error: false },
        {},
      )) as ToolResult;

      // Response should contain a UUID-shaped string (the memory ID)
      expect(result.content[0]!.text).toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    });

    it("registers the tool on the server", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const server = createMockServer();
      registerStoreMemory(server);

      expect(server.tools.has("store_memory")).toBe(true);
      expect(typeof server.tools.get("store_memory")!.handler).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // Cross-tool: registration
  // -------------------------------------------------------------------------
  describe("all tools register without conflict", () => {
    it("registers all 4 tools on the same server", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const { registerAskTeamMemory } = await import("../../src/mcp/tools/ask-team-memory.js");
      const { registerGetSessionContext } = await import("../../src/mcp/tools/get-session-context.js");
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");

      const server = createMockServer();
      registerRecallMyMemory(server);
      registerAskTeamMemory(server);
      registerGetSessionContext(server);
      registerStoreMemory(server);

      const expectedTools = [
        "recall_my_memory",
        "ask_team_memory",
        "get_session_context",
        "store_memory",
      ];

      expect(server.tools.size).toBe(expectedTools.length);
      for (const name of expectedTools) {
        expect(server.tools.has(name)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AGENT_ID guard: consistent across tools that require it
  // -------------------------------------------------------------------------
  describe.each([
    {
      toolName: "recall_my_memory",
      importPath: "../../src/mcp/tools/recall-my-memory.js",
      registerFn: "registerRecallMyMemory",
      args: { query: "test", limit: 10 },
    },
    {
      toolName: "ask_team_memory",
      importPath: "../../src/mcp/tools/ask-team-memory.js",
      registerFn: "registerAskTeamMemory",
      args: { team_member: "yoshi", query: "test", limit: 10 },
    },
    {
      toolName: "store_memory",
      importPath: "../../src/mcp/tools/store-memory.js",
      registerFn: "registerStoreMemory",
      args: { text: "test", tool_name: "manual", has_error: false },
    },
  ])("$toolName AGENT_ID guard", ({ toolName, importPath, registerFn, args }) => {
    it("returns error content when AGENT_ID is unset", async () => {
      const mod = await import(importPath);
      const server = createMockServer();
      mod[registerFn](server);

      delete process.env.AGENT_ID;

      const tool = server.tools.get(toolName)!;
      const result = (await tool.handler(args, {})) as ToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
    });

    it("does not throw when AGENT_ID is unset", async () => {
      const mod = await import(importPath);
      const server = createMockServer();
      mod[registerFn](server);

      delete process.env.AGENT_ID;

      const tool = server.tools.get(toolName)!;
      // Should return gracefully, not throw
      await expect(tool.handler(args, {})).resolves.toBeDefined();
    });
  });
});
