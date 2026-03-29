/**
 * MCP server entry point with stdio transport.
 *
 * Long-lived process that exposes five memory tools.
 * Embedding is handled by the daemon (exe-daemon.ts) — this server
 * no longer loads the model directly.
 *
 * Tools:
 * - recall_my_memory: search own memories (MCP-01, MCP-02)
 * - ask_team_memory: search colleague's memories (MCP-03)
 * - get_session_context: temporal window around timestamp (MCP-04)
 * - store_memory: manual memory ingestion fallback (MCP-08, INGEST-07)
 * - store_behavior: persist behavioral patterns/corrections
 * - send_message: inter-agent message queue
 *
 * CRITICAL: Never write to stdout -- MCP uses stdout for JSON-RPC (MCP-06).
 * All logging goes to stderr.
 *
 * @module server
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, openSync, mkdirSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disposeEmbedder } from "../lib/embedder.js";
import { initStore, disposeStore } from "../lib/store.js";
import { getClient } from "../lib/turso.js";
import { registerRecallMyMemory } from "./tools/recall-my-memory.js";
import { registerAskTeamMemory } from "./tools/ask-team-memory.js";
import { registerGetSessionContext } from "./tools/get-session-context.js";
import { registerStoreMemory } from "./tools/store-memory.js";
import { registerStoreBehavior } from "./tools/store-behavior.js";
import { registerSendMessage } from "./tools/send-message.js";
import { registerCreateTask } from "./tools/create-task.js";
import { registerListTasks } from "./tools/list-tasks.js";
import { registerUpdateTask } from "./tools/update-task.js";
import { registerCloseTask } from "./tools/close-task.js";

const server = new McpServer({
  name: "exe-memory",
  version: "1.3.0",
});

let _backfillTimer: ReturnType<typeof setInterval> | null = null;

// Register all tools
registerRecallMyMemory(server);
registerAskTeamMemory(server);
registerGetSessionContext(server);
registerStoreMemory(server);
registerStoreBehavior(server);
registerSendMessage(server);
registerCreateTask(server);
registerListTasks(server);
registerUpdateTask(server);
registerCloseTask(server);

try {
  // Initialize store (libSQL + encryption)
  await initStore();

  // Embedding daemon starts lazily on first embed() call — no pre-warm needed.
  // This makes MCP server startup instant instead of 3-8s.

  process.stderr.write("[exe-memory] MCP server starting...\n");

  // Connect with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[exe-memory] MCP server connected.\n");

  // --- Periodic backfill: check for NULL vectors every 5 minutes ---
  const BACKFILL_CHECK_MS = 5 * 60 * 1000;
  _backfillTimer = setInterval(async () => {
    try {
      const client = getClient();
      const result = await client.execute(
        "SELECT COUNT(*) as cnt FROM memories WHERE vector IS NULL",
      );
      const nullCount = Number(result.rows[0]?.cnt) || 0;
      if (nullCount === 0) return;

      process.stderr.write(
        `[exe-memory] Periodic backfill: ${nullCount} NULL vectors — spawning job\n`,
      );
      const thisFile = fileURLToPath(import.meta.url);
      const backfillPath = path.resolve(
        path.dirname(thisFile),
        "../bin/backfill-vectors.js",
      );
      if (existsSync(backfillPath)) {
        const { EXE_AI_DIR: exeDir } = await import("../lib/config.js");
        const logPath = path.join(exeDir, "workers.log");
        mkdirSync(path.dirname(logPath), { recursive: true });
        let logFd: number | "ignore" = "ignore";
        try { logFd = openSync(logPath, "a"); } catch { /* fallback to ignore */ }
        const child = spawn(process.execPath, [backfillPath], {
          detached: true,
          stdio: ["ignore", "ignore", logFd],
        });
        child.unref();
        if (typeof logFd === "number") try { closeSync(logFd); } catch {}
      } else {
        process.stderr.write(`[exe-memory] WARN: backfill-vectors not found at ${backfillPath}\n`);
      }
    } catch (err) {
      process.stderr.write("[exe-memory] periodic backfill check failed: " + (err instanceof Error ? err.message : String(err)) + "\n");
    }
  }, BACKFILL_CHECK_MS);
  _backfillTimer.unref();
} catch (err) {
  process.stderr.write(
    `[exe-memory] FATAL: initialization failed: ${err instanceof Error ? err.message : String(err)}\n`
  );
  process.exit(1);
}

// Graceful shutdown
async function shutdown() {
  if (_backfillTimer) clearInterval(_backfillTimer);
  await disposeStore();
  await disposeEmbedder();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
