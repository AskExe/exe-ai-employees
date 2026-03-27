/**
 * MCP tool: recall_my_memory
 *
 * Searches the current employee's past work memories using hybrid search
 * (BM25 full-text + vector similarity with RRF reranking).
 *
 * Requirements: MCP-01, MCP-02
 *
 * @module recall-my-memory
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hybridSearch } from "../../lib/hybrid-search.js";
import { getActiveAgent } from "../../adapters/claude/active-agent.js";

/**
 * Register the recall_my_memory tool with an MCP server.
 */
export function registerRecallMyMemory(server: McpServer): void {
  server.registerTool(
    "recall_my_memory",
    {
      title: "Recall My Memory",
      description:
        "Search your past work memories using semantic search. Returns relevant past tool calls, outputs, and decisions.",
      inputSchema: {
        query: z
          .string()
          .describe("What to search for in your memories"),
        project_name: z
          .string()
          .optional()
          .describe("Filter by project name"),
        has_error: z
          .boolean()
          .optional()
          .describe("Filter for error-containing memories"),
        tool_name: z
          .string()
          .optional()
          .describe("Filter by tool name (Bash, Write, etc)"),
        limit: z.coerce
          .number()
          .optional()
          .default(10)
          .describe("Max results to return"),
        since: z
          .string()
          .optional()
          .describe("ISO 8601 timestamp — only return memories at or after this time"),
      },
    },
    async ({ query, project_name, has_error, tool_name, limit, since }) => {
      const { agentId } = getActiveAgent();

      const results = await hybridSearch(query, agentId, {
        projectName: project_name,
        hasError: has_error,
        toolName: tool_name,
        limit,
        since,
      });

      if (results.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No matching memories found." },
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
            text: `Found ${results.length} memories:\n\n${formatted}`,
          },
        ],
      };
    },
  );
}
