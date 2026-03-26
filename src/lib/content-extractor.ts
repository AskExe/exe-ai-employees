/**
 * Extract semantic content from tool call payloads for embedding.
 *
 * Raw tool call JSON ({"file_path":"...", "content":"..."}) makes poor
 * embeddings — the semantic signal is buried in JSON noise. This module
 * extracts the meaningful text for each tool type so vector search
 * returns relevant results.
 *
 * @module content-extractor
 */

const MAX_CONTENT = 2000;
const MAX_OUTPUT = 1000;

/**
 * Extract semantic text from a tool call for embedding and FTS indexing.
 * Returns a human-readable string that captures what happened and why.
 */
export function extractSemanticText(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown>,
): string {
  switch (toolName) {
    case "Write":
      return extractWrite(toolInput);
    case "Edit":
      return extractEdit(toolInput);
    case "Read":
      return extractRead(toolInput, toolResponse);
    case "Bash":
      return extractBash(toolInput, toolResponse);
    case "Grep":
      return extractGrep(toolInput, toolResponse);
    case "Glob":
      return extractGlob(toolInput, toolResponse);
    default:
      if (toolName.startsWith("mcp__exe-mem__")) {
        return extractExeMemMcp(toolName, toolInput, toolResponse);
      }
      if (toolName.startsWith("mcp__")) {
        return extractGenericMcp(toolName, toolInput, toolResponse);
      }
      return extractDefault(toolName, toolInput, toolResponse);
  }
}

function extractWrite(input: Record<string, unknown>): string {
  const filePath = String(input.file_path ?? "");
  const content = String(input.content ?? "");
  return `Wrote ${filePath}\n${content.slice(0, MAX_CONTENT)}`;
}

function extractEdit(input: Record<string, unknown>): string {
  const filePath = String(input.file_path ?? "");
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");
  // Show what changed — both old and new are useful for search
  return `Edited ${filePath}\nRemoved: ${oldStr.slice(0, MAX_CONTENT / 2)}\nAdded: ${newStr.slice(0, MAX_CONTENT / 2)}`;
}

function extractRead(
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  const filePath = String(input.file_path ?? "");
  // Response shape: { type: "text", file: { content: "..." } }
  const file = response.file as Record<string, unknown> | undefined;
  const content = file ? String(file.content ?? "") : "";
  if (!content) {
    // Nested response shape from some contexts
    const text = String(response.text ?? response.content ?? "");
    return `Read ${filePath}\n${text.slice(0, MAX_CONTENT)}`;
  }
  return `Read ${filePath}\n${content.slice(0, MAX_CONTENT)}`;
}

function extractBash(
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  const command = String(input.command ?? "");
  const description = input.description ? String(input.description) : "";
  const stdout = String(response.stdout ?? response.text ?? "");
  const stderr = String(response.stderr ?? "");
  const parts = [description ? `${description}: ${command}` : `Ran: ${command}`];
  if (stdout) parts.push(`Output: ${stdout.slice(0, MAX_OUTPUT)}`);
  if (stderr && !stdout) parts.push(`Error: ${stderr.slice(0, MAX_OUTPUT)}`);
  return parts.join("\n");
}

function extractGrep(
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  const pattern = String(input.pattern ?? "");
  const path = input.path ? String(input.path) : "";
  const output = String(response.text ?? response.content ?? JSON.stringify(response).slice(0, MAX_OUTPUT));
  return `Searched for "${pattern}"${path ? ` in ${path}` : ""}\n${output.slice(0, MAX_OUTPUT)}`;
}

function extractGlob(
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  const pattern = String(input.pattern ?? "");
  const output = String(response.text ?? response.content ?? JSON.stringify(response).slice(0, MAX_OUTPUT));
  return `Found files matching "${pattern}"\n${output.slice(0, MAX_OUTPUT)}`;
}

function extractExeMemMcp(
  toolName: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  const shortName = toolName.replace("mcp__exe-mem__", "");

  switch (shortName) {
    case "store_memory": {
      const text = String(input.text ?? input.query ?? "");
      return `Stored memory: ${text.slice(0, MAX_CONTENT)}`;
    }
    case "recall_my_memory":
    case "ask_team_memory": {
      const query = String(input.query ?? "");
      const member = input.team_member ? ` (from ${input.team_member})` : "";
      // Extract just the result text, not the full JSON
      const resultText = extractResponseText(response);
      return `Memory search${member}: "${query}"\n${resultText.slice(0, MAX_OUTPUT)}`;
    }
    case "create_task": {
      const title = String(input.title ?? "");
      const assignedTo = String(input.assigned_to ?? "");
      const priority = String(input.priority ?? "p1");
      const context = String(input.context ?? "");
      return `Task created: "${title}" assigned to ${assignedTo} [${priority}]\n${context.slice(0, MAX_CONTENT)}`;
    }
    case "update_task": {
      const taskId = String(input.task_id ?? "");
      const status = String(input.status ?? "");
      const result = input.result ? String(input.result) : "";
      return `Task updated: ${taskId} → ${status}${result ? `\nResult: ${result.slice(0, MAX_CONTENT)}` : ""}`;
    }
    case "list_tasks": {
      const resultText = extractResponseText(response);
      return `Listed tasks\n${resultText.slice(0, MAX_OUTPUT)}`;
    }
    default: {
      return extractGenericMcp(toolName, input, response);
    }
  }
}

function extractGenericMcp(
  toolName: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  const shortName = toolName.replace(/^mcp__[^_]+__/, "");
  // Flatten input values into readable text
  const inputParts = Object.entries(input)
    .filter(([, v]) => v != null && String(v).length > 0)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
    .join(", ");
  const resultText = extractResponseText(response);
  return `${shortName}(${inputParts})\n${resultText.slice(0, MAX_OUTPUT)}`;
}

function extractDefault(
  toolName: string,
  input: Record<string, unknown>,
  response: Record<string, unknown>,
): string {
  const inputStr = JSON.stringify(input);
  const resultText = extractResponseText(response);
  return `Tool: ${toolName}\n${inputStr.slice(0, MAX_CONTENT / 2)}\n${resultText.slice(0, MAX_OUTPUT)}`;
}

/**
 * Extract readable text from a tool response, unwrapping common wrapper shapes.
 */
function extractResponseText(response: Record<string, unknown>): string {
  // Direct text field
  if (typeof response.text === "string") return response.text;
  if (typeof response.content === "string") return response.content;

  // Array of content blocks: [{ type: "text", text: "..." }]
  if (Array.isArray(response.content)) {
    return response.content
      .map((block: unknown) => {
        if (typeof block === "object" && block !== null && "text" in block) {
          return String((block as { text: unknown }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // Array at top level (MCP tool results)
  if (Array.isArray(response)) {
    return (response as unknown[])
      .map((item: unknown) => {
        if (typeof item === "object" && item !== null && "text" in item) {
          return String((item as { text: unknown }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  // Fallback: stringify
  return JSON.stringify(response).slice(0, MAX_OUTPUT);
}
