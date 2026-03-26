#!/usr/bin/env node
import { runInstaller, copySlashCommands, resolvePackageRoot } from "../adapters/claude/installer.js";

const args = process.argv.slice(2);

if (args.includes("--commands-only")) {
  // Lightweight path: only copy slash commands (used by postinstall)
  try {
    const packageRoot = resolvePackageRoot();
    const result = await copySlashCommands(packageRoot);
    if (result.copied > 0) {
      process.stderr.write(
        `exe-mem: ${result.copied} slash command(s) updated\n`,
      );
    }
  } catch {
    // Silent — postinstall must never break npm install
  }
} else if (args.includes("--global")) {
  try {
    await runInstaller();
  } catch (err) {
    console.error(
      "Installation failed:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
} else {
  console.error("Usage: npx exe-mem --global");
  console.error(
    "  Installs exe-mem commands, MCP server, and hooks into ~/.claude/",
  );
  process.exit(1);
}
