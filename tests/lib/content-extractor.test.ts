/**
 * Tests for content-extractor.ts — semantic extraction from tool calls.
 */

import { describe, it, expect } from "vitest";
import { extractSemanticText } from "../../src/lib/content-extractor.js";

describe("extractSemanticText", () => {
  describe("Write tool", () => {
    it("extracts file path and content", () => {
      const result = extractSemanticText(
        "Write",
        { file_path: "/src/lib/store.ts", content: "export function writeMemory() { ... }" },
        {},
      );
      expect(result).toContain("/src/lib/store.ts");
      expect(result).toContain("writeMemory");
      expect(result).toMatch(/^Wrote /);
    });

    it("truncates long content", () => {
      const longContent = "x".repeat(5000);
      const result = extractSemanticText("Write", { file_path: "a.ts", content: longContent }, {});
      expect(result.length).toBeLessThan(3000);
    });
  });

  describe("Edit tool", () => {
    it("extracts file path, old and new strings", () => {
      const result = extractSemanticText(
        "Edit",
        {
          file_path: "/src/lib/config.ts",
          old_string: "hookSearchMode: \"fts\"",
          new_string: "hookSearchMode: \"hybrid\"",
        },
        {},
      );
      expect(result).toContain("/src/lib/config.ts");
      expect(result).toContain("fts");
      expect(result).toContain("hybrid");
      expect(result).toMatch(/^Edited /);
    });
  });

  describe("Read tool", () => {
    it("extracts file content from nested response", () => {
      const result = extractSemanticText(
        "Read",
        { file_path: "/src/lib/store.ts" },
        { type: "text", file: { content: "export function writeMemory() { ... }" } },
      );
      expect(result).toContain("/src/lib/store.ts");
      expect(result).toContain("writeMemory");
      expect(result).toMatch(/^Read /);
    });

    it("handles missing file content gracefully", () => {
      const result = extractSemanticText("Read", { file_path: "/a.ts" }, {});
      expect(result).toContain("/a.ts");
    });
  });

  describe("Bash tool", () => {
    it("extracts command and stdout", () => {
      const result = extractSemanticText(
        "Bash",
        { command: "npm test", description: "Run tests" },
        { stdout: "628 tests passed" },
      );
      expect(result).toContain("Run tests");
      expect(result).toContain("npm test");
      expect(result).toContain("628 tests passed");
    });

    it("extracts stderr when no stdout", () => {
      const result = extractSemanticText(
        "Bash",
        { command: "bad-command" },
        { stderr: "command not found" },
      );
      expect(result).toContain("bad-command");
      expect(result).toContain("command not found");
    });
  });

  describe("Grep tool", () => {
    it("extracts pattern and results", () => {
      const result = extractSemanticText(
        "Grep",
        { pattern: "hookSearchMode", path: "/src/lib" },
        { text: "config.ts:55: hookSearchMode: \"fts\"" },
      );
      expect(result).toContain("hookSearchMode");
      expect(result).toContain("/src/lib");
    });
  });

  describe("Glob tool", () => {
    it("extracts pattern and matches", () => {
      const result = extractSemanticText(
        "Glob",
        { pattern: "**/*.test.ts" },
        { text: "tests/lib/store.test.ts\ntests/lib/config.test.ts" },
      );
      expect(result).toContain("**/*.test.ts");
    });
  });

  describe("exe-mem MCP tools", () => {
    it("store_memory — extracts memory text directly", () => {
      const result = extractSemanticText(
        "mcp__exe-mem__store_memory",
        { text: "The founder prefers tabs over spaces in TypeScript files" },
        {},
      );
      expect(result).toContain("tabs over spaces");
      expect(result).toMatch(/^Stored memory/);
    });

    it("recall_my_memory — extracts query and results", () => {
      const result = extractSemanticText(
        "mcp__exe-mem__recall_my_memory",
        { query: "coding style preferences" },
        { content: [{ type: "text", text: "Found: tabs over spaces preference" }] },
      );
      expect(result).toContain("coding style preferences");
      expect(result).toContain("tabs over spaces");
    });

    it("ask_team_memory — includes team member name", () => {
      const result = extractSemanticText(
        "mcp__exe-mem__ask_team_memory",
        { query: "deployment strategy", team_member: "yoshi" },
        { content: [{ type: "text", text: "Found: blue-green deployment" }] },
      );
      expect(result).toContain("yoshi");
      expect(result).toContain("deployment strategy");
    });

    it("create_task — extracts title, assignee, priority, context", () => {
      const result = extractSemanticText(
        "mcp__exe-mem__create_task",
        {
          title: "Fix auth middleware",
          assigned_to: "tom",
          priority: "p0",
          context: "Legal flagged session token storage",
        },
        {},
      );
      expect(result).toContain("Fix auth middleware");
      expect(result).toContain("tom");
      expect(result).toContain("p0");
      expect(result).toContain("session token");
    });

    it("update_task — extracts status change and result", () => {
      const result = extractSemanticText(
        "mcp__exe-mem__update_task",
        { task_id: "fix-auth", status: "done", result: "All tests pass, deployed" },
        {},
      );
      expect(result).toContain("fix-auth");
      expect(result).toContain("done");
      expect(result).toContain("tests pass");
    });
  });

  describe("generic MCP tools", () => {
    it("extracts tool name and input values", () => {
      const result = extractSemanticText(
        "mcp__linear__linear_create_issue",
        { title: "Fix login bug", team: "engineering" },
        { text: "Issue created: ENG-123" },
      );
      expect(result).toContain("linear_create_issue");
      expect(result).toContain("Fix login bug");
      expect(result).toContain("ENG-123");
    });
  });

  describe("default fallback", () => {
    it("falls back to JSON for unknown tools", () => {
      const result = extractSemanticText(
        "UnknownTool",
        { key: "value" },
        { text: "result" },
      );
      expect(result).toContain("UnknownTool");
      expect(result).toContain("value");
    });
  });

  describe("does NOT contain JSON wrapper noise", () => {
    it("Write output has no JSON structure tokens", () => {
      const result = extractSemanticText(
        "Write",
        { file_path: "/a.ts", content: "const x = 1;" },
        {},
      );
      expect(result).not.toContain('"file_path"');
      expect(result).not.toContain('"content"');
    });

    it("Read output has no nested type/file wrapper", () => {
      const result = extractSemanticText(
        "Read",
        { file_path: "/a.ts" },
        { type: "text", file: { content: "hello world" } },
      );
      expect(result).not.toContain('"type"');
      expect(result).not.toContain('"file"');
    });
  });
});
