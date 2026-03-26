import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryRecord } from "../../src/types/memory.js";
import type { UserPromptSubmitPayload } from "../../src/types/hook-payload.js";

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

function makePromptSubmitPayload(
  overrides: Partial<UserPromptSubmitPayload> = {},
): UserPromptSubmitPayload {
  return {
    session_id: "session-001",
    cwd: "/Users/test/my-project",
    hook_event_name: "UserPromptSubmit",
    prompt: "fix the authentication bug in login handler",
    ...overrides,
  };
}

/**
 * Simulates the prompt-submit hook logic.
 *
 * The actual hook (src/hooks/prompt-submit.ts) reads from stdin.
 * We replicate its pipeline here with mocked deps for unit testing.
 */
async function runPromptSubmitLogic(
  payload: UserPromptSubmitPayload,
): Promise<{ output: string | null; skipped: boolean; searched: boolean }> {
  const agentId = process.env.AGENT_ID;
  if (!agentId) return { output: null, skipped: true, searched: false };

  const { loadConfigSync } = await import("../../src/lib/config.js");
  if (!loadConfigSync().autoRetrieval) {
    return { output: null, skipped: true, searched: false };
  }

  const prompt = payload.prompt;

  // Relevance gate: minimum length check
  if (prompt.length < 20) {
    return { output: null, skipped: true, searched: false };
  }

  const { initStore } = await import("../../src/lib/store.js");
  const { loadConfig } = await import("../../src/lib/config.js");
  const { lightweightSearch, hybridSearch } = await import(
    "../../src/lib/hybrid-search.js"
  );

  await initStore();

  const config = await loadConfig();
  const search =
    config.hookSearchMode === "hybrid" ? hybridSearch : lightweightSearch;

  const memories = await search(prompt.slice(0, 200), agentId, { limit: 5 });

  if (memories.length > 0) {
    const context = memories
      .map(
        (m) =>
          `[${m.timestamp}] ${m.tool_name}: ${m.raw_text.slice(0, 300)}`,
      )
      .join("\n");

    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `## Relevant Memories\n${context}`,
      },
    });
    return { output, skipped: false, searched: true };
  }

  return { output: null, skipped: false, searched: true };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------
describe("prompt-submit hook", () => {
  beforeEach(() => {
    mockSearchResults = [];
    mockAutoRetrieval = true;
    mockHookSearchMode = "fts";
    vi.clearAllMocks();
    process.env.AGENT_ID = "test-agent";
  });

  it("exits early when AGENT_ID is not set", async () => {
    delete process.env.AGENT_ID;

    const result = await runPromptSubmitLogic(makePromptSubmitPayload());

    expect(result.output).toBeNull();
    expect(result.skipped).toBe(true);

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(lightweightSearch).not.toHaveBeenCalled();
  });

  it("exits early when autoRetrieval is disabled", async () => {
    mockAutoRetrieval = false;

    const result = await runPromptSubmitLogic(makePromptSubmitPayload());

    expect(result.output).toBeNull();
    expect(result.skipped).toBe(true);

    const { initStore } = await import("../../src/lib/store.js");
    expect(initStore).not.toHaveBeenCalled();
  });

  describe.each([
    { prompt: "yes" },
    { prompt: "ok" },
    { prompt: "keep going" },
    { prompt: "no" },
    { prompt: "y" },
    { prompt: "continue" },
  ])("short prompt: '$prompt'", ({ prompt }) => {
    it("exits early when prompt is too short (<20 chars)", async () => {
      const result = await runPromptSubmitLogic(
        makePromptSubmitPayload({ prompt }),
      );

      expect(result.output).toBeNull();
      expect(result.skipped).toBe(true);
      expect(result.searched).toBe(false);
    });
  });

  it("produces additionalContext when relevant memories found", async () => {
    mockSearchResults = [
      makeMemoryRecord({
        raw_text:
          "Tool: Bash\nInput: npm test\nOutput: All auth tests passed",
      }),
    ];

    const result = await runPromptSubmitLogic(makePromptSubmitPayload());

    expect(result.output).not.toBeNull();
    const parsed = JSON.parse(result.output!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(
      parsed.hookSpecificOutput.additionalContext.length,
    ).toBeGreaterThan(0);
  });

  it("returns null output when search yields no results", async () => {
    mockSearchResults = [];

    const result = await runPromptSubmitLogic(makePromptSubmitPayload());

    expect(result.output).toBeNull();
    expect(result.searched).toBe(true);
    expect(result.skipped).toBe(false);
  });

  it("truncates prompt to 200 chars before searching", async () => {
    const longPrompt = "x".repeat(500);
    await runPromptSubmitLogic(makePromptSubmitPayload({ prompt: longPrompt }));

    const { lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    const calledWith = (lightweightSearch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(calledWith.length).toBeLessThanOrEqual(200);
  });

  it("uses hybridSearch when hookSearchMode is hybrid", async () => {
    mockHookSearchMode = "hybrid";
    mockSearchResults = [];

    await runPromptSubmitLogic(makePromptSubmitPayload());

    const { hybridSearch, lightweightSearch } = await import(
      "../../src/lib/hybrid-search.js"
    );
    expect(hybridSearch).toHaveBeenCalled();
    expect(lightweightSearch).not.toHaveBeenCalled();
  });

  it("uses additionalContext for silent injection", async () => {
    mockSearchResults = [makeMemoryRecord()];

    const result = await runPromptSubmitLogic(makePromptSubmitPayload());

    expect(result.output).not.toBeNull();
    const parsed = JSON.parse(result.output!);
    expect(parsed).toHaveProperty("hookSpecificOutput.additionalContext");
  });

  it("limits search results to 5", async () => {
    mockSearchResults = [];

    await runPromptSubmitLogic(makePromptSubmitPayload());

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
describe("prompt-submit source structure", () => {
  it("has AGENT_ID guard before imports", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/prompt-submit.ts"), "utf8");

    const guardIdx = src.indexOf("process.env.AGENT_ID");
    const importIdx = src.indexOf("import ");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(importIdx);
  });

  it("has autoRetrieval config guard", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/prompt-submit.ts"), "utf8");

    expect(src).toContain("autoRetrieval");
    expect(src).toContain("loadConfigSync");
  });

  it("has minimum length relevance gate at 20 chars", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/prompt-submit.ts"), "utf8");

    expect(src).toContain("prompt.length < 20");
  });

  it("uses process.exit(0) for clean exit", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/prompt-submit.ts"), "utf8");

    expect(src).toContain("process.exit(0)");
  });

  it("has a 5-second timeout safeguard", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve("src/adapters/claude/hooks/prompt-submit.ts"), "utf8");

    expect(src).toContain("5_000");
    expect(src).toContain("timeout.unref()");
  });
});

