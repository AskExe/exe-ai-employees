/**
 * MCP tool: update_task
 *
 * Update a task's status.
 *
 * @module update-task
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateTask, resolveTask } from "../../lib/tasks.js";

export function registerUpdateTask(server: McpServer): void {
  server.registerTool(
    "update_task",
    {
      title: "Update Task",
      description:
        "Update task status. Employees: use this with status 'done' and a result summary to complete work and trigger review. " +
        "Accepts UUID, slug (filename), or title substring.",
      inputSchema: {
        task_id: z
          .string()
          .describe("Task identifier — UUID, slug (e.g. 'fix-auth-bug'), or title substring"),
        status: z
          .enum(["open", "in_progress", "done", "blocked", "cancelled"])
          .describe("New status"),
        result: z
          .string()
          .optional()
          .describe("Result summary (include when status=done)"),
      },
    },
    async ({ task_id, status, result }) => {
      try {
        const task = await resolveTask(task_id);
        const updated = await updateTask(task.id, status);

        let text = updated
          ? `Task "${task.title}" marked ${status}.`
          : `Task "${task.title}" update failed.`;
        if (result) text += `\nResult: ${result}`;

        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : String(err),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
