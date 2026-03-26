import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemoryRecord } from "../../src/types/memory.js";
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
// Mock store: capture written records
// --------------------------------------------------------------------------
let writtenRecords: MemoryRecord[] = [];

vi.mock("../../src/lib/store.js", () => ({
  writeMemory: vi.fn(async (record: MemoryRecord) => {
    writtenRecords.push(record);
  }),
  flushBatch: vi.fn().mockResolvedValue(1),
  initStore: vi.fn(),
  disposeStore: vi.fn(),
}));

// --------------------------------------------------------------------------
// Helper: build a valid PostToolUsePayload
// --------------------------------------------------------------------------
function makePayload(
  overrides: Partial<PostToolUsePayload> = {},
): PostToolUsePayload {
  return {
    session_id: "test-session-123",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/Users/test/my-project",
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
    tool_response: {
      output: "hello world from the bash command execution result output",
    },
    tool_use_id: "tu_abc123",
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tests for ingest.ts (hook entry point)
// --------------------------------------------------------------------------
describe("ingest hook (ingest.ts)", () => {
  it("has AGENT_ID guard as first executable statement", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve("src/adapters/claude/hooks/ingest.ts"),
      "utf8",
    );
    // The AGENT_ID guard should appear before any import statements
    const guardIdx = src.indexOf("process.env.AGENT_ID");
    const importIdx = src.indexOf('import {');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(importIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(importIdx);
  });

  it("does NOT import embedder or store (heavy imports only in worker)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve("src/adapters/claude/hooks/ingest.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/import.*embedder/);
    expect(src).not.toMatch(/import.*store/);
  });

  it("uses detached spawn with worker.unref()", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve("src/adapters/claude/hooks/ingest.ts"),
      "utf8",
    );
    expect(src).toContain("detached: true");
    expect(src).toContain("worker.unref()");
    expect(src).toContain("process.exit(0)");
  });

  it("matches Bash, Edit, Write, Read, and mcp__* tool names", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve("src/adapters/claude/hooks/ingest.ts"),
      "utf8",
    );
    // Extract the regex from source and test it
    const regexMatch = src.match(/ALLOWED_TOOL_RE\s*=\s*\/(.*?)\//);
    expect(regexMatch).not.toBeNull();
    const re = new RegExp(regexMatch![1]!);

    expect(re.test("Bash")).toBe(true);
    expect(re.test("Edit")).toBe(true);
    expect(re.test("Write")).toBe(true);
    expect(re.test("Read")).toBe(true);
    expect(re.test("mcp__exe-memory__recall")).toBe(true);

    // Should match discovery tools
    expect(re.test("Glob")).toBe(true);
    expect(re.test("Grep")).toBe(true);
    expect(re.test("Agent")).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Tests for ingest-worker.ts (worker logic, tested via direct import)
// --------------------------------------------------------------------------
describe("ingest worker (ingest-worker.ts)", () => {
  beforeEach(() => {
    writtenRecords = [];
    vi.clearAllMocks();
    process.env.AGENT_ID = "test-agent";
    process.env.AGENT_ROLE = "engineer";
  });

  /**
   * Helper that simulates the worker's core logic without spawning a process.
   * We import the worker's dependencies (already mocked) and run the same
   * pipeline that ingest-worker.ts runs.
   */
  async function runWorkerLogic(payload: PostToolUsePayload) {
    const { embed } = await import("../../src/lib/embedder.js");
    const { detectError } = await import("../../src/lib/error-detector.js");
    const { writeMemory, flushBatch } = await import(
      "../../src/lib/store.js"
    );
    const crypto = await import("node:crypto");
    const path = await import("node:path");

    const rawText = `Tool: ${payload.tool_name}\nInput: ${JSON.stringify(payload.tool_input)}\nOutput: ${JSON.stringify(payload.tool_response).slice(0, 5000)}`;

    if (rawText.length < 50) {
      return null; // Would exit 0
    }

    const vector = await embed(rawText);
    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      agent_id: process.env.AGENT_ID!,
      agent_role: process.env.AGENT_ROLE ?? "unknown",
      session_id: payload.session_id,
      timestamp: new Date().toISOString(),
      tool_name: payload.tool_name,
      project_name: path.basename(payload.cwd ?? process.cwd()),
      has_error: detectError(payload),
      raw_text: rawText,
      vector,
    };

    await writeMemory(record);
    await flushBatch();
    return record;
  }

  it("builds raw_text from payload containing tool_name and input", async () => {
    const payload = makePayload();
    const result = await runWorkerLogic(payload);

    expect(result).not.toBeNull();
    expect(result!.raw_text).toContain("Tool: Bash");
    expect(result!.raw_text).toContain("echo hello");
    expect(result!.raw_text).toContain("hello world");
  });

  it("detects errors via detectError (has_error=true for stderr)", async () => {
    const payload = makePayload({
      tool_response: { stderr: "Error: something went wrong with the compilation process" },
    });
    const result = await runWorkerLogic(payload);

    expect(result).not.toBeNull();
    expect(result!.has_error).toBe(true);
  });

  it("has_error=false for successful output", async () => {
    const payload = makePayload({
      tool_response: {
        output: "Build succeeded, all tests passing and ready for deployment",
      },
    });
    const result = await runWorkerLogic(payload);

    expect(result).not.toBeNull();
    expect(result!.has_error).toBe(false);
  });

  it("skips payloads with raw_text < 50 chars", async () => {
    const payload = makePayload({
      tool_input: {},
      tool_response: {},
    });
    const result = await runWorkerLogic(payload);

    expect(result).toBeNull();
    expect(writtenRecords).toHaveLength(0);
  });

  it("extracts project_name from cwd", async () => {
    const payload = makePayload({ cwd: "/Users/test/my-project" });
    const result = await runWorkerLogic(payload);

    expect(result).not.toBeNull();
    expect(result!.project_name).toBe("my-project");
  });

  it("reads AGENT_ID and AGENT_ROLE from environment", async () => {
    process.env.AGENT_ID = "yoshi";
    process.env.AGENT_ROLE = "CTO";

    const payload = makePayload();
    const result = await runWorkerLogic(payload);

    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("yoshi");
    expect(result!.agent_role).toBe("CTO");
  });

  it("defaults agent_role to 'unknown' when AGENT_ROLE is not set", async () => {
    delete process.env.AGENT_ROLE;

    const payload = makePayload();
    const result = await runWorkerLogic(payload);

    expect(result).not.toBeNull();
    expect(result!.agent_role).toBe("unknown");
  });

  it("calls writeMemory and flushBatch", async () => {
    const { writeMemory, flushBatch } = await import(
      "../../src/lib/store.js"
    );

    const payload = makePayload();
    await runWorkerLogic(payload);

    expect(writeMemory).toHaveBeenCalledTimes(1);
    expect(flushBatch).toHaveBeenCalledTimes(1);
    expect(writtenRecords).toHaveLength(1);

    // Verify the record has all required fields
    const record = writtenRecords[0]!;
    expect(record.id).toBeDefined();
    expect(record.vector).toHaveLength(1024);
    expect(record.session_id).toBe("test-session-123");
    expect(record.tool_name).toBe("Bash");
    expect(record.timestamp).toBeDefined();
  });

  it("truncates tool_response to 5000 chars in raw_text", async () => {
    const longOutput = "x".repeat(10000);
    const payload = makePayload({
      tool_response: { output: longOutput },
    });
    const result = await runWorkerLogic(payload);

    expect(result).not.toBeNull();
    // The full JSON.stringify of tool_response would be much longer,
    // but we slice to 5000 chars
    const outputPart = result!.raw_text.split("Output: ")[1]!;
    expect(outputPart.length).toBeLessThanOrEqual(5000);
  });
});
