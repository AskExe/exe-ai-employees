/**
 * MCP tool: list_tasks
 *
 * List tasks filtered by assignee or status.
 *
 * @module list-tasks
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listTasks } from "../../lib/tasks.js";

export function registerListTasks(server: McpServer): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description: "List tasks, optionally filtered by assignee or status.",
      inputSchema: {
        assigned_to: z.string().optional().describe("Filter by agent name"),
        status: z.enum(["open", "in_progress", "done"]).optional().describe("Filter by status"),
      },
    },
    async ({ assigned_to, status }) => {
      const tasks = await listTasks({
        assignedTo: assigned_to,
        status,
      });

      if (tasks.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No tasks found." }],
        };
      }

      const lines = tasks.map(
        (t) => `- [${t.status}] ${t.title} → ${t.assignedTo} (${t.id.slice(0, 8)})`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `${tasks.length} task(s):\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );
}
