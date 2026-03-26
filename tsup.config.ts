import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    // Bins
    "bin/install": "src/bin/install.ts",
    "bin/setup": "src/bin/setup.ts",
    "bin/update": "src/bin/update.ts",
    "bin/backfill-vectors": "src/bin/backfill-vectors.ts",
    "bin/exe-new-employee": "src/bin/exe-new-employee.ts",
    "bin/exe-team": "src/bin/exe-team.ts",
    "bin/exe-settings": "src/bin/exe-settings.ts",
    "bin/exe-search": "src/bin/exe-search.ts",
    "bin/exe-forget": "src/bin/exe-forget.ts",
    // Hooks (output to dist/hooks/ — stable public contract)
    "hooks/ingest": "src/adapters/claude/hooks/ingest.ts",
    "hooks/ingest-worker": "src/adapters/claude/hooks/ingest-worker.ts",
    "hooks/session-start": "src/adapters/claude/hooks/session-start.ts",
    "hooks/prompt-submit": "src/adapters/claude/hooks/prompt-submit.ts",
    "hooks/error-recall": "src/adapters/claude/hooks/error-recall.ts",
    "hooks/summary-worker": "src/adapters/claude/hooks/summary-worker.ts",
    // MCP server
    "mcp/server": "src/mcp/server.ts",
    // Libs
    "lib/embedder": "src/lib/embedder.ts",
    "lib/embed-daemon": "src/lib/embed-daemon.ts",
    "lib/embed-client": "src/lib/embed-client.ts",
    "lib/store": "src/lib/store.ts",
    "lib/config": "src/lib/config.ts",
    "lib/crypto": "src/lib/crypto.ts",
    "lib/keychain": "src/lib/keychain.ts",
    "lib/turso": "src/lib/turso.ts",
    "lib/hybrid-search": "src/lib/hybrid-search.ts",
    "lib/error-detector": "src/lib/error-detector.ts",
    "lib/employees": "src/lib/employees.ts",
    "lib/employee-templates": "src/lib/employee-templates.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  splitting: false,
  sourcemap: true,
  clean: true,
  external: [
    "node-llama-cpp",
    "@libsql/client",
    "@modelcontextprotocol/sdk",
    "keytar",
    "zod",
  ],
});
