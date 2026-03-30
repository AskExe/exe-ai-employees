/**
 * MCP tool: store_behavior
 *
 * Stores a behavioral pattern or correction for an employee.
 * Persists across sessions and projects.
 *
 * @module store-behavior
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { storeBehavior, listBehaviorsByDomain } from "../../lib/behaviors.js";
import { getActiveAgent } from "../../adapters/claude/active-agent.js";
import { getProjectName } from "../../lib/project-name.js";

export function registerStoreBehavior(server: McpServer): void {
  server.registerTool(
    "store_behavior",
    {
      title: "Store Behavior",
      description:
        "Store a behavioral pattern or correction for an employee. Persists across sessions and projects.",
      inputSchema: {
        content: z.string().max(500).describe("The behavioral instruction — one clear sentence"),
        domain: z.string().optional().describe("Category: workflow, code-style, tool-use, communication, architecture, testing"),
        agent_id: z.string().optional().describe("Employee name. Defaults to current agent."),
        project_name: z.string().optional().describe("Defaults to current project. Pass 'global' for a behavior that applies everywhere."),
      },
    },
    async ({ content, domain, agent_id, project_name }) => {
      const resolvedAgent = agent_id ?? getActiveAgent().agentId;

      // Auto-detect project unless explicitly global or overridden
      let resolvedProject: string | undefined;
      if (project_name === "global" || project_name === null) {
        resolvedProject = undefined; // global behavior
      } else if (project_name) {
        resolvedProject = project_name; // explicit override
      } else {
        resolvedProject = getProjectName(); // auto-detect from cwd
      }

      const id = await storeBehavior({
        agentId: resolvedAgent,
        content,
        domain: domain ?? undefined,
        projectName: resolvedProject,
      });

      let responseText = `Behavior stored for ${resolvedAgent}. ID: ${id}`;

      // Check for existing behaviors in the same domain
      if (domain) {
        const existing = await listBehaviorsByDomain(resolvedAgent, domain);
        // Exclude the one we just created
        const others = existing.filter((b) => b.id !== id);
        if (others.length > 0) {
          const list = others.map((b) => `  - [${b.id}] ${b.content}`).join("\n");
          responseText += `\n\nExisting behaviors in [${domain}] domain:\n${list}\nUse /exe:forget to remove any that this supersedes.`;
        }
      }

      return {
        content: [{ type: "text" as const, text: responseText }],
      };
    },
  );
}
