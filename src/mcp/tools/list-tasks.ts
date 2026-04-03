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
import { getProjectName } from "../../lib/project-name.js";

export function registerListTasks(server: McpServer): void {
  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description: "Query tasks by assignee, status, or project. Defaults to current project. Pass project_name='all' for all projects.",
      inputSchema: {
        assigned_to: z.string().optional().describe("Filter by agent name"),
        status: z
          .enum(["open", "in_progress", "done", "blocked", "cancelled"])
          .optional()
          .describe("Filter by status"),
        project_name: z.string().optional().describe("Project name. Defaults to current project. Pass 'all' for all projects."),
      },
    },
    async ({ assigned_to, status, project_name }) => {
      const resolvedProject =
        project_name === "all" ? undefined : (project_name ?? getProjectName());

      const tasks = await listTasks({
        assignedTo: assigned_to,
        status,
        projectName: resolvedProject,
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
