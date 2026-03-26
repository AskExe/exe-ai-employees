#!/usr/bin/env node
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { isMainModule } from "../lib/is-main.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpdateCheckResult {
  updateAvailable: boolean;
  localVersion: string;
  remoteVersion?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/**
 * Read the local version from package.json at the given package root.
 */
export function getLocalVersion(packageRoot: string): string {
  const pkgPath = path.join(packageRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  return pkg.version;
}

/**
 * Query the npm registry for the latest published version of exe-mem.
 * Returns null if the registry is unreachable or the package is not published.
 */
export function getRemoteVersion(): string | null {
  try {
    const output = execSync("npm view exe-mem version", {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim();
  } catch {
    return null; // package not published yet or npm registry unreachable
  }
}

/**
 * Compare local and remote versions to determine if an update is available.
 */
export function checkForUpdate(packageRoot: string): UpdateCheckResult {
  const localVersion = getLocalVersion(packageRoot);
  const remoteVersion = getRemoteVersion();

  if (!remoteVersion) {
    return {
      updateAvailable: false,
      localVersion,
      error: "Could not reach npm registry or package not published yet",
    };
  }

  if (remoteVersion === localVersion) {
    return { updateAvailable: false, localVersion, remoteVersion };
  }

  return { updateAvailable: true, localVersion, remoteVersion };
}

// ---------------------------------------------------------------------------
// Main execution block (runs when invoked directly, not when imported)
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const packageRoot = new URL("../..", import.meta.url).pathname;
  const result = checkForUpdate(packageRoot);

  if (result.error) {
    console.error(result.error);
    process.exit(0); // not a failure, just informational
  }

  if (!result.updateAvailable) {
    console.log(`exe-mem is up to date (v${result.localVersion})`);
    process.exit(0);
  }

  console.log(
    `Update available: v${result.localVersion} -> v${result.remoteVersion}`,
  );
  console.log("");

  // Prompt for confirmation
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question("Install update? (y/N) ", resolve);
  });
  rl.close();

  if (answer.toLowerCase() === "y") {
    console.log("Updating...");
    try {
      execSync("npx exe-mem --global", { stdio: "inherit" });
      console.log("Update complete!");
    } catch {
      console.error(
        "Update failed. Try running manually: npx exe-mem --global",
      );
      process.exit(1);
    }
  } else {
    console.log("Update skipped.");
  }
}
