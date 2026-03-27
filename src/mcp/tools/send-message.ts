/**
 * MCP tool: send_message
 *
 * Send a message to another agent. Messages are queued locally
 * and read by the recipient on their next session start.
 *
 * @module send-message
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendMessage } from "../../lib/messaging.js";
import { getActiveAgent } from "../../adapters/claude/active-agent.js";

export function registerSendMessage(server: McpServer): void {
  server.registerTool(
    "send_message",
    {
      title: "Send Message",
      description:
        "Send a message to another agent. Messages are queued and available when the recipient starts their next session.",
      inputSchema: {
        target_agent: z.string().describe("Recipient agent name (e.g., 'yoshi', 'tom', 'exe')"),
        content: z.string().describe("Message content"),
        target_project: z
          .string()
          .optional()
          .describe("Project context (optional)"),
        priority: z
          .enum(["normal", "urgent"])
          .default("normal")
          .describe("Message priority (default: normal)"),
      },
    },
    async ({ target_agent, content, target_project, priority }) => {
      const { agentId } = getActiveAgent();

      const msg = await sendMessage({
        fromAgent: agentId,
        targetAgent: target_agent,
        targetProject: target_project,
        content,
        priority,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Message queued for ${target_agent}. ID: ${msg.id}`,
          },
        ],
      };
    },
  );
}
