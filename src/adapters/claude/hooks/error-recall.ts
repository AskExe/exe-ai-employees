/**
 * PostToolUse error auto-recall hook.
 *
 * Detects errors in PostToolUse tool_response using the error-detector
 * module, then searches for past error solutions using lightweight text
 * search (no embedding model) and injects via additionalContext.
 *
 * Only fires when detectError() returns true -- non-error tool calls
 * are skipped immediately.
 *
 * @module error-recall
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

import type { PostToolUsePayload } from "../../../types/hook-payload.js";
import { detectError } from "../../../lib/error-detector.js";
import { loadConfig } from "../../../lib/config.js";
import { initStore } from "../../../lib/store.js";
import { lightweightSearch, hybridSearch } from "../../../lib/hybrid-search.js";
import { getClient } from "../../../lib/turso.js";
import { getActiveAgent } from "../active-agent.js";

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
    const data = JSON.parse(input) as PostToolUsePayload;

    // Skip non-error tool calls (fast path — no DB access)
    if (!detectError(data)) {
      process.exit(0);
    }

    await initStore();

    const config = await loadConfig();
    const search = config.hookSearchMode === "hybrid" ? hybridSearch : lightweightSearch;

    // Resolve active agent identity (marker file > env var)
    const agent = getActiveAgent();

    // Extract error text for search
    const errorText = JSON.stringify(data.tool_response).slice(0, 300);

    const memories = await search(
      errorText,
      agent.agentId,
      { hasError: true, limit: 3 },
    );

    if (memories.length > 0) {
      // For each error, also fetch the 1-2 records that came right after it
      // (the fix). These are non-error records from the same agent, ordered
      // by timestamp immediately after the error's timestamp.
      const client = getClient();
      const parts: string[] = [];

      for (const m of memories) {
        parts.push(
          `**Error:** [${m.timestamp}] ${m.tool_name} (${m.project_name}): ${m.raw_text.slice(0, 400)}`
        );

        try {
          const fixResult = await client.execute({
            sql: `SELECT tool_name, project_name, raw_text, timestamp
                  FROM memories
                  WHERE agent_id = ? AND timestamp > ? AND has_error = 0
                  ORDER BY timestamp ASC LIMIT 2`,
            args: [agent.agentId, m.timestamp],
          });

          if (fixResult.rows.length > 0) {
            const fixes = fixResult.rows
              .map(
                (r) =>
                  `  Fix: [${r.timestamp as string}] ${r.tool_name as string}: ${(r.raw_text as string).slice(0, 300)}`,
              )
              .join("\n");
            parts.push(fixes);
          }
        } catch {
          // Skip fix lookup on failure — still show the error
        }
      }

      const output = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: `## Past Solutions for Similar Errors\n${parts.join("\n\n")}`,
        },
      });
      process.stdout.write(output);
    }
  } catch {
    // Silent failure -- hook must never block Claude Code
  }

  process.exit(0);
});
