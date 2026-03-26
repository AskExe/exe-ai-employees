import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryRecord } from "../../src/types/memory.js";
import type { PostToolUsePayload } from "../../src/types/hook-payload.js";

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
// Mock error-detector: configurable detectError result
// --------------------------------------------------------------------------
let mockDetectErrorResult = false;

vi.mock("../../src/lib/error-detector.js", () => ({
  detectError: vi.fn(() => mockDetectErrorResult),
  ERROR_PATTERNS: [],
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

function makePostToolUsePayload(
  overrides: Partial<PostToolUsePayload> = {},
): PostToolUsePayload {
  return {
    session_id: "session-001",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/Users/test/my-project",
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: { stderr: "Error: ENOENT no such file or directory" },
    tool_use_id: "tu_abc123",
    ...overrides,
  };
}

/**
 * Simulates the error-recall hook logic.
 *
 * The actual hook (src/hooks/error-recall.ts) is a standalone script
 * that reads from stdin and calls process.exit. We replicate its logic
 * here with mocked dependencies to enable unit testing.
 */
async function runErrorRecallLogic(
  payload: PostToolUsePayload,
): Promise<string | null> {
  const agentId = process.env.AGENT_ID;
  if (!agentId) return null;

  const { loadConfigSync } = await import("../../src/lib/config.js");
  if (!loadConfigSync().autoRetrieval) return null;

  const { detectError } = await import("../../src/lib/error-detector.js");
  if (!detectError(payload)) return null;

  const { initStore } = await import("../../src/lib/store.js");
  const { loadConfig } = await import("../../src/lib/config.js");
  const { lightweightSearch, hybridSearch } = await import(
    "../../src/lib/hybrid-search.js"
  );

  await initStore();
  const config = await loadConfig();
  const search =
    config.hookSearchMode === "hybrid" ? hybridSearch : lightweightSearch;

  const errorText = JSON.stringify(payload.tool_response).slice(0, 300);
  const memories = await search(errorText, agentId, {
    hasError: true,
    limit: 3,
  });

  if (memories.length > 0) {
    const context = memories
      .map(
        (m) =>
          `[${m.timestamp}] ${m.tool_name} (${m.project_name}): ${m.raw_text.slice(0, 400)}`,
      )
      .join("\n\n");

    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `## Past Solutions for Similar Errors\nYou've encountered similar errors before:\n${context}`,
      },
    });
  }

  return null;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------
describe("error-recall hook", () => {
  beforeEach(() => {
    mockSearchResults = [];
    mockDetectErrorResult = false;
    mockAutoRetrieval = true;
    mockHookSearchMode = "fts";
    vi.clearAllMocks();
    process.env.AGENT_ID = "test-agent";
  });

  it("exits early when AGENT_ID is not set", async () => {
    delete process.env.AGENT_ID;
    mockDetectErrorResult = true;

    const output = await runErrorRecallLogic(makePostToolUsePayload());

    expect(output).toBeNull();

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(lightweightSearch).not.toHaveBeenCalled();
  });

  it("exits early when autoRetrieval is disabled", async () => {
    mockAutoRetrieval = false;
    mockDetectErrorResult = true;

    const output = await runErrorRecallLogic(makePostToolUsePayload());

    expect(output).toBeNull();

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(lightweightSearch).not.toHaveBeenCalled();
  });

  it("exits early when no error patterns detected in tool output", async () => {
    mockDetectErrorResult = false;

    const payload = makePostToolUsePayload({
      tool_response: { output: "Build succeeded" },
    });
    const output = await runErrorRecallLogic(payload);

    expect(output).toBeNull();

    const { initStore } = await import("../../src/lib/store.js");
    expect(initStore).not.toHaveBeenCalled();
  });

  it("produces additionalContext when errors found and memories exist", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [
      makeMemoryRecord({
        id: "err-001",
        has_error: true,
        raw_text:
          "Tool: Bash\nInput: npm test\nOutput: Error: ENOENT resolved by npm install",
      }),
      makeMemoryRecord({
        id: "err-002",
        has_error: true,
        tool_name: "Write",
        raw_text:
          "Tool: Write\nInput: fix.ts\nOutput: Fixed ENOENT by creating directory",
      }),
    ];

    const output = await runErrorRecallLogic(makePostToolUsePayload());

    expect(output).not.toBeNull();
    const parsed = JSON.parse(output!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(
      parsed.hookSpecificOutput.additionalContext.length,
    ).toBeGreaterThan(0);
  });

  it("returns null when error detected but no past error memories found", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [];

    const output = await runErrorRecallLogic(makePostToolUsePayload());

    expect(output).toBeNull();
  });

  it("searches with hasError: true filter and limit: 3", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [];

    await runErrorRecallLogic(makePostToolUsePayload());

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(lightweightSearch).toHaveBeenCalledWith(
      expect.any(String),
      "test-agent",
      { hasError: true, limit: 3 },
    );
  });

  it("uses hybridSearch when hookSearchMode is hybrid", async () => {
    mockDetectErrorResult = true;
    mockHookSearchMode = "hybrid";
    mockSearchResults = [];

    await runErrorRecallLogic(makePostToolUsePayload());

    const { hybridSearch, lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(hybridSearch).toHaveBeenCalled();
    expect(lightweightSearch).not.toHaveBeenCalled();
  });

  it("truncates tool_response to 300 chars for search query", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [];

    const longResponse = { output: "x".repeat(1000) };
    const payload = makePostToolUsePayload({ tool_response: longResponse });
    await runErrorRecallLogic(payload);

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    const calledWith = (lightweightSearch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(calledWith.length).toBeLessThanOrEqual(300);
  });
});

// --------------------------------------------------------------------------
// Source file structure tests
// --------------------------------------------------------------------------
describe("error-recall source structure", () => {
  it("has AGENT_ID guard before imports", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/error-recall.ts"), "utf8");

    const guardIdx = src.indexOf("process.env.AGENT_ID");
    const importIdx = src.indexOf("import ");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(importIdx);
  });

  it("has autoRetrieval config guard", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/error-recall.ts"), "utf8");

    expect(src).toContain("autoRetrieval");
    expect(src).toContain("loadConfigSync");
  });

  it("uses process.exit(0) for clean exit", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/error-recall.ts"), "utf8");

    expect(src).toContain("process.exit(0)");
  });

  it("uses additionalContext for output injection", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/error-recall.ts"), "utf8");

    expect(src).toContain("additionalContext");
  });

  it("has a 5-second timeout safeguard", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/error-recall.ts"), "utf8");

    expect(src).toContain("5_000");
    expect(src).toContain("timeout.unref()");
  });
});
