#!/usr/bin/env node
/**
 * /exe:search CLI — search memories by keyword or semantic query.
 *
 * Usage: exe-search <query>
 *
 * @module exe-search
 */

import { initStore } from "../lib/store.js";
import { hybridSearch, lightweightSearch } from "../lib/hybrid-search.js";
import { loadConfig } from "../lib/config.js";
import { isMainModule } from "../lib/is-main.js";

async function main(): Promise<void> {
  const query = process.argv.slice(2).join(" ");

  if (!query) {
    console.error('Usage: exe-search <query>\nExample: exe-search "auth bug JWT"');
    process.exit(1);
  }

  const agentId = process.env.AGENT_ID;
  if (!agentId) {
    console.error("No AGENT_ID set. Run this inside an employee session (/exe:call <name>).");
    process.exit(1);
  }

  await initStore();

  const config = await loadConfig();
  const search = config.searchMode === "hybrid" ? hybridSearch : lightweightSearch;
  const memories = await search(query, agentId, { limit: 10 });

  if (memories.length === 0) {
    console.log("No memories found.");
    return;
  }

  console.log(`Found ${memories.length} memories:\n`);

  for (const m of memories) {
    const errorTag = m.has_error ? " [ERROR]" : "";
    const text = m.raw_text.length > 300 ? m.raw_text.slice(0, 300) + "..." : m.raw_text;
    console.log(`[${m.timestamp}] ${m.tool_name} (${m.project_name})${errorTag}`);
    console.log(`  ${text}`);
    console.log(`  ID: ${m.id}`);
    console.log("");
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { main };
