#!/usr/bin/env node
/**
 * Backfill NULL vectors in the memories table.
 *
 * Queries memories with NULL vectors, embeds them via the daemon,
 * and updates the rows. Runs in batches of 100 until no NULLs remain.
 *
 * Run modes:
 * - CLI: `node dist/bin/backfill-vectors.js` — processes all NULLs
 * - Auto: triggered by backfill flag file from ingest-worker
 * - Boot: exe-boot.ts checks NULL count and spawns this in background
 *
 * @module backfill-vectors
 */

import { initStore, vectorToBlob } from "../lib/store.js";
import { getClient } from "../lib/turso.js";
import { connectEmbedDaemon, embedViaClient } from "../lib/exe-daemon-client.js";
import { EXE_AI_DIR } from "../lib/config.js";
import { isMainModule } from "../lib/is-main.js";
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";

const BATCH_SIZE = 100;
const BACKFILL_FLAG = path.join(EXE_AI_DIR, "session-cache", "needs-backfill");

export async function backfillVectors(): Promise<{ processed: number; failed: number; remaining: number }> {
  await initStore();

  // Connect to daemon — required for embedding
  const connected = await connectEmbedDaemon();
  if (!connected) {
    process.stderr.write("[backfill] Cannot connect to embedding daemon — aborting\n");
    return { processed: 0, failed: 0, remaining: -1 };
  }

  const client = getClient();
  let totalProcessed = 0;
  let totalFailed = 0;

  // Process in batches
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch = await client.execute({
      sql: "SELECT id, raw_text FROM memories WHERE vector IS NULL LIMIT ?",
      args: [BATCH_SIZE],
    });

    if (batch.rows.length === 0) break;

    process.stderr.write(`[backfill] Processing batch of ${batch.rows.length} memories...\n`);

    for (const row of batch.rows) {
      const id = row.id as string;
      const rawText = row.raw_text as string;

      try {
        const vector = await embedViaClient(rawText, "low");
        if (!vector) {
          totalFailed++;
          process.stderr.write(`[backfill] Failed to embed memory ${id} — daemon returned null\n`);
          continue;
        }

        await client.execute({
          sql: "UPDATE memories SET vector = vector32(?) WHERE id = ?",
          args: [vectorToBlob(vector), id],
        });
        totalProcessed++;
      } catch (err) {
        totalFailed++;
        process.stderr.write(`[backfill] Error embedding ${id}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    process.stderr.write(`[backfill] Batch done. Processed: ${totalProcessed}, Failed: ${totalFailed}\n`);
  }

  // Check remaining
  const remaining = await client.execute({
    sql: "SELECT COUNT(*) as cnt FROM memories WHERE vector IS NULL",
    args: [],
  });
  const remainingCount = Number(remaining.rows[0]?.cnt) || 0;

  // Clear backfill flag if no NULLs remain
  if (remainingCount === 0) {
    try { unlinkSync(BACKFILL_FLAG); } catch { /* may not exist */ }
  }

  process.stderr.write(`[backfill] Complete. Processed: ${totalProcessed}, Failed: ${totalFailed}, Remaining: ${remainingCount}\n`);

  return { processed: totalProcessed, failed: totalFailed, remaining: remainingCount };
}

/**
 * Check if backfill is needed (flag file exists or NULL vectors in DB).
 */
export function isBackfillNeeded(): boolean {
  return existsSync(BACKFILL_FLAG);
}

if (isMainModule(import.meta.url)) {
  backfillVectors()
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(result.failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("Backfill failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
