/**
 * PostToolUse ingestion hook entry point.
 *
 * Reads stdin JSON from Claude Code, validates the tool_name,
 * spawns a detached child process to do the heavy embed+write work,
 * and exits 0 immediately so Claude Code is never blocked.
 *
 * Also tracks tool call counts per session. Every 25 tool calls
 * (with at least 3 write-type calls), spawns an auto-summary worker
 * that generates a structured summary from recent memories.
 *
 * CRITICAL: This file must NEVER load the embedding model or DB store.
 * All heavy work happens in the worker process.
 *
 * @module ingest
 */

// Default AGENT_ID if not set — ensures sub-agent work is still captured
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
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXE_AI_DIR } from "../../../lib/config.js";
import { getActiveAgent } from "../active-agent.js";

// Shared worker log path — all detached workers write stderr here
const WORKER_LOG_PATH = path.join(EXE_AI_DIR, "workers.log");

/** Open workers.log in append mode; returns "ignore" if open fails. */
function openWorkerLog(): number | "ignore" {
  try { return openSync(WORKER_LOG_PATH, "a"); } catch { return "ignore"; }
}

/** Tool names the hook should fire on */
const ALLOWED_TOOL_RE = /^(Bash|Edit|Write|Read|Glob|Grep|Agent|mcp__.*)$/;

/** Tools that indicate meaningful work (not just reading/exploring) */
const WRITE_TOOL_RE = /^(Bash|Edit|Write)$/;

const SUMMARY_INTERVAL = 25;
const MIN_WRITES_FOR_SUMMARY = 3;
const COUNTER_DIR = path.join(EXE_AI_DIR, "session-cache");

interface SessionCounter {
  total: number;
  writes: number;
  lastSummaryAt: number;
}

function getCounterPath(sessionId: string): string {
  return path.join(COUNTER_DIR, `counter-${sessionId}.json`);
}

function loadCounter(sessionId: string): SessionCounter {
  try {
    const raw = readFileSync(getCounterPath(sessionId), "utf8");
    return JSON.parse(raw) as SessionCounter;
  } catch {
    return { total: 0, writes: 0, lastSummaryAt: 0 };
  }
}

function saveCounter(sessionId: string, counter: SessionCounter): void {
  try {
    mkdirSync(COUNTER_DIR, { recursive: true });
    writeFileSync(getCounterPath(sessionId), JSON.stringify(counter));
  } catch {
    // Non-critical
  }
}

const MAX_INPUT_SIZE = 1_000_000;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (input.length < MAX_INPUT_SIZE) {
    input += chunk;
  }
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input) as { tool_name?: string; session_id?: string; tool_input?: Record<string, unknown>; tool_response?: unknown };
    if (!data.tool_name) {
      process.exit(0);
    }

    // Resolve active agent identity (marker file > env var)
    const agent = getActiveAgent();

    // --- Counter tracking ---
    if (data.session_id) {
      const counter = loadCounter(data.session_id);
      counter.total++;
      if (WRITE_TOOL_RE.test(data.tool_name)) {
        counter.writes++;
      }

      // Auto-summary: every 25 calls with 3+ writes
      const callsSinceLastSummary = counter.total - counter.lastSummaryAt;
      if (callsSinceLastSummary >= SUMMARY_INTERVAL && counter.writes >= MIN_WRITES_FOR_SUMMARY) {
        const summaryWorkerPath = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "summary-worker.js",
        );

        if (existsSync(summaryWorkerPath)) {
          const stderrFd = openWorkerLog();
          const summaryWorker = spawn(process.execPath, [summaryWorkerPath], {
            detached: true,
            stdio: ["ignore", "ignore", stderrFd],
            env: {
              ...process.env,
              AGENT_ID: agent.agentId,
              AGENT_ROLE: agent.agentRole,
              EXE_SUMMARY_SINCE: String(counter.lastSummaryAt),
              EXE_SUMMARY_TOTAL: String(callsSinceLastSummary),
              EXE_SUMMARY_WRITES: String(counter.writes),
            },
          });
          summaryWorker.unref();
          if (typeof stderrFd === "number") try { closeSync(stderrFd); } catch {}
        } else {
          process.stderr.write(`[ingest] WARN: summary-worker not found at ${summaryWorkerPath}\n`);
        }

        counter.lastSummaryAt = counter.total;
        counter.writes = 0; // Reset for next summary interval
      }

      saveCounter(data.session_id, counter);
    }

    // --- Ingestion filter: only spawn worker for memory-relevant tools ---
    if (!ALLOWED_TOOL_RE.test(data.tool_name)) {
      process.exit(0);
    }

    // Resolve the worker script path relative to this file
    const workerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "ingest-worker.js",
    );

    // Spawn detached worker -- it does the heavy lifting
    const stderrFd = openWorkerLog();
    const worker = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: ["pipe", "ignore", stderrFd],
      env: { ...process.env, AGENT_ID: agent.agentId, AGENT_ROLE: agent.agentRole },
    });

    // Write the full payload to the worker's stdin
    worker.stdin!.write(input);
    worker.stdin!.end();

    // Detach so the worker survives our exit
    worker.unref();
    if (typeof stderrFd === "number") try { closeSync(stderrFd); } catch {}
  } catch {
    // Silent failure -- hook must never block Claude Code
  }

  // Exit 0 immediately -- Claude Code continues
  process.exit(0);
});
