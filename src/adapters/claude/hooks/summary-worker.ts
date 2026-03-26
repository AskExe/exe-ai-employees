/**
 * Auto-summary worker — generates a structured summary from recent memories.
 *
 * Spawned by the ingest hook every 25 tool calls (when at least 3 are writes).
 * Reads recent memories from the local DB, groups by tool type, and writes
 * a summary back to memory via store.
 *
 * Environment:
 *   AGENT_ID — who to summarize for
 *   AGENT_ROLE — role label
 *   EXE_SUMMARY_SINCE — tool call count at last summary
 *   EXE_SUMMARY_TOTAL — how many calls in this batch
 *   EXE_SUMMARY_WRITES — how many write-type calls
 *
 * @module summary-worker
 */

import { initStore, writeMemory, flushBatch, vectorToBlob } from "../../../lib/store.js";
import { getClient } from "../../../lib/turso.js";
import crypto from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync } from "node:fs";
import path from "node:path";

async function main(): Promise<void> {
  const agentId = process.env.AGENT_ID ?? "default";
  const agentRole = process.env.AGENT_ROLE ?? "employee";
  const totalCalls = process.env.EXE_SUMMARY_TOTAL ?? "25";
  const writeCalls = process.env.EXE_SUMMARY_WRITES ?? "3";

  await initStore();
  const client = getClient();

  // Fetch the most recent memories for this agent (last 25 tool calls)
  const result = await client.execute({
    sql: `SELECT tool_name, project_name, raw_text, has_error, timestamp
          FROM memories
          WHERE agent_id = ?
          ORDER BY timestamp DESC
          LIMIT 30`,
    args: [agentId],
  });

  if (result.rows.length === 0) return;

  // Group by project
  const projects = new Map<string, { tools: Set<string>; errors: number; samples: string[] }>();

  for (const row of result.rows) {
    const project = (row.project_name as string) || "unknown";
    const tool = (row.tool_name as string) || "unknown";
    const rawText = (row.raw_text as string) || "";
    const hasError = (row.has_error as number) === 1;

    if (!projects.has(project)) {
      projects.set(project, { tools: new Set(), errors: 0, samples: [] });
    }

    const entry = projects.get(project)!;
    entry.tools.add(tool);
    if (hasError) entry.errors++;
    if (entry.samples.length < 3 && rawText.length > 50) {
      entry.samples.push(rawText.slice(0, 150));
    }
  }

  // Build summary text
  const parts: string[] = [];
  parts.push(`Auto-summary: ${totalCalls} tool calls (${writeCalls} writes)`);
  parts.push(`Agent: ${agentId} (${agentRole})`);
  parts.push(`Time: ${new Date().toISOString()}`);
  parts.push("");

  for (const [project, data] of projects) {
    parts.push(`Project: ${project}`);
    parts.push(`  Tools used: ${[...data.tools].join(", ")}`);
    if (data.errors > 0) {
      parts.push(`  Errors encountered: ${data.errors}`);
    }
    for (const sample of data.samples) {
      parts.push(`  - ${sample}`);
    }
    parts.push("");
  }

  const summaryText = parts.join("\n");

  // Detect project name from most common project in recent memories
  let primaryProject = "unknown";
  let maxCount = 0;
  const projectCounts = new Map<string, number>();
  for (const row of result.rows) {
    const p = (row.project_name as string) || "unknown";
    const c = (projectCounts.get(p) ?? 0) + 1;
    projectCounts.set(p, c);
    if (c > maxCount) {
      maxCount = c;
      primaryProject = p;
    }
  }

  // Write summary as a memory record
  await writeMemory({
    id: crypto.randomUUID(),
    agent_id: agentId,
    agent_role: agentRole,
    session_id: `auto-summary-${Date.now()}`,
    timestamp: new Date().toISOString(),
    tool_name: "auto-summary",
    project_name: primaryProject,
    has_error: false,
    raw_text: summaryText,
    vector: null,
  });

  await flushBatch();

  // Try to embed the summary via daemon (non-blocking, best-effort)
  try {
    const { embed } = await import("../../../lib/embedder.js");
    const vector = await embed(summaryText);

    await client.execute({
      sql: "UPDATE memories SET vector = vector32(?) WHERE agent_id = ? AND tool_name = 'auto-summary' ORDER BY timestamp DESC LIMIT 1",
      args: [vectorToBlob(vector), agentId],
    });
  } catch (err) {
    process.stderr.write("[summary-worker] embed failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
  }

  // Check for backfill flag — spawn backfill job if needed
  try {
    const { EXE_AI_DIR } = await import("../../../lib/config.js");
    const flagPath = path.join(EXE_AI_DIR, "session-cache", "needs-backfill");
    if (existsSync(flagPath)) {
      const { spawn } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const thisFile = fileURLToPath(import.meta.url);
      const backfillPath = path.resolve(path.dirname(thisFile), "backfill-vectors.js");
      if (existsSync(backfillPath)) {
        const { EXE_AI_DIR: exeDir2 } = await import("../../../lib/config.js");
        const bLogPath = path.join(exeDir2, "workers.log");
        mkdirSync(path.dirname(bLogPath), { recursive: true });
        const bLogFd = openSync(bLogPath, "a");
        const child = spawn(process.execPath, [backfillPath], {
          detached: true,
          stdio: ["ignore", "ignore", bLogFd],
        });
        child.unref();
        try { closeSync(bLogFd); } catch {}
        process.stderr.write("[summary-worker] Spawned backfill job\n");
      }
    }
  } catch (err) {
    process.stderr.write("[summary-worker] backfill spawn failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write("[summary-worker] FATAL: " + (err instanceof Error ? err.message : String(err)) + "\n");
}).finally(() => {
  process.exit(0);
});
