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
import { getActiveAgent } from "../../adapters/claude/active-agent.js";

/** Agents allowed to use close_task (reviewers only) */
const CLOSE_TASK_ALLOWED_AGENTS = new Set(["exe", "ea"]);

export function registerCloseTask(server: McpServer): void {
  server.registerTool(
    "close_task",
    {
      title: "Close Task",
      description:
        "Reviewer-only: finalize a task after review. Employees should use update_task with status 'done' instead.",
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
      // Guard: only reviewers (exe, ea) can use close_task
      const agent = getActiveAgent();
      if (agent.agentId && !CLOSE_TASK_ALLOWED_AGENTS.has(agent.agentId)) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `close_task is for reviewers only (exe). ` +
                `Use update_task with status "done" and your result summary to complete your work. ` +
                `This triggers a review task for exe.`,
            },
          ],
          isError: true,
        };
      }

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
