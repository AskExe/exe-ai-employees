#!/usr/bin/env node
/**
 * exe-session-cleanup — runs after an employee's claude session exits.
 *
 * Can be wired into session launch via ; chaining:
 *   claude --dangerously-skip-permissions; node exe-session-cleanup.js <name>
 *
 * The ; ensures this runs whether claude exits cleanly or crashes.
 *
 * 1. Generates a structured session summary from recent memories
 * 2. Marks any in_progress tasks as open so they're not silently lost
 */

import crypto from "node:crypto";
import { initStore, writeMemory, flushBatch } from "../lib/store.js";
import { getClient } from "../lib/turso.js";
import { getProjectName } from "../lib/project-name.js";

const agentName = process.argv[2];

if (!agentName) process.exit(0);

try {
  await initStore();
  const client = getClient();

  // --- Session Summary ---
  try {
    const memories = await client.execute({
      sql: `SELECT tool_name, project_name, raw_text, has_error, timestamp
            FROM memories
            WHERE agent_id = ?
            ORDER BY timestamp DESC
            LIMIT 50`,
      args: [agentName],
    });

    if (memories.rows.length >= 5) {
      const projects = new Set<string>();
      const tools = new Map<string, number>();
      const errors: string[] = [];
      const files = new Set<string>();
      const tasks: string[] = [];

      for (const row of memories.rows) {
        const project = String(row.project_name ?? "unknown");
        const tool = String(row.tool_name ?? "unknown");
        const rawText = String(row.raw_text ?? "");
        const hasError = (row.has_error as number) === 1;

        projects.add(project);
        tools.set(tool, (tools.get(tool) ?? 0) + 1);

        if (hasError) errors.push(rawText.slice(0, 100));

        const fileMatch = rawText.match(/(?:Wrote|Edited|Read)\s+([^\n]+)/);
        if (fileMatch) files.add(fileMatch[1]!.trim());

        if (tool === "mcp__exe-mem__update_task" && rawText.includes("done")) {
          const titleMatch = rawText.match(/Task.*?["']([^"']+)["']/);
          if (titleMatch) tasks.push(titleMatch[1]!);
        }
      }

      const toolBreakdown = [...tools.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([t, c]) => `${t}(${c})`)
        .join(", ");

      const summaryParts = [
        `Session: ${agentName} | ${new Date().toISOString().split("T")[0]} | ${[...projects].join(", ")}`,
        `Tool calls: ${memories.rows.length} recent — ${toolBreakdown}`,
      ];

      if (tasks.length > 0) summaryParts.push(`Tasks completed: ${tasks.join("; ")}`);
      if (files.size > 0) summaryParts.push(`Files touched: ${[...files].slice(0, 10).join(", ")}`);
      if (errors.length > 0) summaryParts.push(`Errors encountered: ${errors.length}`);

      const summaryText = summaryParts.join("\n");

      let vector: number[] | null = null;
      try {
        const { embed } = await import("../lib/embedder.js");
        vector = await embed(summaryText);
      } catch {
        // Daemon may be down at session end — NULL vector is fine
      }

      await writeMemory({
        id: crypto.randomUUID(),
        agent_id: agentName,
        agent_role: "employee",
        session_id: `cleanup-${Date.now()}`,
        timestamp: new Date().toISOString(),
        tool_name: "SessionSummary",
        project_name: getProjectName(),
        has_error: errors.length > 0,
        raw_text: summaryText,
        vector,
      });
      await flushBatch();
    }
  } catch {
    // Summary is best-effort — don't block cleanup
  }

  // --- Task Cleanup ---
  const result = await client.execute({
    sql: "SELECT id, title FROM tasks WHERE assigned_to = ? AND status = 'in_progress'",
    args: [agentName],
  });

  if (result.rows.length === 0) process.exit(0);

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
