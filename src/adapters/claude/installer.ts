/**
 * Core installer logic for exe-mem.
 *
 * Handles: copying slash commands, registering MCP server, merging hooks.
 * All operations are idempotent -- safe to re-run.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

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
// resolvePackageRoot
// ---------------------------------------------------------------------------

/**
 * Resolve the package root from `import.meta.url`.
 *
 * Walks up from the current file's directory looking for a `package.json`
 * whose `name` field is `"exe-ai-employees"`. This is robust regardless of
 * bundling — tsup may inline this module into `dist/bin/install.js`, changing
 * the depth.
 */
export function resolvePackageRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(thisFile);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const pkgPath = path.join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "exe-ai-employees") return dir;
      } catch {
        // Malformed package.json — keep walking
      }
    }
    dir = path.dirname(dir);
  }

  // Fallback: original heuristic (3 levels up)
  return path.resolve(path.dirname(thisFile), "..", "..", "..");
}

// ---------------------------------------------------------------------------
// copySlashCommands (now installs as skills)
// ---------------------------------------------------------------------------

/**
 * Install exe-os skills to `~/.claude/skills/`.
 *
 * Claude Code 2.1.80+ deprecated `~/.claude/commands/` in favor of skills.
 * Each subcommand gets its own directory: `~/.claude/skills/exe-<name>/SKILL.md`.
 * The main boot command goes to `~/.claude/skills/exe/SKILL.md`.
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

  const skillsBase = path.join(homeDir, ".claude", "skills");

  // Install /exe-<name> subcommand skills from src/commands/exe/
  const exeDir = path.join(packageRoot, "src", "commands", "exe");
  if (existsSync(exeDir)) {
    const entries = await readdir(exeDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));
    for (const file of mdFiles) {
      const name = file.replace(".md", "");
      const destDir = path.join(skillsBase, `exe-${name}`);
      await mkdir(destDir, { recursive: true });

      const srcPath = path.join(exeDir, file);
      const destPath = path.join(destDir, "SKILL.md");

      // Transform command frontmatter → skill frontmatter (add name field)
      const result = await copyAsSkill(srcPath, destPath, `exe-${name}`);
      if (result) copied++; else skipped++;
    }
  }

  // Install /exe main boot skill from src/commands/exe.md
  const topLevelSrc = path.join(packageRoot, "src", "commands", "exe.md");
  if (existsSync(topLevelSrc)) {
    const destDir = path.join(skillsBase, "exe");
    await mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, "SKILL.md");
    const result = await copyAsSkill(topLevelSrc, destPath, "exe");
    if (result) copied++; else skipped++;
  }

  return { copied, skipped };
}

/**
 * Copy a command .md file as a SKILL.md, injecting/updating the `name` field.
 * Returns true if the file was written, false if unchanged.
 */
async function copyAsSkill(srcPath: string, destPath: string, skillName: string): Promise<boolean> {
  let content = await readFile(srcPath, "utf-8");

  // Ensure the frontmatter has the correct name field
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch?.[1]) {
    const fm = fmMatch[1];
    if (fm.includes("name:")) {
      // Update existing name field
      content = content.replace(/^(---\n[\s\S]*?)name:\s*[^\n]+/,
        `$1name: ${skillName}`);
    } else {
      // Add name field after opening ---
      content = content.replace(/^---\n/, `---\nname: ${skillName}\n`);
    }
  }

  // Check if dest already has identical content
  if (existsSync(destPath)) {
    const existing = await readFile(destPath, "utf-8");
    if (existing === content) return false;
  }

  await writeFile(destPath, content);
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
    {
      event: "Stop",
      group: {
        hooks: [
          {
            type: "command",
            command: `node "${path.join(packageRoot, "dist", "hooks", "stop.js")}"`,
          },
        ],
      },
      marker: "dist/hooks/stop.js",
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

  process.stderr.write(`exe-ai-employees installer v1.3.0\n`);
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

  process.stderr.write(`\nexe-ai-employees installed successfully.\n`);
  process.stderr.write(`Run /exe:setup inside Claude Code to complete first-time setup.\n`);
}
