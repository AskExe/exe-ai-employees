import { describe, it, expect } from "vitest";
import { detectError, ERROR_PATTERNS } from "../../src/lib/error-detector.js";

describe("error-detector", () => {
  describe("ERROR_PATTERNS", () => {
    it("exports an array of RegExp patterns", () => {
      expect(Array.isArray(ERROR_PATTERNS)).toBe(true);
      expect(ERROR_PATTERNS.length).toBeGreaterThanOrEqual(15);
      for (const p of ERROR_PATTERNS) {
        expect(p).toBeInstanceOf(RegExp);
      }
    });
  });

  describe("detectError", () => {
    it("returns false when no tool_response", () => {
      expect(detectError({})).toBe(false);
    });

    // ── AC1: Reading files with error keywords does NOT flag ──

    describe("Read tool — no false positives on file content", () => {
      it.each([
        "Error",
        "Exception",
        "FAIL",
        "FAILED",
        "FAILURE",
        "Traceback",
        "panic",
        "ENOENT",
        "permission denied",
        "command not found",
      ])('does NOT flag when file contains "%s"', (keyword) => {
        expect(
          detectError({
            tool_name: "Read",
            tool_response: {
              type: "text",
              file: {
                filePath: "/src/lib/error-handler.ts",
                content: `export class AppError extends ${keyword} { }`,
              },
            },
          }),
        ).toBe(false);
      });

      it("flags when Read returns a tool-level error", () => {
        expect(
          detectError({
            tool_name: "Read",
            tool_response: { type: "error", error: "File not found" },
          }),
        ).toBe(true);
      });

      it("flags when Read response has error field", () => {
        expect(
          detectError({
            tool_name: "Read",
            tool_response: { error: "Permission denied" },
          }),
        ).toBe(true);
      });
    });

    // ── AC2: Editing files with error-handling code does NOT flag ──

    describe("Edit tool — no false positives on code edits", () => {
      it("does NOT flag successful edit containing error patterns", () => {
        expect(
          detectError({
            tool_name: "Edit",
            tool_response: {
              filePath: "/src/app.ts",
              oldString: "throw new Error('bad')",
              newString: "throw new AppError('bad', { cause: exception })",
            },
          }),
        ).toBe(false);
      });

      it("flags when Edit returns a tool-level error", () => {
        expect(
          detectError({
            tool_name: "Edit",
            tool_response: { type: "error", error: "old_string not found" },
          }),
        ).toBe(true);
      });
    });

    // ── Write/Glob/Grep — same treatment as Read/Edit ──

    describe("other file-content tools", () => {
      it.each(["Write", "Glob", "Grep", "NotebookEdit"])(
        "%s does NOT flag on content with error keywords",
        (tool) => {
          expect(
            detectError({
              tool_name: tool,
              tool_response: {
                type: "text",
                content: "detectError returns true for FAILURE cases",
              },
            }),
          ).toBe(false);
        },
      );
    });

    // ── AC3: Bash non-zero exit code DOES flag ──

    describe("Bash tool — real errors", () => {
      it("flags non-zero exit code", () => {
        expect(
          detectError({
            tool_name: "Bash",
            tool_response: { exitCode: 1, stdout: "", stderr: "" },
          }),
        ).toBe(true);
      });

      it("flags exit code 127 (command not found)", () => {
        expect(
          detectError({
            tool_name: "Bash",
            tool_response: {
              exitCode: 127,
              stdout: "",
              stderr: "zsh: command not found: foo",
            },
          }),
        ).toBe(true);
      });

      it("does NOT flag exit code 0 with clean output", () => {
        expect(
          detectError({
            tool_name: "Bash",
            tool_response: {
              exitCode: 0,
              stdout: "Build succeeded",
              stderr: "",
            },
          }),
        ).toBe(false);
      });

      it("does NOT flag exit code 0 with empty stderr", () => {
        expect(
          detectError({
            tool_name: "Bash",
            tool_response: { exitCode: 0, stdout: "ok", stderr: "  \n" },
          }),
        ).toBe(false);
      });
    });

    // ── AC5: npm/git/tsc stderr warnings do NOT flag ──

    describe("Bash tool — stderr false positive filtering", () => {
      it.each([
        "warning: LF will be replaced by CRLF",
        "npm warn deprecated glob@7.2.3",
        "npm notice created a lockfile",
        "(node:12345) DeprecationWarning: util.isArray is deprecated",
        "hint: Use -f if you really want to add them",
        "Already on 'main'",
        "Switched to branch 'feature'",
        "Your branch is up to date with 'origin/main'",
        "Cloning into 'repo'...",
        "Auto-merging src/lib/foo.ts",
      ])('does NOT flag stderr: "%s"', (stderr) => {
        expect(
          detectError({
            tool_name: "Bash",
            tool_response: { exitCode: 0, stdout: "", stderr },
          }),
        ).toBe(false);
      });

      it("DOES flag real stderr errors even with exit code 0", () => {
        expect(
          detectError({
            tool_name: "Bash",
            tool_response: {
              exitCode: 0,
              stdout: "",
              stderr: "Error: Cannot find module './missing'",
            },
          }),
        ).toBe(true);
      });

      it("does NOT flag when all stderr lines are warnings", () => {
        const stderr = [
          "npm warn deprecated rimraf@2.7.1",
          "npm warn deprecated glob@7.2.3",
          "(node:98765) DeprecationWarning: something old",
        ].join("\n");
        expect(
          detectError({
            tool_name: "Bash",
            tool_response: { exitCode: 0, stdout: "", stderr },
          }),
        ).toBe(false);
      });
    });

    // ── AC4: MCP tool error responses DO flag ──

    describe("MCP / other tools — real errors", () => {
      it("flags response with type=error", () => {
        expect(
          detectError({
            tool_name: "mcp__foo__bar",
            tool_response: { type: "error", error: "auth failed" },
          }),
        ).toBe(true);
      });

      it("flags response with isError=true", () => {
        expect(
          detectError({
            tool_name: "mcp__foo__bar",
            tool_response: { isError: true, message: "rate limited" },
          }),
        ).toBe(true);
      });

      it("flags response with error field", () => {
        expect(
          detectError({
            tool_name: "mcp__foo__bar",
            tool_response: { error: "connection refused" },
          }),
        ).toBe(true);
      });

      it("flags response with error pattern in output field", () => {
        expect(
          detectError({
            tool_name: "mcp__foo__bar",
            tool_response: { output: "FAIL tests/foo.test.ts" },
          }),
        ).toBe(true);
      });

      it("does NOT flag successful MCP response", () => {
        expect(
          detectError({
            tool_name: "mcp__foo__bar",
            tool_response: { type: "text", text: "Found 5 memories" },
          }),
        ).toBe(false);
      });
    });

    // ── Pattern matching on output fields for unknown tools ──

    describe("unknown tools — pattern matching on output fields", () => {
      it("returns true for 'command not found' in output", () => {
        expect(
          detectError({ tool_response: { output: "command not found" } }),
        ).toBe(true);
      });

      it("returns true for exit code 1 in output", () => {
        expect(
          detectError({ tool_response: { output: "exit code 1" } }),
        ).toBe(true);
      });

      it("returns true for ENOENT in output", () => {
        expect(
          detectError({ tool_response: { output: "ENOENT: no such file" } }),
        ).toBe(true);
      });

      it("returns true for FAIL in output", () => {
        expect(
          detectError({ tool_response: { output: "FAIL tests/foo.test.ts" } }),
        ).toBe(true);
      });

      it("returns true for permission denied in output", () => {
        expect(
          detectError({ tool_response: { output: "permission denied" } }),
        ).toBe(true);
      });

      it("returns true for Python traceback in output", () => {
        expect(
          detectError({
            tool_response: { output: "Traceback (most recent call last)" },
          }),
        ).toBe(true);
      });

      it("returns false for successful output", () => {
        expect(
          detectError({ tool_response: { output: "Build succeeded" } }),
        ).toBe(false);
      });

      it("returns false for empty response", () => {
        expect(
          detectError({ tool_response: {} }),
        ).toBe(false);
      });
    });

    // ── Backwards compatibility: no tool_name still works ──

    describe("missing tool_name — fallback to pattern matching", () => {
      it("flags error in stdout field", () => {
        expect(
          detectError({
            tool_response: { stdout: "Error: something broke" },
          }),
        ).toBe(true);
      });

      it("flags error in stderr with filtering", () => {
        expect(
          detectError({
            tool_response: { stderr: "fatal: not a git repository" },
          }),
        ).toBe(true);
      });

      it("does NOT flag warning-only stderr", () => {
        expect(
          detectError({
            tool_response: { stderr: "warning: skipping unresolved ref" },
          }),
        ).toBe(false);
      });
    });
  });
});
