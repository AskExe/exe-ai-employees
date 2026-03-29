/**
 * Stop hook — captures assistant response text as memory records.
 *
 * Fires after every assistant response. Spawns a detached worker to
 * embed and store the response. Keeps the hot path fast — no LLM calls,
 * no DB queries, just parse + spawn + exit.
 *
 * Filter: responses under 100 chars are skipped (noise like "Done.", "OK").
 *
 * @module stop
 */

// Default AGENT_ID if not set
if (!process.env.AGENT_ID) {
  process.env.AGENT_ID = "default";
  process.env.AGENT_ROLE = "employee";
}

// Guard: skip if auto-ingestion is disabled
import { loadConfigSync } from "../../../lib/config.js";
if (!loadConfigSync().autoIngestion) {
  process.exit(0);
}

import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StopPayload } from "../../../types/hook-payload.js";
import { EXE_AI_DIR } from "../../../lib/config.js";
import { getActiveAgent } from "../active-agent.js";

const WORKER_LOG_PATH = path.join(EXE_AI_DIR, "workers.log");

function openWorkerLog(): number | "ignore" {
  try { return openSync(WORKER_LOG_PATH, "a"); } catch { return "ignore"; }
}

const MIN_LENGTH = 100;

// 5s timeout safeguard
const timeout = setTimeout(() => {
  process.exit(0);
}, 5_000);
timeout.unref();

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input) as StopPayload;
    const message = data.last_assistant_message;

    if (!message || message.length < MIN_LENGTH) {
      process.exit(0);
    }

    const agent = getActiveAgent();

    const workerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "response-ingest-worker.js",
    );

    if (!existsSync(workerPath)) {
      process.stderr.write(`[stop] WARN: response-ingest-worker not found at ${workerPath}\n`);
      process.exit(0);
    }

    const stderrFd = openWorkerLog();
    const worker = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: ["ignore", "ignore", stderrFd],
      env: {
        ...process.env,
        AGENT_ID: agent.agentId,
        AGENT_ROLE: agent.agentRole,
        EXE_RESPONSE_TEXT: message.slice(0, 5000),
        EXE_SESSION_ID: data.session_id,
      },
    });
    worker.unref();
    if (typeof stderrFd === "number") try { closeSync(stderrFd); } catch {}
  } catch {
    // Silent failure — hook must never block Claude Code
  }

  process.exit(0);
});
