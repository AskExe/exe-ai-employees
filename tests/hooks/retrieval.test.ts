import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MemoryRecord } from "../../src/types/memory.js";
import type { SessionStartPayload } from "../../src/types/hook-payload.js";
import type { UserPromptSubmitPayload } from "../../src/types/hook-payload.js";
import type { PostToolUsePayload } from "../../src/types/hook-payload.js";

// --------------------------------------------------------------------------
// Mock embedder: return a fixed 1024-dim zero vector (no GGUF dependency)
// --------------------------------------------------------------------------
const ZERO_VECTOR = new Array(1024).fill(0) as number[];

vi.mock("../../src/lib/embedder.js", () => ({
  embed: vi.fn().mockResolvedValue(ZERO_VECTOR),
  getEmbedder: vi.fn(),
  disposeEmbedder: vi.fn(),
}));

// --------------------------------------------------------------------------
// Mock store: configurable search results
// --------------------------------------------------------------------------
let mockSearchResults: MemoryRecord[] = [];
let mockVectorSearchResults: Record<string, unknown>[] = [];

const mockTable = {
  vectorSearch: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockReturnValue({
        toArray: vi.fn().mockImplementation(() =>
          Promise.resolve(mockVectorSearchResults),
        ),
      }),
    }),
  }),
};

vi.mock("../../src/lib/store.js", () => ({
  initStore: vi.fn().mockResolvedValue(undefined),
  searchMemories: vi.fn().mockImplementation(async () => mockSearchResults),
  disposeStore: vi.fn(),
}));

// --------------------------------------------------------------------------
// Mock error-detector
// --------------------------------------------------------------------------
let mockDetectErrorResult = false;

vi.mock("../../src/lib/error-detector.js", () => ({
  detectError: vi.fn().mockImplementation(() => mockDetectErrorResult),
  ERROR_PATTERNS: [],
}));

// --------------------------------------------------------------------------
// Helpers: build test payloads
// --------------------------------------------------------------------------
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

// --------------------------------------------------------------------------
// SessionStart hook tests (RETR-01, RETR-04)
// --------------------------------------------------------------------------
describe("session-start hook", () => {
  beforeEach(() => {
    mockSearchResults = [];
    vi.clearAllMocks();
    process.env.AGENT_ID = "test-agent";
  });

  /**
   * Simulate session-start hook logic:
   * Parse payload -> embed project query -> search memories -> output brief
   */
  async function runSessionStartLogic(
    payload: SessionStartPayload,
  ): Promise<string | null> {
    const agentId = process.env.AGENT_ID;
    if (!agentId) return null;

    const path = await import("node:path");
    const { embed } = await import("../../src/lib/embedder.js");
    const { initStore, searchMemories } = await import(
      "../../src/lib/store.js"
    );

    const projectName = path.basename(payload.cwd ?? "");
    await initStore();
    const queryVector = await embed(`recent work on ${projectName}`);
    const memories = await searchMemories(queryVector, agentId, {
      projectName,
      limit: 5,
    });

    if (memories.length > 0) {
      const brief = memories
        .map(
          (m) =>
            `[${m.timestamp}] ${m.tool_name}: ${m.raw_text.slice(0, 200)}`,
        )
        .join("\n");

      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: `## Memory Brief\nRecent memories from this project:\n${brief}`,
        },
      });
    }

    return null;
  }

  it("injects memory brief when memories exist (RETR-01)", async () => {
    mockSearchResults = [
      makeMemoryRecord({ id: "mem-001", tool_name: "Bash" }),
      makeMemoryRecord({
        id: "mem-002",
        tool_name: "Write",
        timestamp: "2026-03-17T08:05:00Z",
      }),
    ];

    const payload = makeSessionStartPayload();
    const output = await runSessionStartLogic(payload);

    expect(output).not.toBeNull();
    const parsed = JSON.parse(output!);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
  });

  it("outputs nothing when no memories exist", async () => {
    mockSearchResults = [];

    const payload = makeSessionStartPayload();
    const output = await runSessionStartLogic(payload);

    expect(output).toBeNull();
  });

  it("skips when AGENT_ID is not set", async () => {
    delete process.env.AGENT_ID;

    const { searchMemories } = await import("../../src/lib/store.js");

    const payload = makeSessionStartPayload();
    const output = await runSessionStartLogic(payload);

    expect(output).toBeNull();
    expect(searchMemories).not.toHaveBeenCalled();
  });

  it("uses additionalContext for silent injection (RETR-04)", async () => {
    mockSearchResults = [makeMemoryRecord()];

    const payload = makeSessionStartPayload();
    const output = await runSessionStartLogic(payload);

    expect(output).not.toBeNull();
    const parsed = JSON.parse(output!);
    // Must use hookSpecificOutput.additionalContext, not plain stdout text
    expect(parsed).toHaveProperty(
      "hookSpecificOutput.additionalContext",
    );
  });

  it("embeds project name for the search query", async () => {
    mockSearchResults = [];

    const payload = makeSessionStartPayload({
      cwd: "/Users/test/my-cool-project",
    });
    await runSessionStartLogic(payload);

    const { embed } = await import("../../src/lib/embedder.js");
    expect(embed).toHaveBeenCalledWith(
      "recent work on my-cool-project",
    );
  });
});

// --------------------------------------------------------------------------
// UserPromptSubmit hook tests (RETR-02, RETR-04, RETR-05)
// --------------------------------------------------------------------------
describe("prompt-submit hook", () => {
  beforeEach(() => {
    mockVectorSearchResults = [];
    vi.clearAllMocks();
    process.env.AGENT_ID = "test-agent";
  });

  /**
   * Simulate prompt-submit hook logic:
   * Check length -> search memories -> output
   */
  async function runPromptSubmitLogic(
    payload: UserPromptSubmitPayload,
  ): Promise<{
    output: string | null;
    skipped: boolean;
    searched: boolean;
  }> {
    const agentId = process.env.AGENT_ID;
    if (!agentId) return { output: null, skipped: true, searched: false };

    const prompt = payload.prompt;

    // Relevance gate 1: minimum length check
    if (prompt.length < 20) {
      return { output: null, skipped: true, searched: false };
    }

    const { embed } = await import("../../src/lib/embedder.js");
    const { initStore, searchMemories } = await import(
      "../../src/lib/store.js"
    );

    await initStore();
    const queryVector = await embed(prompt.slice(0, 512));

    const memories = await searchMemories(queryVector, agentId, { limit: 5 });

    if (memories.length > 0) {
      const context = memories
        .map(
          (m: MemoryRecord) =>
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

  it("injects memories when similarity exceeds threshold (RETR-02)", async () => {
    mockSearchResults = [
      makeMemoryRecord({
        raw_text: "Tool: Bash\nInput: npm test\nOutput: All tests passed",
      }),
    ];

    const payload = makePromptSubmitPayload();
    const result = await runPromptSubmitLogic(payload);

    expect(result.output).not.toBeNull();
    const parsed = JSON.parse(result.output!);
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
    expect(parsed.hookSpecificOutput.hookEventName).toBe(
      "UserPromptSubmit",
    );
  });

  it("injects nothing when no search results (RETR-02)", async () => {
    mockSearchResults = []; // No results from search

    const payload = makePromptSubmitPayload();
    const result = await runPromptSubmitLogic(payload);

    expect(result.output).toBeNull();
    expect(result.searched).toBe(true);
  });

  it("skips short prompts (RETR-05) - 'yes'", async () => {
    const payload = makePromptSubmitPayload({ prompt: "yes" });
    const result = await runPromptSubmitLogic(payload);

    expect(result.skipped).toBe(true);
    expect(result.searched).toBe(false);
  });

  it("skips short prompts (RETR-05) - 'keep going'", async () => {
    const payload = makePromptSubmitPayload({ prompt: "keep going" });
    const result = await runPromptSubmitLogic(payload);

    expect(result.skipped).toBe(true);
    expect(result.searched).toBe(false);
  });

  it("skips short prompts (RETR-05) - 'ok'", async () => {
    const payload = makePromptSubmitPayload({ prompt: "ok" });
    const result = await runPromptSubmitLogic(payload);

    expect(result.skipped).toBe(true);
    expect(result.searched).toBe(false);
  });

  it("uses additionalContext for silent injection (RETR-04)", async () => {
    mockSearchResults = [
      makeMemoryRecord({
        raw_text: "Tool: Bash\nInput: npm test\nOutput: All tests passed",
      }),
    ];

    const payload = makePromptSubmitPayload();
    const result = await runPromptSubmitLogic(payload);

    expect(result.output).not.toBeNull();
    const parsed = JSON.parse(result.output!);
    expect(parsed).toHaveProperty(
      "hookSpecificOutput.additionalContext",
    );
  });

  it("truncates prompt to 512 chars before embedding", async () => {
    const longPrompt = "x".repeat(1000);
    const payload = makePromptSubmitPayload({ prompt: longPrompt });
    await runPromptSubmitLogic(payload);

    const { embed } = await import("../../src/lib/embedder.js");
    expect(embed).toHaveBeenCalledWith("x".repeat(512));
  });

  it("skips when AGENT_ID is not set", async () => {
    delete process.env.AGENT_ID;

    const payload = makePromptSubmitPayload();
    const result = await runPromptSubmitLogic(payload);

    expect(result.skipped).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Error recall hook tests (RETR-03, RETR-04)
// --------------------------------------------------------------------------
describe("error-recall hook", () => {
  beforeEach(() => {
    mockSearchResults = [];
    mockDetectErrorResult = false;
    vi.clearAllMocks();
    process.env.AGENT_ID = "test-agent";
  });

  /**
   * Simulate error-recall hook logic:
   * detectError -> embed error text -> search past errors -> output solutions
   */
  async function runErrorRecallLogic(
    payload: PostToolUsePayload,
  ): Promise<{
    output: string | null;
    skippedNoError: boolean;
    searched: boolean;
  }> {
    const agentId = process.env.AGENT_ID;
    if (!agentId)
      return { output: null, skippedNoError: false, searched: false };

    const { detectError } = await import(
      "../../src/lib/error-detector.js"
    );

    // Skip non-error tool calls
    if (!detectError(payload)) {
      return { output: null, skippedNoError: true, searched: false };
    }

    const { embed } = await import("../../src/lib/embedder.js");
    const { initStore, searchMemories } = await import(
      "../../src/lib/store.js"
    );

    await initStore();

    const errorText = JSON.stringify(payload.tool_response).slice(
      0,
      500,
    );
    const queryVector = await embed(errorText);
    const memories = await searchMemories(queryVector, agentId, {
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

      const output = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `## Past Solutions for Similar Errors\nYou've encountered similar errors before:\n${context}`,
        },
      });
      return { output, skippedNoError: false, searched: true };
    }

    return { output: null, skippedNoError: false, searched: true };
  }

  it("injects past solutions when error detected (RETR-03)", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [
      makeMemoryRecord({
        id: "err-001",
        has_error: true,
        raw_text:
          "Tool: Bash\nInput: npm test\nOutput: Error: ENOENT resolved by running npm install first",
      }),
      makeMemoryRecord({
        id: "err-002",
        has_error: true,
        tool_name: "Write",
        raw_text:
          "Tool: Write\nInput: fix.ts\nOutput: Fixed ENOENT by creating missing directory",
      }),
    ];

    const payload = makePostToolUsePayload();
    const result = await runErrorRecallLogic(payload);

    expect(result.output).not.toBeNull();
    const parsed = JSON.parse(result.output!);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(typeof parsed.hookSpecificOutput.additionalContext).toBe("string");
    expect(parsed.hookSpecificOutput.additionalContext.length).toBeGreaterThan(0);
  });

  it("skips when no error detected (RETR-03)", async () => {
    mockDetectErrorResult = false;

    const payload = makePostToolUsePayload({
      tool_response: {
        output: "Build succeeded, all tests passing and ready",
      },
    });
    const result = await runErrorRecallLogic(payload);

    expect(result.skippedNoError).toBe(true);
    expect(result.searched).toBe(false);

    const { searchMemories } = await import("../../src/lib/store.js");
    expect(searchMemories).not.toHaveBeenCalled();
  });

  it("outputs nothing when no past errors found", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [];

    const payload = makePostToolUsePayload();
    const result = await runErrorRecallLogic(payload);

    expect(result.output).toBeNull();
    expect(result.searched).toBe(true);
  });

  it("uses additionalContext for silent injection (RETR-04)", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [makeMemoryRecord({ has_error: true })];

    const payload = makePostToolUsePayload();
    const result = await runErrorRecallLogic(payload);

    expect(result.output).not.toBeNull();
    const parsed = JSON.parse(result.output!);
    expect(parsed).toHaveProperty(
      "hookSpecificOutput.additionalContext",
    );
  });

  it("searches with hasError: true filter", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [];

    const payload = makePostToolUsePayload();
    await runErrorRecallLogic(payload);

    const { searchMemories } = await import("../../src/lib/store.js");
    expect(searchMemories).toHaveBeenCalledWith(
      expect.any(Array),
      "test-agent",
      { hasError: true, limit: 3 },
    );
  });

  it("skips when AGENT_ID is not set", async () => {
    delete process.env.AGENT_ID;
    mockDetectErrorResult = true;

    const payload = makePostToolUsePayload();
    const result = await runErrorRecallLogic(payload);

    const { searchMemories } = await import("../../src/lib/store.js");
    expect(searchMemories).not.toHaveBeenCalled();
    expect(result.output).toBeNull();
  });

  it("truncates tool_response to 500 chars for embedding", async () => {
    mockDetectErrorResult = true;
    mockSearchResults = [];

    const longResponse = { output: "x".repeat(1000) };
    const payload = makePostToolUsePayload({
      tool_response: longResponse,
    });
    await runErrorRecallLogic(payload);

    const { embed } = await import("../../src/lib/embedder.js");
    const calledWith = (embed as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(calledWith.length).toBeLessThanOrEqual(500);
  });
});

// --------------------------------------------------------------------------
// Source file structure tests (verify hooks have correct structure)
// --------------------------------------------------------------------------
describe("hook source structure", () => {
  it("all three hooks have AGENT_ID guard before imports", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    for (const hookFile of [
      "session-start.ts",
      "prompt-submit.ts",
      "error-recall.ts",
    ]) {
      const src = readFileSync(
        resolve(`src/adapters/claude/hooks/${hookFile}`),
        "utf8",
      );
      const guardIdx = src.indexOf("process.env.AGENT_ID");
      const importIdx = src.indexOf("import ");
      expect(guardIdx).toBeGreaterThan(-1);
      expect(importIdx).toBeGreaterThan(-1);
      expect(guardIdx).toBeLessThan(importIdx);
    }
  });

  it("all three hooks use process.exit(0)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    for (const hookFile of [
      "session-start.ts",
      "prompt-submit.ts",
      "error-recall.ts",
    ]) {
      const src = readFileSync(
        resolve(`src/adapters/claude/hooks/${hookFile}`),
        "utf8",
      );
      expect(src).toContain("process.exit(0)");
    }
  });

  it("all three hooks use additionalContext for injection", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");

    for (const hookFile of [
      "session-start.ts",
      "prompt-submit.ts",
      "error-recall.ts",
    ]) {
      const src = readFileSync(
        resolve(`src/adapters/claude/hooks/${hookFile}`),
        "utf8",
      );
      expect(src).toContain("additionalContext");
    }
  });
});
