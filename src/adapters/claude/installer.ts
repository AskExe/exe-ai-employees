/**
 * Core installer logic for exe-mem.
 *
 * Handles: copying slash commands, registering MCP server, merging hooks.
 * All operations are idempotent -- safe to re-run.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookDef {
  type: string;
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookDef[];
}

interface Settings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

interface ClaudeJson {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileSha256(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// resolvePackageRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the package root from `import.meta.url`.
 *
 * At runtime this file lives at `dist/adapters/claude/installer.js`, so we go up
 * three levels (claude -> adapters -> dist -> package root).
 * In test/dev mode (via tsx/vitest) it lives at `src/adapters/claude/installer.ts`,
 * same depth so the same traversal works.
 */
export function resolvePackageRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), "..", "..", "..");
}

// ---------------------------------------------------------------------------
// copySlashCommands
// ---------------------------------------------------------------------------

/**
 * Copy `.md` slash command files from the package source to
 * `~/.claude/commands/exe/`.
 *
 * Uses SHA256 content-hash comparison so unchanged files are skipped.
 *
 * @param packageRoot  Absolute path to the package root (contains src/)
 * @param homeDir      Override for os.homedir() (used in tests)
 */
export async function copySlashCommands(
  packageRoot: string,
  homeDir: string = os.homedir(),
): Promise<{ copied: number; skipped: number }> {
  let copied = 0;
  let skipped = 0;

  // Copy /exe:* commands from src/commands/exe/
  const exeDir = path.join(packageRoot, "src", "commands", "exe");
  const exeDestDir = path.join(homeDir, ".claude", "commands", "exe");

  if (existsSync(exeDir)) {
    const entries = await readdir(exeDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));
    if (mdFiles.length > 0) {
      await mkdir(exeDestDir, { recursive: true });
      for (const file of mdFiles) {
        const result = await copyIfChanged(
          path.join(exeDir, file),
          path.join(exeDestDir, file),
        );
        if (result) copied++; else skipped++;
      }
    }
  }

  // Copy /exe top-level command from src/commands/exe.md
  const topLevelSrc = path.join(packageRoot, "src", "commands", "exe.md");
  const topLevelDest = path.join(homeDir, ".claude", "commands", "exe.md");
  if (existsSync(topLevelSrc)) {
    await mkdir(path.dirname(topLevelDest), { recursive: true });
    const result = await copyIfChanged(topLevelSrc, topLevelDest);
    if (result) copied++; else skipped++;
  }

  return { copied, skipped };
}

async function copyIfChanged(srcPath: string, destPath: string): Promise<boolean> {
  const srcHash = await fileSha256(srcPath);
  if (existsSync(destPath)) {
    const destHash = await fileSha256(destPath);
    if (srcHash === destHash) return false;
  }
  await writeFile(destPath, await readFile(srcPath));
  return true;
}

// ---------------------------------------------------------------------------
// registerMcpServer
// ---------------------------------------------------------------------------

/**
 * Register the exe-mem MCP server in `~/.claude.json`.
 *
 * The server entry points to the global install dist/ directory so that
 * node-llama-cpp and other native dependencies resolve from node_modules.
 *
 * @param packageRoot  Absolute path to the package root (contains dist/)
 * @param homeDir      Override for os.homedir() (used in tests)
 * @returns true if the file was changed, false if already identical
 */
export async function registerMcpServer(
  packageRoot: string,
  homeDir: string = os.homedir(),
): Promise<boolean> {
  const claudeJsonPath = path.join(homeDir, ".claude.json");

  let claudeJson: ClaudeJson = {};
  if (existsSync(claudeJsonPath)) {
    try {
      claudeJson = JSON.parse(await readFile(claudeJsonPath, "utf-8"));
    } catch {
      claudeJson = {};
    }
  }

  if (!claudeJson.mcpServers) {
    claudeJson.mcpServers = {};
  }

  const newEntry = {
    type: "stdio",
    command: "node",
    args: [path.join(packageRoot, "dist", "mcp", "server.js")],
    env: {},
  };

  const existing = claudeJson.mcpServers["exe-mem"];
  if (existing && JSON.stringify(existing) === JSON.stringify(newEntry)) {
    return false;
  }

  claudeJson.mcpServers["exe-mem"] = newEntry;
  await writeFile(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n");
  return true;
}

// ---------------------------------------------------------------------------
// mergeHooks
// ---------------------------------------------------------------------------

/**
 * Merge exe-mem hooks into `~/.claude/settings.json`.
 *
 * Dedup: for each event type, check if any existing hook group already
 * contains a command string referencing the exe-mem hook file. If so, skip.
 *
 * @param packageRoot  Absolute path to the package root (contains dist/)
 * @param homeDir      Override for os.homedir() (used in tests)
 */
export async function mergeHooks(
  packageRoot: string,
  homeDir: string = os.homedir(),
): Promise<{ added: number; skipped: number }> {
  const settingsPath = path.join(homeDir, ".claude", "settings.json");

  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Define the hook groups to register
  const hooksToRegister: Array<{
    event: string;
    group: HookGroup;
    /** Unique substring to detect if already registered */
    marker: string;
  }> = [
    {
      event: "PostToolUse",
      group: {
        matcher: "Bash|Edit|Write|Read|Glob|Grep|Agent|mcp__.*",
        hooks: [
          {
            type: "command",
            command: `node "${path.join(packageRoot, "dist", "hooks", "ingest.js")}"`,
          },
          {
            type: "command",
            command: `node "${path.join(packageRoot, "dist", "hooks", "error-recall.js")}"`,
          },
        ],
      },
      marker: "dist/hooks/ingest.js",
    },
    {
      event: "SessionStart",
      group: {
        hooks: [
          {
            type: "command",
            command: `node "${path.join(packageRoot, "dist", "hooks", "session-start.js")}"`,
            timeout: 10000,
          },
        ],
      },
      marker: "dist/hooks/session-start.js",
    },
    {
      event: "UserPromptSubmit",
      group: {
        hooks: [
          {
            type: "command",
            command: `node "${path.join(packageRoot, "dist", "hooks", "prompt-submit.js")}"`,
          },
        ],
      },
      marker: "dist/hooks/prompt-submit.js",
    },
  ];

  let added = 0;
  let skipped = 0;

  for (const { event, group, marker } of hooksToRegister) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    const existing = settings.hooks[event] as HookGroup[];
    const alreadyExists = existing.some((g) =>
      g.hooks.some((h) => h.command.includes(marker)),
    );

    if (alreadyExists) {
      skipped++;
    } else {
      existing.push(group);
      added++;
    }
  }

  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  return { added, skipped };
}

// ---------------------------------------------------------------------------
// runInstaller
// ---------------------------------------------------------------------------

/**
 * Orchestrate the full installation:
 * 1. Resolve package root
 * 2. Copy slash commands
 * 3. Register MCP server
 * 4. Merge hooks
 *
 * @param homeDir  Override for os.homedir() (used in tests)
 */
export async function runInstaller(homeDir?: string): Promise<void> {
  const packageRoot = resolvePackageRoot();

  process.stderr.write(`exe-mem installer v1.3.0\n`);
  process.stderr.write(`Package root: ${packageRoot}\n\n`);

  // Step 1: Copy slash commands
  const cmdResult = await copySlashCommands(packageRoot, homeDir);
  process.stderr.write(
    `Slash commands: ${cmdResult.copied} copied, ${cmdResult.skipped} unchanged\n`,
  );

  // Step 2: Register MCP server
  const mcpChanged = await registerMcpServer(packageRoot, homeDir);
  process.stderr.write(
    `MCP server: ${mcpChanged ? "registered" : "already registered"}\n`,
  );

  // Step 3: Merge hooks
  const hookResult = await mergeHooks(packageRoot, homeDir);
  process.stderr.write(
    `Hooks: ${hookResult.added} added, ${hookResult.skipped} unchanged\n`,
  );

  process.stderr.write(`\nexe-mem installed successfully.\n`);
}
