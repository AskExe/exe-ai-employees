/**
 * /exe-settings — Interactive configuration for exe-os.
 *
 * Displays current settings and lets the user toggle:
 * - Auto-ingestion (write memories on every tool call)
 * - Auto-retrieval (inject memories into context automatically)
 * - MCP search mode (hybrid = FTS + vector, fts = keywords only)
 * - Hook search mode (fts = fast/no model, hybrid = better quality/loads model)
 *
 * @module exe-settings
 */

import { createInterface } from "node:readline";
import { loadConfig, saveConfig, type ExeAiConfig } from "../lib/config.js";
import { isMainModule } from "../lib/is-main.js";

function label(value: boolean): string {
  return value ? "ON" : "OFF";
}

function searchLabel(mode: string): string {
  if (mode === "hybrid") return "hybrid   FTS + vector (best quality, uses embedding model)";
  return "fts      Keywords only (fast, no embedding model)";
}

function hookSearchLabel(mode: string): string {
  if (mode === "hybrid") return "hybrid   FTS + vector (loads 639MB model — adds 3-8s on first call)";
  return "fts      Keywords only (fast, ~200ms, no model load)";
}

function syncStatus(config: ExeAiConfig): string {
  if (config.cloud?.apiKey) return "Exe Cloud";
  if (config.turso?.url) return "Turso (self-hosted)";
  return "local-only";
}

function printSettings(config: ExeAiConfig): void {
  console.log(`
┌─────────────────────────────────────────────────┐
│  exe-os settings                                 │
└─────────────────────────────────────────────────┘

  1. Auto-ingestion:    ${label(config.autoIngestion).padEnd(5)}  Store every tool call as a memory
  2. Auto-retrieval:    ${label(config.autoRetrieval).padEnd(5)}  Inject relevant memories into context
  3. MCP search mode:   ${searchLabel(config.searchMode)}
  4. Hook search mode:  ${hookSearchLabel(config.hookSearchMode)}
  5. Cloud sync:        ${syncStatus(config)}

  Model:               ${config.modelFile}

Type a number to toggle, or "q" to quit.
`);
}

async function main(): Promise<void> {
  const config = await loadConfig();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    printSettings(config);
    rl.question("> ", async (answer) => {
      const choice = answer.trim().toLowerCase();

      if (choice === "1") {
        config.autoIngestion = !config.autoIngestion;
        await saveConfig(config);
        console.log(`\n  Auto-ingestion ${label(config.autoIngestion)}`);
        if (!config.autoIngestion) {
          console.log("  Tool calls will no longer be saved to memory.");
          console.log("  Use the store_memory MCP tool to save manually.");
        }
        prompt();
      } else if (choice === "2") {
        config.autoRetrieval = !config.autoRetrieval;
        await saveConfig(config);
        console.log(`\n  Auto-retrieval ${label(config.autoRetrieval)}`);
        if (!config.autoRetrieval) {
          console.log("  Memories won't be injected automatically.");
          console.log("  Use recall_my_memory MCP tool to search manually.");
        }
        prompt();
      } else if (choice === "3") {
        config.searchMode = config.searchMode === "hybrid" ? "fts" : "hybrid";
        await saveConfig(config);
        console.log(`\n  MCP search mode: ${config.searchMode}`);
        if (config.searchMode === "fts") {
          console.log("  MCP tools now use keyword search only.");
          console.log("  Faster queries, no embedding model needed for search.");
        } else {
          console.log("  MCP tools now use hybrid search (FTS + vector + RRF).");
          console.log("  Best quality — model is already warm in MCP server.");
        }
        prompt();
      } else if (choice === "4") {
        config.hookSearchMode = config.hookSearchMode === "fts" ? "hybrid" : "fts";
        await saveConfig(config);
        console.log(`\n  Hook search mode: ${config.hookSearchMode}`);
        if (config.hookSearchMode === "hybrid") {
          console.log("  Hooks will load the embedding model for semantic search.");
          console.log("  Better recall, but first invocation adds 3-8s cold-start.");
        } else {
          console.log("  Hooks use keyword search only (~200ms, no model load).");
          console.log("  Recommended for daily use.");
        }
        prompt();
      } else if (choice === "5") {
        console.log(`\n  Current sync: ${syncStatus(config)}`);
        console.log("\n  Configure cloud sync:");
        console.log("    a. Exe Cloud — paste your API key (exe_sk_...)");
        console.log("    b. Self-hosted Turso — paste your Turso URL and token");
        console.log("    c. Disconnect — switch to local-only");
        console.log("    d. Cancel");
        rl.question("\n  > ", async (syncChoice) => {
          const sc = syncChoice.trim().toLowerCase();
          if (sc === "a") {
            rl.question("  API key: ", async (apiKey) => {
              const key = apiKey.trim();
              if (!key) { console.log("  Cancelled."); prompt(); return; }
              rl.question("  Endpoint [https://askexe.com/cloud]: ", async (ep) => {
                const endpoint = ep.trim() || "https://askexe.com/cloud";
                // Validate the key
                console.log("  Validating...");
                try {
                  const resp = await fetch(`${endpoint}/auth/verify`, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
                  });
                  if (resp.ok) {
                    config.cloud = { apiKey: key, endpoint };
                    delete config.turso;
                    await saveConfig(config);
                    console.log("  ✓ Cloud sync configured. Memories will sync on next ingestion.");
                  } else {
                    console.log(`  ✗ Validation failed (${resp.status}). Key not saved.`);
                  }
                } catch (err) {
                  console.log(`  ✗ Could not reach endpoint: ${err instanceof Error ? err.message : String(err)}`);
                  console.log("  Key not saved. Check the endpoint URL.");
                }
                prompt();
              });
            });
          } else if (sc === "b") {
            rl.question("  Turso URL: ", async (url) => {
              const u = url.trim();
              if (!u) { console.log("  Cancelled."); prompt(); return; }
              rl.question("  Auth token: ", async (token) => {
                const t = token.trim();
                if (!t) { console.log("  Cancelled."); prompt(); return; }
                config.turso = { url: u, authToken: t };
                delete config.cloud;
                await saveConfig(config);
                console.log("  ✓ Turso sync configured.");
                prompt();
              });
            });
          } else if (sc === "c") {
            delete config.cloud;
            delete config.turso;
            await saveConfig(config);
            console.log("  ✓ Switched to local-only. Cloud sync disconnected.");
            prompt();
          } else {
            prompt();
          }
        });
      } else if (choice === "q" || choice === "quit" || choice === "") {
        rl.close();
      } else {
        console.log("\n  Unknown option. Type 1-5, or q.");
        prompt();
      }
    });
  };

  prompt();
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error("Settings error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

export { main };
