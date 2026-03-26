/**
 * TypeScript types for Claude Code hook stdin JSON payloads.
 *
 * Each hook event type has a distinct payload shape. These interfaces
 * match the documented Claude Code hook stdin schemas.
 *
 * @module hook-payload
 */

/** PostToolUse hook payload -- fired after each tool call completes. */
export interface PostToolUsePayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
  tool_use_id: string;
}

/** UserPromptSubmit hook payload -- fired when user submits a prompt. */
export interface UserPromptSubmitPayload {
  session_id: string;
  cwd: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

/** SessionStart hook payload -- fired when a session starts or resumes. */
export interface SessionStartPayload {
  session_id: string;
  cwd: string;
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  model: string;
}
