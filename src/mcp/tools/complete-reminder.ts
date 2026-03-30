/**
 * MCP tool: complete_reminder
 *
 * @module complete-reminder
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completeReminder } from "../../lib/reminders.js";

export function registerCompleteReminder(server: McpServer): void {
  server.registerTool(
    "complete_reminder",
    {
      title: "Complete Reminder",
      description: "Mark a reminder as done. Accepts UUID or text substring.",
      inputSchema: {
        reminder_id: z
          .string()
          .describe("Reminder UUID or text substring to match"),
      },
    },
    async ({ reminder_id }) => {
      const reminder = await completeReminder(reminder_id);
      if (!reminder) {
        return {
          content: [{ type: "text" as const, text: `No active reminder matching "${reminder_id}".` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: `Reminder completed: "${reminder.text}"` }],
      };
    },
  );
}
