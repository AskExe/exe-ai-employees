/**
 * Detached worker that embeds assistant responses and writes memory records.
 *
 * Spawned by the stop hook (stop.ts) as a detached child process.
 * Receives response text and metadata via environment vars,
 * generates an embedding via the daemon, and writes to libSQL.
 *
 * Mirrors prompt-ingest-worker.ts for assistant-side capture.
 *
 * @module response-ingest-worker
 */

import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getProjectName } from "../../../lib/project-name.js";
import { initStore, writeMemory, flushBatch } from "../../../lib/store.js";

// Mark this process as low-priority for the embedding daemon
process.env.EXE_EMBED_PRIORITY = "low";

const MIN_LENGTH = 100;

async function main(): Promise<void> {
  const responseText = process.env.EXE_RESPONSE_TEXT;
  const sessionId = process.env.EXE_SESSION_ID;
  const agentId = process.env.AGENT_ID ?? "default";
  const agentRole = process.env.AGENT_ROLE ?? "employee";

  if (!responseText || !sessionId) {
    process.stderr.write("[response-ingest-worker] Missing EXE_RESPONSE_TEXT or EXE_SESSION_ID\n");
    process.exit(1);
  }

  // Double-check length filter (stop.ts also checks, but belt-and-suspenders)
  if (responseText.length < MIN_LENGTH) {
    process.exit(0);
  }

  await initStore();

  let vector: number[] | null;
  let needsBackfill = false;
  try {
    const { embed } = await import("../../../lib/embedder.js");
    vector = await embed(responseText);
  } catch (err) {
    process.stderr.write(`[response-ingest-worker] EMBED FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    vector = null;
    needsBackfill = true;
  }

  await writeMemory({
    id: crypto.randomUUID(),
    agent_id: agentId,
    agent_role: agentRole,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    tool_name: "AssistantResponse",
    project_name: getProjectName(),
    has_error: false,
    raw_text: responseText,
    vector,
  });

  await flushBatch();

  if (needsBackfill) {
    try {
      const { EXE_AI_DIR: exeDir } = await import("../../../lib/config.js");
      const flagPath = path.join(exeDir, "session-cache", "needs-backfill");
      writeFileSync(flagPath, "1");
    } catch (err) {
      process.stderr.write(`[response-ingest-worker] backfill flag write failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`[response-ingest-worker] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
}).finally(() => {
  process.exit(0);
});
