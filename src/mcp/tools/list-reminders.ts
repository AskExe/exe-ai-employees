/**
 * MCP tool: list_reminders
 *
 * @module list-reminders
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listReminders } from "../../lib/reminders.js";

export function registerListReminders(server: McpServer): void {
  server.registerTool(
    "list_reminders",
    {
      title: "List Reminders",
      description: "List active reminders. Pass include_completed=true to see all.",
      inputSchema: {
        include_completed: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include completed reminders"),
      },
    },
    async ({ include_completed }) => {
      const reminders = await listReminders(include_completed);
      if (reminders.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No active reminders." }],
        };
      }

      const lines = reminders.map((r) => {
        const due = r.dueDate ? ` (due: ${r.dueDate})` : "";
        const done = r.completedAt ? " [DONE]" : "";
        return `• ${r.text}${due}${done}  [id: ${r.id.slice(0, 8)}]`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
