import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryRecord } from "../../src/types/memory.js";
import type { SessionStartPayload } from "../../src/types/hook-payload.js";

// --------------------------------------------------------------------------
// Mock config: configurable autoRetrieval + hookSearchMode
// --------------------------------------------------------------------------
let mockAutoRetrieval = true;
let mockHookSearchMode: "fts" | "hybrid" = "fts";

vi.mock("../../src/lib/config.js", () => ({
  loadConfigSync: vi.fn(() => ({ autoRetrieval: mockAutoRetrieval })),
  loadConfig: vi.fn(async () => ({
    autoRetrieval: mockAutoRetrieval,
    hookSearchMode: mockHookSearchMode,
  })),
}));

// --------------------------------------------------------------------------
// Mock store
// --------------------------------------------------------------------------
vi.mock("../../src/lib/store.js", () => ({
  initStore: vi.fn().mockResolvedValue(undefined),
  disposeStore: vi.fn(),
}));

// --------------------------------------------------------------------------
// Mock hybrid-search: configurable search results
// --------------------------------------------------------------------------
let mockSearchResults: MemoryRecord[] = [];

vi.mock("../../src/lib/hybrid-search.js", () => ({
  lightweightSearch: vi.fn(async () => mockSearchResults),
  hybridSearch: vi.fn(async () => mockSearchResults),
}));

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
const ZERO_VECTOR = new Array(1024).fill(0) as number[];

function makeMemoryRecord(
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id: "mem-001",
    agent_id: "test-agent",
    agent_role: "engineer",
    session_id: "session-001",
    timestamp: "2026-03-17T08:00:00Z",
    tool_name: "Bash",
    project_name: "my-project",
    has_error: false,
    raw_text: "Tool: Bash\nInput: npm test\nOutput: All tests passed successfully",
    vector: ZERO_VECTOR,
    ...overrides,
  };
}

function makeSessionStartPayload(
  overrides: Partial<SessionStartPayload> = {},
): SessionStartPayload {
  return {
    session_id: "session-001",
    cwd: "/Users/test/my-project",
    hook_event_name: "SessionStart",
    source: "startup",
    model: "claude-sonnet-4-20250514",
    ...overrides,
  };
}

/**
 * Simulates the session-start hook logic.
 *
 * The actual hook (src/hooks/session-start.ts) is a standalone script
 * reading from stdin. We replicate its pipeline here with mocked deps.
 */
async function runSessionStartLogic(
  payload: SessionStartPayload,
): Promise<string | null> {
  const agentId = process.env.AGENT_ID;
  if (!agentId) return null;

  const { loadConfigSync } = await import("../../src/lib/config.js");
  if (!loadConfigSync().autoRetrieval) return null;

  const path = await import("node:path");
  const { initStore } = await import("../../src/lib/store.js");
  const { loadConfig } = await import("../../src/lib/config.js");
  const { lightweightSearch, hybridSearch } = await import(
    "../../src/lib/hybrid-search.js"
  );

  const projectName = path.basename(payload.cwd ?? "");
  await initStore();

  const config = await loadConfig();
  const search =
    config.hookSearchMode === "hybrid" ? hybridSearch : lightweightSearch;

  const memories = await search(`recent work on ${projectName}`, agentId, {
    projectName,
    limit: 5,
  });

  let additionalContext = "";

  if (memories.length > 0) {
    const brief = memories
      .map(
        (m) =>
          `[${m.timestamp}] ${m.tool_name}: ${m.raw_text.slice(0, 200)}`,
      )
      .join("\n");
    additionalContext = `## Memory Brief\nRecent memories from this project:\n${brief}`;
  }

  if (additionalContext.length > 0) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    });
  }

  return null;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------
describe("session-start hook", () => {
  beforeEach(() => {
    mockSearchResults = [];
    mockAutoRetrieval = true;
    mockHookSearchMode = "fts";
    vi.clearAllMocks();
    process.env.AGENT_ID = "test-agent";
  });

  it("exits early when AGENT_ID is not set", async () => {
    delete process.env.AGENT_ID;

    const output = await runSessionStartLogic(makeSessionStartPayload());

    expect(output).toBeNull();

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(lightweightSearch).not.toHaveBeenCalled();
  });

  it("exits early when autoRetrieval is disabled", async () => {
    mockAutoRetrieval = false;

    const output = await runSessionStartLogic(makeSessionStartPayload());

    expect(output).toBeNull();

    const { initStore } = await import("../../src/lib/store.js");
    expect(initStore).not.toHaveBeenCalled();
  });

  it("produces additionalContext when memories exist", async () => {
    mockSearchResults = [
      makeMemoryRecord({ id: "mem-001", tool_name: "Bash" }),
      makeMemoryRecord({
        id: "mem-002",
        tool_name: "Write",
        timestamp: "2026-03-17T08:05:00Z",
      }),
    ];

    const output = await runSessionStartLogic(makeSessionStartPayload());

    expect(output).not.toBeNull();
    const parsed = JSON.parse(output!);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(
      parsed.hookSpecificOutput.additionalContext.length,
    ).toBeGreaterThan(0);
  });

  it("handles empty memory results gracefully", async () => {
    mockSearchResults = [];

    const output = await runSessionStartLogic(makeSessionStartPayload());

    expect(output).toBeNull();
  });

  it("passes projectName from cwd to search", async () => {
    mockSearchResults = [];

    const payload = makeSessionStartPayload({
      cwd: "/Users/test/my-cool-project",
    });
    await runSessionStartLogic(payload);

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(lightweightSearch).toHaveBeenCalledWith(
      expect.stringContaining("my-cool-project"),
      "test-agent",
      expect.objectContaining({ projectName: "my-cool-project", limit: 5 }),
    );
  });

  it("uses hybridSearch when hookSearchMode is hybrid", async () => {
    mockHookSearchMode = "hybrid";
    mockSearchResults = [];

    await runSessionStartLogic(makeSessionStartPayload());

    const { hybridSearch, lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(hybridSearch).toHaveBeenCalled();
    expect(lightweightSearch).not.toHaveBeenCalled();
  });

  it("uses additionalContext for silent injection", async () => {
    mockSearchResults = [makeMemoryRecord()];

    const output = await runSessionStartLogic(makeSessionStartPayload());

    expect(output).not.toBeNull();
    const parsed = JSON.parse(output!);
    expect(parsed).toHaveProperty("hookSpecificOutput.additionalContext");
  });

  it("limits search results to 5", async () => {
    mockSearchResults = [];

    await runSessionStartLogic(makeSessionStartPayload());

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(lightweightSearch).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ limit: 5 }),
    );
  });
});

// --------------------------------------------------------------------------
// Source file structure tests
// --------------------------------------------------------------------------
describe("session-start source structure", () => {
  it("has AGENT_ID guard before imports", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/session-start.ts"), "utf8");

    const guardIdx = src.indexOf("process.env.AGENT_ID");
    const importIdx = src.indexOf("import ");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(importIdx);
  });

  it("has autoRetrieval config guard", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/session-start.ts"), "utf8");

    expect(src).toContain("autoRetrieval");
    expect(src).toContain("loadConfigSync");
  });

  it("uses process.exit(0) for clean exit", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/session-start.ts"), "utf8");

    expect(src).toContain("process.exit(0)");
  });

  it("uses getActiveAgent for identity resolution", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/session-start.ts"), "utf8");

    expect(src).toContain('getActiveAgent');
    expect(src).toContain('cleanupSessionMarkers');
    expect(src).toContain("getActiveAgent()");
  });

  it("has a 5-second timeout safeguard", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/session-start.ts"), "utf8");

    expect(src).toContain("5_000");
    expect(src).toContain("timeout.unref()");
  });
});
