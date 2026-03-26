/**
 * Detached worker that embeds tool output and writes memory records.
 *
 * Spawned by the ingest hook (ingest.ts) as a detached child process.
 * Reads the full PostToolUse payload from stdin, builds raw_text,
 * generates an embedding via the daemon, and writes to libSQL.
 *
 * The embedding daemon (embed-daemon.ts) holds the single model instance.
 * This worker just sends text over a Unix socket — no model loading,
 * no GPU allocation, no file locks.
 *
 * @module ingest-worker
 */

import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { PostToolUsePayload } from "../../../types/hook-payload.js";
import { detectError } from "../../../lib/error-detector.js";
import { getProjectName } from "../../../lib/project-name.js";
import { initStore, writeMemory, flushBatch } from "../../../lib/store.js";
import { extractSemanticText } from "../../../lib/content-extractor.js";

// Mark this process as low-priority for the embedding daemon
process.env.EXE_EMBED_PRIORITY = "low";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(input) as PostToolUsePayload;

    // Extract semantic content for embedding + FTS (not raw JSON noise)
    const rawText = extractSemanticText(data.tool_name, data.tool_input, data.tool_response);

    // Skip payloads that are too short to be useful
    if (rawText.length < 50) {
      process.exit(0);
    }

    // Initialize store (loads crypto key, connects to libSQL)
    await initStore();

    // Embed via daemon — writes NULL vector if daemon unavailable (backfill job fixes later)
    let vector: number[] | null;
    let needsBackfill = false;
    try {
      const { embed } = await import("../../../lib/embedder.js");
      vector = await embed(rawText);
    } catch (err) {
      // Daemon unavailable — write with NULL vector, NOT zero-vector
      // FTS search still works on raw_text. Backfill job will fix the vector later.
      process.stderr.write(`[ingest-worker] EMBED FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
      vector = null;
      needsBackfill = true;
    }

    // Write memory record
    await writeMemory({
      id: crypto.randomUUID(),
      agent_id: process.env.AGENT_ID!,
      agent_role: process.env.AGENT_ROLE ?? "unknown",
      session_id: data.session_id,
      timestamp: new Date().toISOString(),
      tool_name: data.tool_name,
      project_name: getProjectName(data.cwd ?? process.cwd()),
      has_error: detectError(data),
      raw_text: rawText,
      vector,
    });

    // Worker is short-lived -- flush immediately
    await flushBatch();

    // Touch backfill flag so the backfill job knows there are NULL vectors
    if (needsBackfill) {
      try {
        const { EXE_AI_DIR: exeDir } = await import("../../../lib/config.js");
        const flagPath = path.join(exeDir, "session-cache", "needs-backfill");
        writeFileSync(flagPath, "1");
      } catch (err) {
        process.stderr.write(`[ingest-worker] backfill flag write failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`[ingest-worker] FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(0);
});
