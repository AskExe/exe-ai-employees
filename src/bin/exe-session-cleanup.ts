#!/usr/bin/env node
/**
 * exe-session-cleanup — runs after an employee's claude session exits.
 *
 * Can be wired into session launch via ; chaining:
 *   claude --dangerously-skip-permissions; node exe-session-cleanup.js <name>
 *
 * The ; ensures this runs whether claude exits cleanly or crashes.
 * Marks any in_progress tasks as blocked so they're not silently lost.
 */

import { initStore } from "../lib/store.js";
import { getClient } from "../lib/turso.js";

const agentName = process.argv[2];

if (!agentName) process.exit(0);

try {
  await initStore();
  const client = getClient();

  // Find tasks stuck in_progress for this agent
  const result = await client.execute({
    sql: "SELECT id, title FROM tasks WHERE assigned_to = ? AND status = 'in_progress'",
    args: [agentName],
  });

  if (result.rows.length === 0) process.exit(0);

  // Mark them blocked so they can be re-assigned
  const now = new Date().toISOString();
  for (const row of result.rows) {
    await client.execute({
      sql: "UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?",
      args: [now, String(row.id)],
    });
  }

  const count = result.rows.length;
  const taskList = result.rows.map((r) => `"${String(r.title)}"`).join(", ");
  process.stderr.write(
    `[exe-session-cleanup] ${agentName} session ended. ${count} task(s) reset to open: ${taskList}\n`,
  );
} catch {
  // Non-critical — cleanup best-effort only
}

process.exit(0);
