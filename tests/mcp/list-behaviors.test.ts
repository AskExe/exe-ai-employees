/**
 * Tests for src/mcp/tools/list-behaviors.ts — MCP tool registration,
 * agent/domain/project filtering, "all" agents mode.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { initStore, disposeStore } from "../../src/lib/store.js";

// Mock active-agent
vi.mock("../../src/adapters/claude/active-agent.js", () => ({
  getActiveAgent: vi.fn(() => ({
    agentId: process.env.AGENT_ID || "default",
    agentRole: process.env.AGENT_ROLE || "employee",
  })),
  writeActiveAgent: vi.fn(),
}));

type ToolResult = { content: Array<{ type: string; text: string }> };

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

describe("list_behaviors MCP tool", () => {
  let tmpDir: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "list-beh-test-"));
    process.env = {
      ...originalEnv,
      AGENT_ID: "yoshi",
      AGENT_ROLE: "CTO",
    };
    await initStore({
      dbPath: path.join(tmpDir, "test.db"),
      masterKey: crypto.randomBytes(32),
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    // Seed some behaviors
    const { storeBehavior } = await import("../../src/lib/behaviors.js");
    await storeBehavior({ agentId: "yoshi", content: "Always run tests before committing", domain: "workflow", projectName: "exe-os" });
    await storeBehavior({ agentId: "yoshi", content: "Use Epilogue font for headlines", domain: "design" });
    await storeBehavior({ agentId: "mari", content: "Check brand consistency", domain: "design", projectName: "exe-os" });
    await storeBehavior({ agentId: "exe", content: "Never guess — check memory first", domain: "communication" });
  });

  afterEach(async () => {
    await disposeStore();
    process.env = originalEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("registers the list_behaviors tool", async () => {
    const server = createMockServer();
    const { registerListBehaviors } = await import("../../src/mcp/tools/list-behaviors.js");
    registerListBehaviors(server);
    expect(server.tools.has("list_behaviors")).toBe(true);
  });

  it("returns current agent behaviors by default", async () => {
    const server = createMockServer();
    const { registerListBehaviors } = await import("../../src/mcp/tools/list-behaviors.js");
    registerListBehaviors(server);

    const handler = server.tools.get("list_behaviors")!.handler;
    const result = (await handler({ project_name: "exe-os" }, {})) as ToolResult;

    expect(result.content[0]!.text).toContain("yoshi");
    expect(result.content[0]!.text).toContain("Always run tests");
    expect(result.content[0]!.text).toContain("Epilogue font");
    // Should NOT include mari's or exe's behaviors
    expect(result.content[0]!.text).not.toContain("brand consistency");
    expect(result.content[0]!.text).not.toContain("Never guess");
  });

  it("filters by domain", async () => {
    const server = createMockServer();
    const { registerListBehaviors } = await import("../../src/mcp/tools/list-behaviors.js");
    registerListBehaviors(server);

    const handler = server.tools.get("list_behaviors")!.handler;
    const result = (await handler({ domain: "design" }, {})) as ToolResult;

    expect(result.content[0]!.text).toContain("Epilogue font");
    expect(result.content[0]!.text).not.toContain("Always run tests");
  });

  it("shows all agents when agent_id=all", async () => {
    const server = createMockServer();
    const { registerListBehaviors } = await import("../../src/mcp/tools/list-behaviors.js");
    registerListBehaviors(server);

    const handler = server.tools.get("list_behaviors")!.handler;
    const result = (await handler({ agent_id: "all" }, {})) as ToolResult;

    expect(result.content[0]!.text).toContain("yoshi");
    expect(result.content[0]!.text).toContain("mari");
    expect(result.content[0]!.text).toContain("exe");
  });

  it("filters by specific agent_id", async () => {
    const server = createMockServer();
    const { registerListBehaviors } = await import("../../src/mcp/tools/list-behaviors.js");
    registerListBehaviors(server);

    const handler = server.tools.get("list_behaviors")!.handler;
    const result = (await handler({ agent_id: "mari", project_name: "exe-os" }, {})) as ToolResult;

    expect(result.content[0]!.text).toContain("brand consistency");
    expect(result.content[0]!.text).not.toContain("Always run tests");
  });

  it("returns empty message when no behaviors match", async () => {
    const server = createMockServer();
    const { registerListBehaviors } = await import("../../src/mcp/tools/list-behaviors.js");
    registerListBehaviors(server);

    const handler = server.tools.get("list_behaviors")!.handler;
    const result = (await handler({ agent_id: "nobody" }, {})) as ToolResult;

    expect(result.content[0]!.text).toBe("No behaviors found.");
  });

  it("includes behavior IDs for reference", async () => {
    const server = createMockServer();
    const { registerListBehaviors } = await import("../../src/mcp/tools/list-behaviors.js");
    registerListBehaviors(server);

    const handler = server.tools.get("list_behaviors")!.handler;
    const result = (await handler({}, {})) as ToolResult;

    expect(result.content[0]!.text).toContain("ID:");
  });
});
