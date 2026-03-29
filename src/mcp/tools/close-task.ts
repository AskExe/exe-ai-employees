/**
 * MCP tool: close_task
 *
 * The standard way to finish a task. Wraps updateTask(done) with
 * a simpler interface — just task_id and result.
 *
 * @module close-task
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateTask } from "../../lib/tasks.js";

export function registerCloseTask(server: McpServer): void {
  server.registerTool(
    "close_task",
    {
      title: "Close Task",
      description:
        "Mark a task as complete with your result summary. This is the standard way to finish work.",
      inputSchema: {
        task_id: z.string().describe("Task UUID"),
        result: z
          .string()
          .describe("What was done — specific deliverables, decisions, test results"),
        status: z
          .enum(["done", "blocked", "cancelled"])
          .optional()
          .default("done")
          .describe("Completion status (default: done)"),
      },
    },
    async ({ task_id, result, status }) => {
      const updated = await updateTask(task_id, status);

      return {
        content: [
          {
            type: "text" as const,
            text: updated
              ? `Task ${task_id.slice(0, 8)} marked ${status}.\nResult: ${result}`
              : `Task ${task_id.slice(0, 8)} not found.`,
          },
        ],
      };
    },
  );
}
