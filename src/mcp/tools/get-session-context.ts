/**
 * MCP tool: get_session_context
 *
 * Retrieves memories surrounding a specific point in a session.
 * Returns a window of memories before and after the target timestamp.
 *
 * Requirement: MCP-04
 *
 * @module get-session-context
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../../lib/turso.js";
import type { MemoryRecord } from "../../types/memory.js";

/**
 * Register the get_session_context tool with an MCP server.
 */
export function registerGetSessionContext(server: McpServer): void {
  server.registerTool(
    "get_session_context",
    {
      title: "Get Session Context",
      description:
        "Retrieve memories surrounding a specific point in a session. Returns memories before and after the target timestamp.",
      inputSchema: {
        session_id: z.string().describe("Session ID to query"),
        target_timestamp: z
          .string()
          .describe(
            "ISO 8601 timestamp to center the context window around",
          ),
        window_size: z
          .number()
          .optional()
          .default(3)
          .describe("Number of memories before and after the target"),
      },
    },
    async ({ session_id, target_timestamp, window_size }) => {
      const client = getClient();

      // Query all memories for this session — plaintext columns (SQLCipher decrypts in RAM)
      const result = await client.execute({
        sql: `SELECT id, agent_id, agent_role, session_id, timestamp,
                     tool_name, project_name,
                     has_error, raw_text, vector, task_id
              FROM memories
              WHERE session_id = ?
              ORDER BY timestamp ASC`,
        args: [session_id],
      });

      if (result.rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No memories found for session '${session_id}'.`,
            },
          ],
        };
      }

      // Map rows directly to MemoryRecord — no decryption needed
      const sorted: MemoryRecord[] = result.rows.map((row) => ({
        id: row.id as string,
        agent_id: row.agent_id as string,
        agent_role: row.agent_role as string,
        session_id: row.session_id as string,
        timestamp: row.timestamp as string,
        tool_name: row.tool_name as string,
        project_name: row.project_name as string,
        has_error: (row.has_error as number) === 1,
        raw_text: row.raw_text as string,
        vector: row.vector == null
          ? []
          : Array.isArray(row.vector)
            ? row.vector
            : Array.from(row.vector as unknown as Float32Array),
        task_id: (row.task_id as string) ?? null,
      }));

      // Find index of memory closest to target_timestamp
      let targetIdx = sorted.findIndex(
        (m) => m.timestamp >= target_timestamp,
      );
      if (targetIdx === -1) {
        targetIdx = sorted.length;
      }

      // Slice window around target
      const start = Math.max(0, targetIdx - window_size);
      const end = Math.min(sorted.length, targetIdx + window_size + 1);
      const windowMemories = sorted.slice(start, end);

      const formatted = windowMemories
        .map(
          (r) =>
            `[${r.timestamp}] ${r.tool_name} (${r.project_name})${r.has_error ? " [ERROR]" : ""}\n${r.raw_text.slice(0, 500)}`,
        )
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Session context (${windowMemories.length} memories around ${target_timestamp}):\n\n${formatted}`,
          },
        ],
      };
    },
  );
}
