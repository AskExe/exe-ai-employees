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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { UserPromptSubmitPayload } from "../../../types/hook-payload.js";
import { loadConfig, EXE_AI_DIR } from "../../../lib/config.js";
import { initStore } from "../../../lib/store.js";
import { lightweightSearch, hybridSearch } from "../../../lib/hybrid-search.js";
import { getActiveAgent } from "../active-agent.js";

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
    if (prompt.length < 20) {
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
  } catch {
    // Silent failure -- hook must never block Claude Code
  }

  process.exit(0);
});
