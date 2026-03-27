/**
 * Detached worker that embeds user prompts and writes memory records.
 *
 * Spawned by the prompt-submit hook (prompt-submit.ts) as a detached
 * child process. Receives prompt text and metadata via environment vars,
 * generates an embedding via the daemon, and writes to libSQL.
 *
 * Mirrors ingest-worker.ts but stripped to essentials — no task detection,
 * no auto-commit, no notification logic. Just embed + store.
 *
 * @module prompt-ingest-worker
 */

import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getProjectName } from "../../../lib/project-name.js";
import { initStore, writeMemory, flushBatch } from "../../../lib/store.js";

// Mark this process as low-priority for the embedding daemon
process.env.EXE_EMBED_PRIORITY = "low";

async function main(): Promise<void> {
  const promptText = process.env.EXE_PROMPT_TEXT;
  const sessionId = process.env.EXE_SESSION_ID;
  const agentId = process.env.AGENT_ID ?? "default";
  const agentRole = process.env.AGENT_ROLE ?? "employee";

  if (!promptText || !sessionId) {
    process.stderr.write("[prompt-ingest-worker] Missing EXE_PROMPT_TEXT or EXE_SESSION_ID\n");
    process.exit(1);
  }

  // Initialize store (loads crypto key, connects to libSQL)
  await initStore();

  // Embed via daemon — writes NULL vector if daemon unavailable
  let vector: number[] | null;
  let needsBackfill = false;
  try {
    const { embed } = await import("../../../lib/embedder.js");
    vector = await embed(promptText);
  } catch (err) {
    process.stderr.write(`[prompt-ingest-worker] EMBED FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    vector = null;
    needsBackfill = true;
  }

  // Write memory record with tool_name "UserPrompt"
  await writeMemory({
    id: crypto.randomUUID(),
    agent_id: agentId,
    agent_role: agentRole,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    tool_name: "UserPrompt",
    project_name: getProjectName(),
    has_error: false,
    raw_text: promptText,
    vector,
  });

  // Worker is short-lived — flush immediately
  await flushBatch();

  // Touch backfill flag so the backfill job knows there are NULL vectors
  if (needsBackfill) {
    try {
      const { EXE_AI_DIR: exeDir } = await import("../../../lib/config.js");
      const flagPath = path.join(exeDir, "session-cache", "needs-backfill");
      writeFileSync(flagPath, "1");
    } catch (err) {
      process.stderr.write(`[prompt-ingest-worker] backfill flag write failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[prompt-ingest-worker] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
}).finally(() => {
  process.exit(0);
});
