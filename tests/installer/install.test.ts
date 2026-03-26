import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Integration-style tests for the installer library.
 *
 * Strategy: Use real temp directories (not mocked fs) so we test actual
 * file I/O behavior. We override the home directory and package root
 * by passing them as parameters to the installer functions.
 */

// Dynamic import to allow test to compile even before src exists
let installerModule: typeof import("../../src/adapters/claude/installer.js");

beforeEach(async () => {
  installerModule = await import("../../src/adapters/claude/installer.js");
});

describe("resolvePackageRoot", () => {
  it("returns the package root directory derived from import.meta.url", () => {
    const root = installerModule.resolvePackageRoot();
    // The package root should contain package.json
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
  });
});

describe("copySlashCommands", () => {
  let tmpHome: string;
  let tmpPkgRoot: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), "exe-test-home-"));
    tmpPkgRoot = await mkdtemp(path.join(os.tmpdir(), "exe-test-pkg-"));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
    await rm(tmpPkgRoot, { recursive: true, force: true });
  });

  it("creates ~/.claude/commands/exe/ and copies .md files", async () => {
    // Setup: create source commands
    const srcDir = path.join(tmpPkgRoot, "src", "commands", "exe");
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, "setup.md"), "# Setup command");
    await writeFile(path.join(srcDir, "update.md"), "# Update command");

    const result = await installerModule.copySlashCommands(tmpPkgRoot, tmpHome);

    expect(result.copied).toBe(2);
    expect(result.skipped).toBe(0);

    const destDir = path.join(tmpHome, ".claude", "commands", "exe");
    expect(existsSync(path.join(destDir, "setup.md"))).toBe(true);
    expect(existsSync(path.join(destDir, "update.md"))).toBe(true);

    const content = await readFile(path.join(destDir, "setup.md"), "utf-8");
    expect(content).toBe("# Setup command");
  });

  it("skips copy when SHA256 matches (idempotent)", async () => {
    // Setup: create source and matching destination
    const srcDir = path.join(tmpPkgRoot, "src", "commands", "exe");
    await mkdir(srcDir, { recursive: true });
    await writeFile(path.join(srcDir, "setup.md"), "# Setup command");

    const destDir = path.join(tmpHome, ".claude", "commands", "exe");
    await mkdir(destDir, { recursive: true });
    await writeFile(path.join(destDir, "setup.md"), "# Setup command"); // same content

    const result = await installerModule.copySlashCommands(tmpPkgRoot, tmpHome);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("handles empty or missing source directory gracefully", async () => {
    // No source commands directory exists
    const result = await installerModule.copySlashCommands(tmpPkgRoot, tmpHome);

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

describe("registerMcpServer", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), "exe-test-home-"));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("adds mcpServers.exe-mem to ~/.claude.json", async () => {
    const pkgRoot = "/opt/npm-global/lib/node_modules/exe-mem";

    const changed = await installerModule.registerMcpServer(pkgRoot, tmpHome);

    expect(changed).toBe(true);

    const claudeJson = JSON.parse(
      await readFile(path.join(tmpHome, ".claude.json"), "utf-8")
    );
    expect(claudeJson.mcpServers["exe-mem"]).toEqual({
      type: "stdio",
      command: "node",
      args: [path.join(pkgRoot, "dist", "mcp", "server.js")],
      env: {},
    });
  });

  it("preserves existing keys in ~/.claude.json", async () => {
    const existing = {
      numStartups: 42,
      theme: "dark",
      tipsHistory: ["tip1"],
      mcpServers: {
        "other-server": { type: "stdio", command: "other" },
      },
    };
    await writeFile(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify(existing, null, 2)
    );

    const pkgRoot = "/opt/npm-global/lib/node_modules/exe-mem";
    await installerModule.registerMcpServer(pkgRoot, tmpHome);

    const claudeJson = JSON.parse(
      await readFile(path.join(tmpHome, ".claude.json"), "utf-8")
    );
    expect(claudeJson.numStartups).toBe(42);
    expect(claudeJson.theme).toBe("dark");
    expect(claudeJson.tipsHistory).toEqual(["tip1"]);
    expect(claudeJson.mcpServers["other-server"]).toEqual({
      type: "stdio",
      command: "other",
    });
    expect(claudeJson.mcpServers["exe-mem"]).toBeDefined();
  });

  it("is idempotent -- re-run produces same JSON", async () => {
    const pkgRoot = "/opt/npm-global/lib/node_modules/exe-mem";

    await installerModule.registerMcpServer(pkgRoot, tmpHome);
    const firstRun = await readFile(
      path.join(tmpHome, ".claude.json"),
      "utf-8"
    );

    const changed = await installerModule.registerMcpServer(pkgRoot, tmpHome);
    const secondRun = await readFile(
      path.join(tmpHome, ".claude.json"),
      "utf-8"
    );

    expect(changed).toBe(false);
    expect(firstRun).toBe(secondRun);
  });
});

describe("mergeHooks", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), "exe-test-home-"));
    // Create .claude directory for settings.json
    await mkdir(path.join(tmpHome, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("adds PostToolUse, SessionStart, UserPromptSubmit hooks to settings.json", async () => {
    const pkgRoot = "/opt/npm-global/lib/node_modules/exe-mem";

    const result = await installerModule.mergeHooks(pkgRoot, tmpHome);

    expect(result.added).toBeGreaterThanOrEqual(3);

    const settings = JSON.parse(
      await readFile(
        path.join(tmpHome, ".claude", "settings.json"),
        "utf-8"
      )
    );

    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();

    // Verify PostToolUse has the ingest and error-recall hooks
    const postToolUseHooks = settings.hooks.PostToolUse;
    const allCommands = postToolUseHooks.flatMap(
      (g: { hooks: Array<{ command: string }> }) =>
        g.hooks.map((h) => h.command)
    );
    expect(allCommands.some((c: string) => c.includes("ingest.js"))).toBe(true);
    expect(allCommands.some((c: string) => c.includes("error-recall.js"))).toBe(
      true
    );
  });

  it("skips hooks that already exist (dedup by command string)", async () => {
    const pkgRoot = "/opt/npm-global/lib/node_modules/exe-mem";

    // First run
    await installerModule.mergeHooks(pkgRoot, tmpHome);
    const firstRun = await readFile(
      path.join(tmpHome, ".claude", "settings.json"),
      "utf-8"
    );

    // Second run -- should skip all hooks
    const result = await installerModule.mergeHooks(pkgRoot, tmpHome);
    const secondRun = await readFile(
      path.join(tmpHome, ".claude", "settings.json"),
      "utf-8"
    );

    expect(result.added).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(3);
    expect(firstRun).toBe(secondRun);
  });

  it("preserves existing hooks and permissions in settings.json", async () => {
    const existing = {
      permissions: {
        allow: ["Bash(npm test)"],
        deny: ["Write(~/.ssh/*)"],
      },
      hooks: {
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [
              { type: "command", command: "echo custom-hook" },
            ],
          },
        ],
      },
    };
    await writeFile(
      path.join(tmpHome, ".claude", "settings.json"),
      JSON.stringify(existing, null, 2)
    );

    const pkgRoot = "/opt/npm-global/lib/node_modules/exe-mem";
    await installerModule.mergeHooks(pkgRoot, tmpHome);

    const settings = JSON.parse(
      await readFile(
        path.join(tmpHome, ".claude", "settings.json"),
        "utf-8"
      )
    );

    // Existing permissions preserved
    expect(settings.permissions.allow).toEqual(["Bash(npm test)"]);
    expect(settings.permissions.deny).toEqual(["Write(~/.ssh/*)"]);

    // Existing custom hook preserved
    const postToolUse = settings.hooks.PostToolUse;
    const customHookStillExists = postToolUse.some(
      (g: { hooks: Array<{ command: string }> }) =>
        g.hooks.some((h) => h.command === "echo custom-hook")
    );
    expect(customHookStillExists).toBe(true);

    // exe-mem hooks added alongside existing
    const allCommands = postToolUse.flatMap(
      (g: { hooks: Array<{ command: string }> }) =>
        g.hooks.map((h) => h.command)
    );
    expect(allCommands.some((c: string) => c.includes("ingest.js"))).toBe(true);
  });
});

describe("runInstaller", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), "exe-test-home-"));
    await mkdir(path.join(tmpHome, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it("orchestrates all three steps in order", async () => {
    // Suppress stderr output
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // Run installer with a temp home directory to avoid side effects
    await installerModule.runInstaller(tmpHome);

    // Verify MCP server was registered
    const claudeJson = JSON.parse(
      await readFile(path.join(tmpHome, ".claude.json"), "utf-8")
    );
    expect(claudeJson.mcpServers["exe-mem"]).toBeDefined();
    expect(claudeJson.mcpServers["exe-mem"].type).toBe("stdio");

    // Verify hooks were merged
    const settings = JSON.parse(
      await readFile(
        path.join(tmpHome, ".claude", "settings.json"),
        "utf-8"
      )
    );
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.UserPromptSubmit).toBeDefined();

    stderrSpy.mockRestore();
  });
});
