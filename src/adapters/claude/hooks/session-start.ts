/**
 * SessionStart retrieval hook.
 *
 * Queries recent memories for the current project and injects them
 * as a "Memory Brief" via hookSpecificOutput.additionalContext.
 *
 * Uses lightweight text search (no embedding model) to stay fast.
 * Runs inline with a 5s timeout safeguard.
 *
 * @module session-start
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

import type { SessionStartPayload } from "../../../types/hook-payload.js";
import { loadConfig } from "../../../lib/config.js";
import { initStore } from "../../../lib/store.js";
import { lightweightSearch, hybridSearch } from "../../../lib/hybrid-search.js";
import { getActiveAgent, cleanupSessionMarkers } from "../active-agent.js";
import { getProjectName } from "../../../lib/project-name.js";

// 5s timeout safeguard -- session start should be quick
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
    const data = JSON.parse(input) as SessionStartPayload;
    const projectName = getProjectName(data.cwd || undefined);
    const source = data.source ?? "startup";

    // On fresh startup, clean up stale marker for this port/PPID
    if (source === "startup") {
      cleanupSessionMarkers();
    }

    await initStore();

    const config = await loadConfig();
    const search = config.hookSearchMode === "hybrid" ? hybridSearch : lightweightSearch;

    // Resolve active agent identity (marker file > env var)
    const agent = getActiveAgent();
    const agentId = agent.agentId;

    // Tailor search query and header based on how the session started
    let query: string;
    let header: string;
    if (source === "resume") {
      query = `last actions on ${projectName}`;
      header = "## Resuming Session\nHere's where you left off:";
    } else {
      query = `recent work on ${projectName}`;
      header = "## Memory Brief\nRecent memories from this project:";
    }

    const memories = await search(
      query,
      agentId,
      { projectName, limit: 5 },
    );

    let additionalContext = "";

    if (memories.length > 0) {
      const brief = memories
        .map(
          (m) =>
            `[${m.timestamp}] ${m.tool_name}: ${m.raw_text.slice(0, 200)}`,
        )
        .join("\n");
      additionalContext = `${header}\n${brief}`;
    }

    if (additionalContext.length > 0) {
      const output = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext,
        },
      });
      process.stdout.write(output);
    }
  } catch {
    // Silent failure -- hook must never block Claude Code
  }

  clearTimeout(timeout);
  process.exit(0);
});
