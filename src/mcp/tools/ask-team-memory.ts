/**
 * MCP tool: ask_team_memory
 *
 * Searches another employee's memories by agent name. Does not return
 * the querying employee's own records -- uses the target employee's
 * agent_id as the partition filter.
 *
 * Requirement: MCP-03
 *
 * @module ask-team-memory
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hybridSearch } from "../../lib/hybrid-search.js";

/**
 * Register the ask_team_memory tool with an MCP server.
 */
export function registerAskTeamMemory(server: McpServer): void {
  server.registerTool(
    "ask_team_memory",
    {
      title: "Ask Team Memory",
      description:
        "Search another employee's memories. Use this to find what a team member worked on, learned, or solved.",
      inputSchema: {
        team_member: z
          .string()
          .describe(
            "Name of the team member to query (e.g., 'yoshi', 'mari', 'gen')",
          ),
        query: z.string().describe("What to search for"),
        project_name: z.string().optional().describe("Filter by project name"),
        limit: z.coerce
          .number()
          .optional()
          .default(10)
          .describe("Max results to return"),
      },
    },
    async ({ team_member, query, project_name, limit }) => {
      // Search the team member's partition, not the querying agent's
      const results = await hybridSearch(query, team_member, {
        projectName: project_name,
        limit,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No memories found for team member '${team_member}'.`,
            },
          ],
        };
      }

      const formatted = results
        .map(
          (r) =>
            `[${r.timestamp}] ${r.tool_name} (${r.project_name})${r.has_error ? " [ERROR]" : ""}\n${r.raw_text.slice(0, 500)}`,
        )
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `From ${team_member}'s memories (${results.length} results):\n\n${formatted}`,
          },
        ],
      };
    },
  );
}
