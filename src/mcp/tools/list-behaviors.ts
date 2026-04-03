/**
 * MCP tool: list_behaviors
 *
 * Query stored behavioral memories by agent, domain, project.
 * Behaviors are normally injected at session start, but this tool
 * lets users query them mid-session.
 *
 * @module list-behaviors
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../../lib/turso.js";
import { getActiveAgent } from "../../adapters/claude/active-agent.js";
import { getProjectName } from "../../lib/project-name.js";
import type { Behavior } from "../../lib/behaviors.js";

function rowToBehavior(r: Record<string, unknown>): Behavior {
  return {
    id: String(r.id),
    agent_id: String(r.agent_id),
    project_name: r.project_name ? String(r.project_name) : null,
    domain: r.domain ? String(r.domain) : null,
    content: String(r.content),
    active: Number(r.active),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

export function registerListBehaviors(server: McpServer): void {
  server.registerTool(
    "list_behaviors",
    {
      title: "List Behaviors",
      description:
        "Query stored behavioral patterns and corrections. " +
        "Useful for reviewing what rules are active for an agent mid-session.",
      inputSchema: {
        agent_id: z
          .string()
          .optional()
          .describe("Agent name. Defaults to current agent. Pass 'all' to see everyone's."),
        domain: z
          .string()
          .optional()
          .describe("Filter by domain: workflow, code-style, tool-use, communication, architecture, testing"),
        project_name: z
          .string()
          .optional()
          .describe("Filter by project. Defaults to current project + global behaviors."),
      },
    },
    async ({ agent_id, domain, project_name }) => {
      const client = getClient();
      const conditions: string[] = ["active = 1"];
      const args: (string | number)[] = [];

      // Agent filter
      if (agent_id !== "all") {
        const resolvedAgent = agent_id ?? getActiveAgent().agentId;
        conditions.push("agent_id = ?");
        args.push(resolvedAgent);
      }

      // Domain filter
      if (domain) {
        conditions.push("domain = ?");
        args.push(domain);
      }

      // Project filter: include global (NULL) + specific project
      if (project_name) {
        conditions.push("(project_name IS NULL OR project_name = ?)");
        args.push(project_name);
      } else if (!agent_id || agent_id !== "all") {
        // Default: current project + global
        const proj = getProjectName();
        conditions.push("(project_name IS NULL OR project_name = ?)");
        args.push(proj);
      }

      const where = conditions.join(" AND ");
      const result = await client.execute({
        sql: `SELECT id, agent_id, project_name, domain, content, active, created_at, updated_at
              FROM behaviors
              WHERE ${where}
              ORDER BY agent_id, domain, updated_at DESC
              LIMIT 50`,
        args,
      });

      const behaviors = result.rows.map((r) => rowToBehavior(r as Record<string, unknown>));

      if (behaviors.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No behaviors found." }],
        };
      }

      const lines = behaviors.map((b) => {
        const scope = b.project_name ?? "global";
        const dom = b.domain ?? "general";
        return `- [${b.agent_id}] [${dom}] (${scope}) ${b.content}  \n  ID: ${b.id}`;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `${behaviors.length} behavior(s):\n${lines.join("\n")}`,
          },
        ],
      };
    },
  );
}
