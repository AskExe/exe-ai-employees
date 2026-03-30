/**
 * MCP tool: create_reminder
 *
 * @module create-reminder
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createReminder } from "../../lib/reminders.js";

export function registerCreateReminder(server: McpServer): void {
  server.registerTool(
    "create_reminder",
    {
      title: "Create Reminder",
      description: "Set a reminder for the founder. Shown in the boot brief every session.",
      inputSchema: {
        text: z.string().describe("What to remind about"),
        due_date: z
          .string()
          .optional()
          .describe("Optional due date — ISO date (2026-04-01) or null for persistent"),
      },
    },
    async ({ text, due_date }) => {
      const reminder = await createReminder(text, due_date);
      const dueStr = reminder.dueDate ? ` (due: ${reminder.dueDate})` : "";
      return {
        content: [{ type: "text" as const, text: `Reminder set: "${reminder.text}"${dueStr}` }],
      };
    },
  );
}
