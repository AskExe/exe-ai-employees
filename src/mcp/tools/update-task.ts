/**
 * MCP tool: update_task
 *
 * Update a task's status.
 *
 * @module update-task
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateTask } from "../../lib/tasks.js";

export function registerUpdateTask(server: McpServer): void {
  server.registerTool(
    "update_task",
    {
      title: "Update Task",
      description:
        "Low-level task status update. Prefer close_task for completing work. " +
        "Use this for status transitions like open→in_progress or edge cases.",
      inputSchema: {
        task_id: z.string().describe("Task ID"),
        status: z.enum(["open", "in_progress", "done"]).describe("New status"),
      },
    },
    async ({ task_id, status }) => {
      const updated = await updateTask(task_id, status);

      return {
        content: [
          {
            type: "text" as const,
            text: updated
              ? `Task ${task_id.slice(0, 8)} updated to "${status}".`
              : `Task ${task_id.slice(0, 8)} not found.`,
          },
        ],
      };
    },
  );
}
