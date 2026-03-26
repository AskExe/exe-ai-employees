/**
 * MCP tool: store_memory
 *
 * Manually stores a memory with custom text and metadata.
 * Fallback path when automatic hook ingestion doesn't fire.
 *
 * Requirements: MCP-08, INGEST-07
 *
 * @module store-memory
 */

import { z } from "zod";
import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { embed } from "../../lib/embedder.js";
import { writeMemory, flushBatch } from "../../lib/store.js";
import { getActiveAgent } from "../../adapters/claude/active-agent.js";

/**
 * Register the store_memory tool with an MCP server.
 */
export function registerStoreMemory(server: McpServer): void {
  server.registerTool(
    "store_memory",
    {
      title: "Store Memory",
      description:
        "Manually store a memory. Use this as a fallback when automatic hook ingestion doesn't fire, or to store important context explicitly.",
      inputSchema: {
        text: z.string().optional().describe("The memory text to store"),
        query: z
          .string()
          .optional()
          .describe("Alias for text (accepts either)"),
        tool_name: z
          .string()
          .optional()
          .default("manual")
          .describe("Tool name to associate"),
        project_name: z
          .string()
          .optional()
          .describe("Project name"),
        has_error: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether this memory is error-related"),
      },
    },
    async ({ text, query, tool_name, project_name, has_error }) => {
      const resolvedText = text ?? query;
      if (!resolvedText) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: provide either 'text' or 'query' parameter.",
            },
          ],
          isError: true,
        };
      }
      const { agentId, agentRole } = getActiveAgent();

      let vector: number[] | null;
      let needsBackfill = false;
      try {
        vector = await embed(resolvedText);
      } catch {
        // Daemon unavailable — store with NULL vector, backfill will fix later
        vector = null;
        needsBackfill = true;
      }

      const memoryId = crypto.randomUUID();

      await writeMemory({
        id: memoryId,
        agent_id: agentId,
        agent_role: agentRole,
        session_id: process.env.SESSION_ID ?? "manual",
        timestamp: new Date().toISOString(),
        tool_name,
        project_name: project_name ?? "unknown",
        has_error,
        raw_text: resolvedText,
        vector,
      });

      await flushBatch();

      if (needsBackfill) {
        try {
          const { EXE_AI_DIR: exeDir } = await import("../../lib/config.js");
          const flagPath = path.join(exeDir, "session-cache", "needs-backfill");
          writeFileSync(flagPath, "1");
        } catch {
          // Best-effort — backfill cron will still pick up NULL vectors
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Memory stored successfully. ID: ${memoryId}`,
          },
        ],
      };
    },
  );
}
