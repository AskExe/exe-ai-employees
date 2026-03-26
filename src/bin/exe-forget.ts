#!/usr/bin/env node
/**
 * /exe:forget CLI — delete memories by ID, agent, or search query.
 *
 * Usage:
 *   exe-forget --id <memory-id>      — delete one memory
 *   exe-forget --agent <name>        — delete all memories for an agent
 *   exe-forget --query "<search>"    — delete memories matching a search
 *
 * All deletions require confirmation.
 *
 * @module exe-forget
 */

import { createInterface } from "node:readline";
import { initStore } from "../lib/store.js";
import { getClient } from "../lib/turso.js";
import { lightweightSearch } from "../lib/hybrid-search.js";
import { isMainModule } from "../lib/is-main.js";

function confirm(rl: ReturnType<typeof createInterface>, msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${msg} [y/N]: `, (answer) => {
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage:");
    console.error('  exe-forget --id <memory-id>      Delete a single memory');
    console.error('  exe-forget --agent <name>        Delete all memories for an employee');
    console.error('  exe-forget --query "<search>"    Delete memories matching a search');
    process.exit(1);
  }

  const flag = args[0];
  const value = args.slice(1).join(" ");

  // Safety: require a real terminal — block execution from Claude Code hooks/agents
  if (!process.stdin.isTTY) {
    console.error("Error: /exe:forget must be run directly in your terminal, not through an AI agent.");
    console.error("This is a destructive operation that requires human confirmation.");
    console.error("\nRun it yourself:");
    console.error("  node \"$(npm root -g)/exe-os/dist/bin/exe-forget.js\" --id <id>");
    console.error("  node \"$(npm root -g)/exe-os/dist/bin/exe-forget.js\" --agent <name>");
    console.error("  node \"$(npm root -g)/exe-os/dist/bin/exe-forget.js\" --query \"<search>\"");
    process.exit(1);
  }

  await initStore();
  const client = getClient();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    if (flag === "--id") {
      // Delete by ID
      const check = await client.execute({
        sql: "SELECT id, agent_id, tool_name, timestamp FROM memories WHERE id = ?",
        args: [value],
      });

      if (check.rows.length === 0) {
        // Fallback: check behaviors table
        let behaviorCheck;
        try {
          behaviorCheck = await client.execute({
            sql: "SELECT id, agent_id, domain, content FROM behaviors WHERE id = ?",
            args: [value],
          });
        } catch {
          behaviorCheck = { rows: [] };
        }

        if (behaviorCheck.rows.length === 0) {
          console.error(`No memory or behavior found with ID: ${value}`);
          process.exit(1);
        }

        const brow = behaviorCheck.rows[0]!;
        console.log(`[behavior] [${brow.domain ?? "no domain"}] ${brow.content} (agent: ${brow.agent_id})`);

        if (await confirm(rl, "Delete this behavior?")) {
          await client.execute({ sql: "DELETE FROM behaviors WHERE id = ?", args: [value] });
          console.log("Deleted.");
        } else {
          console.log("Cancelled.");
        }
      } else {

      const row = check.rows[0]!;
      console.log(`Memory: [${row.timestamp}] ${row.tool_name} (agent: ${row.agent_id})`);

      if (await confirm(rl, "Delete this memory?")) {
        await client.execute({ sql: "DELETE FROM memories WHERE id = ?", args: [value] });
        console.log("Deleted.");
      } else {
        console.log("Cancelled.");
      }
      }
    } else if (flag === "--agent") {
      // Delete all memories for an agent
      const count = await client.execute({
        sql: "SELECT COUNT(*) as cnt FROM memories WHERE agent_id = ?",
        args: [value],
      });
      const total = Number(count.rows[0]?.cnt ?? 0);

      if (total === 0) {
        console.error(`No memories found for agent: ${value}`);
        process.exit(1);
      }

      console.log(`Found ${total} memories for agent "${value}".`);
      console.log(`\nThis will permanently delete ALL memories for this employee.`);

      const typed = await new Promise<string>((resolve) => {
        rl.question(`Type the agent name "${value}" to confirm: `, (answer) => {
          resolve(answer.trim());
        });
      });

      if (typed !== value) {
        console.log("Name didn't match. Cancelled.");
      } else {
        await client.execute({ sql: "DELETE FROM memories WHERE agent_id = ?", args: [value] });
        console.log(`Deleted ${total} memories for "${value}".`);
      }
    } else if (flag === "--query") {
      // Delete memories matching a search
      const agentId = process.env.AGENT_ID;
      if (!agentId) {
        console.error("No AGENT_ID set. Run this inside an employee session.");
        process.exit(1);
      }

      const matches = await lightweightSearch(value, agentId, { limit: 20 });

      // Also search behaviors
      let behaviorMatches: Array<{ id: string; domain: string | null; content: string }> = [];
      try {
        const bResult = await client.execute({
          sql: `SELECT id, domain, content FROM behaviors
                WHERE agent_id = ? AND active = 1 AND content LIKE '%' || ? || '%'`,
          args: [agentId, value],
        });
        behaviorMatches = bResult.rows.map((r) => ({
          id: String(r.id),
          domain: r.domain ? String(r.domain) : null,
          content: String(r.content),
        }));
      } catch {
        // Behaviors table may not exist
      }

      if (matches.length === 0 && behaviorMatches.length === 0) {
        console.log("No memories or behaviors matched the query.");
        process.exit(0);
      }

      if (matches.length > 0) {
        console.log(`Found ${matches.length} matching memories:\n`);
        for (const m of matches) {
          console.log(`  [${m.timestamp}] ${m.tool_name}: ${m.raw_text.slice(0, 100)}`);
          console.log(`  ID: ${m.id}\n`);
        }
      }

      if (behaviorMatches.length > 0) {
        console.log(`Found ${behaviorMatches.length} matching behaviors:\n`);
        for (const b of behaviorMatches) {
          console.log(`  [behavior] [${b.domain ?? "no domain"}] ${b.content}`);
          console.log(`  ID: ${b.id}\n`);
        }
      }

      const totalCount = matches.length + behaviorMatches.length;
      if (await confirm(rl, `Delete these ${totalCount} items?`)) {
        if (matches.length > 0) {
          const ids = matches.map((m) => m.id);
          const placeholders = ids.map(() => "?").join(",");
          await client.execute({
            sql: `DELETE FROM memories WHERE id IN (${placeholders})`,
            args: ids,
          });
        }
        if (behaviorMatches.length > 0) {
          const bIds = behaviorMatches.map((b) => b.id);
          const bPlaceholders = bIds.map(() => "?").join(",");
          await client.execute({
            sql: `DELETE FROM behaviors WHERE id IN (${bPlaceholders})`,
            args: bIds,
          });
        }
        console.log(`Deleted ${totalCount} items.`);
      } else {
        console.log("Cancelled.");
      }
    } else {
      console.error(`Unknown flag: ${flag}. Use --id, --agent, or --query.`);
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { main };
