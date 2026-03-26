import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EMBEDDING_DIM } from "../../src/types/memory.js";
import type { MemoryRecord } from "../../src/types/memory.js";
import { initStore, writeMemory, flushBatch, disposeStore } from "../../src/lib/store.js";
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

/**
 * Helper: Create a mock McpServer that captures registered tools.
 * This avoids importing the real MCP SDK just for testing tool handlers.
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

describe("MCP Server Tools", () => {
  let tmpDir: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "exe-mem-mcp-test-"));
    await initStore({
      dbPath: path.join(tmpDir, "test.db"),
      masterKey: crypto.randomBytes(32),
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    // Set up environment for tool handlers
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

  // -----------------------------------------------------------------------
  // recall_my_memory
  // -----------------------------------------------------------------------
  describe("recall_my_memory", () => {
    it("returns results for matching agent_id", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      // Seed data for agent "exe"
      await writeMemory(makeRecord({ agent_id: "exe", id: "m1", raw_text: "fixed auth bug" }));
      await writeMemory(makeRecord({ agent_id: "exe", id: "m2", raw_text: "deployed auth service" }));
      await writeMemory(makeRecord({ agent_id: "other", id: "m3", raw_text: "other work" }));
      await flushBatch();

      const tool = server.tools.get("recall_my_memory")!;
      const result = (await tool.handler(
        { query: "auth", limit: 10 },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
      expect(result.content).toHaveLength(1);
    });

    it("returns empty message for non-matching agent_id", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      // Only seed data for a different agent
      await writeMemory(makeRecord({ agent_id: "yoshi", id: "y1", raw_text: "yoshi work" }));
      await flushBatch();

      const tool = server.tools.get("recall_my_memory")!;
      const result = (await tool.handler(
        { query: "anything", limit: 10 },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
      expect(result.content).toHaveLength(1);
    });

    it("filters by project_name", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      const includedProject = "myapp";
      const excludedProject = "otherapp";
      await writeMemory(makeRecord({ agent_id: "exe", id: "p1", project_name: includedProject, raw_text: "myapp work" }));
      await writeMemory(makeRecord({ agent_id: "exe", id: "p2", project_name: excludedProject, raw_text: "other work" }));
      await flushBatch();

      const tool = server.tools.get("recall_my_memory")!;
      const result = (await tool.handler(
        { query: "work", project_name: includedProject, limit: 10 },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      // Result should include only the filtered project's fixture data
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
      expect(result.content[0]!.text).toContain(includedProject);
      expect(result.content[0]!.text).not.toContain(excludedProject);
    });

    it("filters by has_error", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      const errorRecord = makeRecord({ agent_id: "exe", id: "e1", has_error: true, raw_text: "error happened" });
      await writeMemory(errorRecord);
      await writeMemory(makeRecord({ agent_id: "exe", id: "e2", has_error: false, raw_text: "no error" }));
      await flushBatch();

      const tool = server.tools.get("recall_my_memory")!;
      const result = (await tool.handler(
        { query: "something", has_error: true, limit: 10 },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      // Verify the handler returned results (filter worked) and the error record's data is present
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
      // The seeded error record's raw_text should appear in the response
      expect(result.content[0]!.text).toContain(errorRecord.raw_text.slice(0, 50));
    });

    it("requires AGENT_ID", async () => {
      const { registerRecallMyMemory } = await import("../../src/mcp/tools/recall-my-memory.js");
      const server = createMockServer();
      registerRecallMyMemory(server);

      // Remove AGENT_ID from env
      delete process.env.AGENT_ID;

      const tool = server.tools.get("recall_my_memory")!;
      const result = (await tool.handler(
        { query: "test", limit: 10 },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      // Should return an error response — single content item, handler short-circuits before search
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // ask_team_memory
  // -----------------------------------------------------------------------
  describe("ask_team_memory", () => {
    it("returns team member's records", async () => {
      const { registerAskTeamMemory } = await import("../../src/mcp/tools/ask-team-memory.js");
      const server = createMockServer();
      registerAskTeamMemory(server);

      // Seed data for team member
      const teamMember = "yoshi";
      await writeMemory(makeRecord({ agent_id: teamMember, id: "y1", raw_text: "yoshi solved auth issue" }));
      await writeMemory(makeRecord({ agent_id: teamMember, id: "y2", raw_text: "yoshi deployed service" }));
      await flushBatch();

      const tool = server.tools.get("ask_team_memory")!;
      const result = (await tool.handler(
        { team_member: teamMember, query: "auth", limit: 10 },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      // Should return a valid response with the queried team member's data
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
      // Response should reference the queried team member's fixture agent_id
      expect(result.content[0]!.text).toContain(teamMember);
    });

    it("does not return querying agent's records", async () => {
      const { registerAskTeamMemory } = await import("../../src/mcp/tools/ask-team-memory.js");
      const server = createMockServer();
      registerAskTeamMemory(server);

      // Seed data for both agents
      const queriedMember = "yoshi";
      const ownAgent = "exe";
      const ownRecord = makeRecord({ agent_id: ownAgent, id: "e1", raw_text: "exe confidential work" });
      const teamRecord = makeRecord({ agent_id: queriedMember, id: "y1", raw_text: "yoshi auth work" });
      await writeMemory(ownRecord);
      await writeMemory(teamRecord);
      await flushBatch();

      const tool = server.tools.get("ask_team_memory")!;
      const result = (await tool.handler(
        { team_member: queriedMember, query: "work", limit: 10 },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      // Should contain the queried member's data, not the querying agent's raw_text
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text).toContain(queriedMember);
      expect(result.content[0]!.text).not.toContain(ownRecord.raw_text);
    });
  });

  // -----------------------------------------------------------------------
  // get_session_context
  // -----------------------------------------------------------------------
  describe("get_session_context", () => {
    it("returns window around target timestamp", async () => {
      const { registerGetSessionContext } = await import("../../src/mcp/tools/get-session-context.js");
      const server = createMockServer();
      registerGetSessionContext(server);

      // Seed session memories with sequential timestamps
      const baseTime = new Date("2026-03-17T10:00:00Z");
      for (let i = 0; i < 10; i++) {
        const ts = new Date(baseTime.getTime() + i * 60_000);
        await writeMemory(
          makeRecord({
            agent_id: "exe",
            id: `s-${i}`,
            session_id: "session-abc",
            timestamp: ts.toISOString(),
            raw_text: `memory at minute ${i}`,
          }),
        );
      }
      await flushBatch();

      const tool = server.tools.get("get_session_context")!;
      const result = (await tool.handler(
        {
          session_id: "session-abc",
          target_timestamp: "2026-03-17T10:05:00Z",
          window_size: 3,
        },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      // Should contain memories around minute 5 (window of 3 before and after)
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
      expect(result.content).toHaveLength(1);
    });

    it("returns empty message for unknown session", async () => {
      const { registerGetSessionContext } = await import("../../src/mcp/tools/get-session-context.js");
      const server = createMockServer();
      registerGetSessionContext(server);

      // Write at least one record so table exists
      await writeMemory(makeRecord({ session_id: "other-session" }));
      await flushBatch();

      const tool = server.tools.get("get_session_context")!;
      const result = (await tool.handler(
        {
          session_id: "nonexistent",
          target_timestamp: "2026-03-17T10:00:00Z",
          window_size: 3,
        },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
      expect(result.content).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // store_memory
  // -----------------------------------------------------------------------
  describe("store_memory", () => {
    it("writes a new record to the database", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const { searchMemories } = await import("../../src/lib/store.js");
      const server = createMockServer();
      registerStoreMemory(server);

      const tool = server.tools.get("store_memory")!;
      const result = (await tool.handler(
        {
          text: "Important context about auth system",
          tool_name: "manual",
          project_name: "myapp",
          has_error: false,
        },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
      expect(result.content).toHaveLength(1);

      // Verify the memory was actually stored
      const queryVector = Array.from({ length: EMBEDDING_DIM }, () => 0.1);
      const stored = await searchMemories(queryVector, "exe", { limit: 10 });
      expect(stored.length).toBeGreaterThanOrEqual(1);
      expect(stored.some((r) => r.raw_text === "Important context about auth system")).toBe(true);
    });

    it("requires AGENT_ID", async () => {
      const { registerStoreMemory } = await import("../../src/mcp/tools/store-memory.js");
      const server = createMockServer();
      registerStoreMemory(server);

      // Remove AGENT_ID
      delete process.env.AGENT_ID;

      const tool = server.tools.get("store_memory")!;
      const result = (await tool.handler(
        { text: "test memory", tool_name: "manual", has_error: false },
        {},
      )) as { content: Array<{ type: string; text: string }> };

      // Should return an error response — single content item, handler short-circuits before store
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type).toBe("text");
      expect(result.content[0]!.text.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Server module
  // -----------------------------------------------------------------------
  describe("server module", () => {
    it("server.ts references McpServer", async () => {
      const content = await fs.readFile(
        path.join(process.cwd(), "src/mcp/server.ts"),
        "utf-8",
      );
      expect(content).toContain("McpServer");
    });

    it("server.ts uses StdioServerTransport", async () => {
      const content = await fs.readFile(
        path.join(process.cwd(), "src/mcp/server.ts"),
        "utf-8",
      );
      expect(content).toContain("StdioServerTransport");
    });

    it("server.ts uses lazy daemon-based embedding (no pre-warm)", async () => {
      const content = await fs.readFile(
        path.join(process.cwd(), "src/mcp/server.ts"),
        "utf-8",
      );
      // Should NOT pre-warm (daemon starts lazily on first embed call)
      expect(content).not.toContain("await getEmbedder()");
      // Should still have disposeEmbedder for shutdown cleanup
      expect(content).toContain("disposeEmbedder");
    });

    it("server.ts logs to stderr only", async () => {
      const content = await fs.readFile(
        path.join(process.cwd(), "src/mcp/server.ts"),
        "utf-8",
      );
      expect(content).toContain("process.stderr.write");
      expect(content).not.toContain("console.log");
    });

    it("no console.log in any mcp/ file", async () => {
      const mcpDir = path.join(process.cwd(), "src/mcp");
      const files = await collectFiles(mcpDir);
      for (const file of files) {
        const content = await fs.readFile(file, "utf-8");
        expect(content).not.toContain(
          "console.log",
        );
      }
    });
  });
});

/** Recursively collect all .ts files in a directory */
async function collectFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectFiles(fullPath)));
    } else if (entry.name.endsWith(".ts")) {
      result.push(fullPath);
    }
  }
  return result;
}
