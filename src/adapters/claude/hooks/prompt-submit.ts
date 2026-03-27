/**
 * UserPromptSubmit retrieval hook with relevance gate.
 *
 * Default: hybrid search (RRF — FTS + vector via embed daemon socket).
 * Falls back to FTS-only if daemon is unavailable or config says "fts".
 * The embed call is a socket message (~50-200ms), not model loading.
 *
 * Relevance gates:
 * 1. Minimum length check: prompts < 20 chars are skipped entirely (RETR-05)
 * 2. FTS relevance: only results matching prompt keywords are returned
 *
 * @module prompt-submit
 */

// Default AGENT_ID if not set — ensures sub-agent work is still captured
if (!process.env.AGENT_ID) {
  process.env.AGENT_ID = "default";
  process.env.AGENT_ROLE = "employee";
}

// Guard: skip if auto-retrieval is disabled
import { loadConfigSync } from "../../../lib/config.js";
if (!loadConfigSync().autoRetrieval) {
  process.exit(0);
}

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UserPromptSubmitPayload } from "../../../types/hook-payload.js";
import { loadConfig, EXE_AI_DIR } from "../../../lib/config.js";
import { initStore } from "../../../lib/store.js";
import { lightweightSearch, hybridSearch } from "../../../lib/hybrid-search.js";
import { getActiveAgent } from "../active-agent.js";

// Shared worker log path — all detached workers write stderr here
const WORKER_LOG_PATH = path.join(EXE_AI_DIR, "workers.log");

/** Open workers.log in append mode; returns "ignore" if open fails. */
function openWorkerLog(): number | "ignore" {
  try { return openSync(WORKER_LOG_PATH, "a"); } catch { return "ignore"; }
}

const CACHE_DIR = path.join(EXE_AI_DIR, "session-cache");

function loadInjectedIds(sessionId: string): Set<string> {
  try {
    const raw = readFileSync(path.join(CACHE_DIR, `${sessionId}.json`), "utf8");
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveInjectedIds(sessionId: string, ids: Set<string>): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      path.join(CACHE_DIR, `${sessionId}.json`),
      JSON.stringify([...ids]),
    );
  } catch {
    // Non-critical — worst case we re-inject next time
  }
}

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
process.stdin.on("end", async () => {
  try {
    const data = JSON.parse(input) as UserPromptSubmitPayload;
    const prompt = data.prompt;

    // Resolve active agent identity (marker file > env var)
    const agent = getActiveAgent();

    // Relevance gate: skip memory retrieval for short messages like "yes", "ok", "keep going"
    // Storage uses a lower threshold (10 chars) — see spawnPromptWorker below
    if (prompt.length < 20) {
      // Still store prompts >= 10 chars even though we skip retrieval
      if (prompt.length >= 10) {
        spawnPromptWorker(prompt, data.session_id, agent);
      }
      process.exit(0);
    }

    await initStore();

    const config = await loadConfig();
    const search = config.hookSearchMode === "hybrid" ? hybridSearch : lightweightSearch;

    const memories = await search(
      prompt.slice(0, 200),
      agent.agentId,
      { limit: 5 },
    );

    if (memories.length > 0) {
      const injected = loadInjectedIds(data.session_id);
      const fresh = memories.filter((m) => !injected.has(m.id));

      if (fresh.length > 0) {
        for (const m of fresh) injected.add(m.id);
        saveInjectedIds(data.session_id, injected);

        const memoryContext = `## Relevant Memories\n${fresh
          .map(
            (m) =>
              `[${m.timestamp}] ${m.tool_name}: ${m.raw_text.slice(0, 300)}`,
          )
          .join("\n")}`;

        const output = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: memoryContext,
          },
        });
        process.stdout.write(output);
      }
    }

    // --- Storage: embed and store the user prompt as a memory record ---
    // Non-blocking: spawn detached worker AFTER retrieval output is written
    spawnPromptWorker(prompt, data.session_id, agent);
  } catch {
    // Silent failure -- hook must never block Claude Code
  }

  process.exit(0);
});

/**
 * Spawn a detached worker to embed and store the user prompt.
 * Worker receives data via env vars — no stdin pipe needed.
 */
function spawnPromptWorker(
  prompt: string,
  sessionId: string,
  agent: { agentId: string; agentRole: string },
): void {
  // Respect autoIngestion setting (separate from autoRetrieval)
  if (!loadConfigSync().autoIngestion) return;

  try {
    const workerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "prompt-ingest-worker.js",
    );

    if (!existsSync(workerPath)) {
      process.stderr.write(`[prompt-submit] WARN: prompt-ingest-worker not found at ${workerPath}\n`);
      return;
    }

    const stderrFd = openWorkerLog();
    const worker = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: ["ignore", "ignore", stderrFd],
      env: {
        ...process.env,
        AGENT_ID: agent.agentId,
        AGENT_ROLE: agent.agentRole,
        EXE_PROMPT_TEXT: prompt.slice(0, 2000),
        EXE_SESSION_ID: sessionId,
      },
    });
    worker.unref();
    if (typeof stderrFd === "number") try { closeSync(stderrFd); } catch {}
  } catch {
    // Non-critical — retrieval still works even if storage fails
  }
}
