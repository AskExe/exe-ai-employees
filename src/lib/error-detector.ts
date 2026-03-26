/**
 * Error pattern detection for tool output.
 *
 * Tool-type-aware: file-content tools (Read/Write/Edit/Glob/Grep) only check
 * for tool-level errors, not pattern matches inside file content.
 * Bash checks exit code + filtered stderr. Other tools use pattern matching.
 *
 * @module error-detector
 */

/** Regex patterns that indicate a real error in tool output (for non-file tools). */
export const ERROR_PATTERNS: RegExp[] = [
  /\bError\b/i,
  /\bERR!\b/,
  /\bFAIL(ED|URE)?\b/i,
  /\bException\b/i,
  /\bTraceback\b/,
  /\bpanic\b/,
  /\bSIGSEGV\b/,
  /\bSIGABRT\b/,
  /exit code [1-9]/i,
  /non-zero (exit|status)/i,
  /command not found/i,
  /permission denied/i,
  /ENOENT/,
  /EACCES/,
  /ENOMEM/,
];

/** Tools that return file content — pattern matching on their output causes false positives. */
const FILE_CONTENT_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
]);

/** Stderr lines matching these patterns are not real errors. */
const STDERR_IGNORE_PATTERNS: RegExp[] = [
  /^warning\b/i,
  /\bDeprecationWarning\b/,
  /^hint:/i,
  /^npm warn\b/i,
  /^npm notice\b/i,
  /^\(node:\d+\) \w*Warning:/,
  /^Cloning into/,
  /^Already on/,
  /^Switched to/,
  /^Your branch is/,
  /^Auto-merging/,
  /^\s*$/,
];

/**
 * Check if stderr content represents a real error (not just warnings/hints).
 */
function isRealStderr(stderr: string): boolean {
  const lines = stderr.trim().split("\n");
  // If every non-empty line matches an ignore pattern, it's not an error
  const meaningful = lines.filter(
    (line) => line.trim().length > 0 && !STDERR_IGNORE_PATTERNS.some((p) => p.test(line)),
  );
  return meaningful.length > 0;
}

/**
 * Detect whether a tool response contains error patterns.
 *
 * Strategy by tool type:
 * - File-content tools (Read/Write/Edit/Glob/Grep): only check for explicit
 *   error fields — never scan file content for error keywords.
 * - Bash: check exit code + filtered stderr (ignoring warnings/hints).
 * - All others: pattern-match on stringified response.
 *
 * @param data - PostToolUse payload (or subset with tool_response)
 * @returns true if the response contains real error indicators
 */
export function detectError(data: {
  tool_name?: string;
  tool_response?: Record<string, unknown>;
}): boolean {
  const response = data.tool_response;
  if (!response) return false;

  const toolName = data.tool_name ?? "";

  // --- File-content tools: only check for tool-level errors ---
  if (FILE_CONTENT_TOOLS.has(toolName)) {
    return response.type === "error" || response.error != null;
  }

  // --- Bash: structured check on exit code + filtered stderr ---
  if (toolName === "Bash") {
    // Non-zero exit code is a definitive error
    if (typeof response.exitCode === "number" && response.exitCode !== 0) {
      return true;
    }
    // Check stderr, filtering out known non-error output
    if (typeof response.stderr === "string" && response.stderr.trim().length > 0) {
      return isRealStderr(response.stderr);
    }
    return false;
  }

  // --- MCP / other tools: check for error fields first ---
  if (response.type === "error" || response.error != null || response.isError === true) {
    return true;
  }

  // Non-empty stderr that's real (not warnings)
  if (typeof response.stderr === "string" && response.stderr.trim().length > 0) {
    if (isRealStderr(response.stderr)) return true;
  }

  // Pattern-match only on stdout/output fields, not the entire response
  const textParts: string[] = [];
  if (typeof response.stdout === "string") textParts.push(response.stdout);
  if (typeof response.output === "string") textParts.push(response.output);
  if (typeof response.text === "string") textParts.push(response.text);
  if (typeof response.message === "string") textParts.push(response.message);

  if (textParts.length === 0) return false;

  const text = textParts.join("\n");
  return ERROR_PATTERNS.some((pattern) => pattern.test(text));
}
