/**
 * MCP tool: create_task
 *
 * Create a task and assign it to an agent.
 *
 * @module create-task
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTask } from "../../lib/tasks.js";

export function registerCreateTask(server: McpServer): void {
  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description: "Create a task and assign it to an agent.",
      inputSchema: {
        title: z.string().describe("Task title"),
        assigned_to: z.string().describe("Agent name to assign the task to"),
      },
    },
    async ({ title, assigned_to }) => {
      const task = await createTask({ title, assignedTo: assigned_to });

      let text = `Task created: "${task.title}" → ${task.assignedTo}\nID: ${task.id}`;
      if (task.warning) {
        text += `\nWarning: ${task.warning}`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
      };
    },
  );
}
