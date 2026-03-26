/**
 * Detect project name from git repo root.
 *
 * Uses `git rev-parse --show-toplevel` to find the repo root,
 * then takes its basename. Falls back to basename of cwd for
 * non-git directories. Result is cached per cwd.
 *
 * @module project-name
 */

import { execSync } from "node:child_process";
import path from "node:path";

let _cached: string | null = null;
let _cachedCwd: string | null = null;

export function getProjectName(cwd?: string): string {
  const dir = cwd ?? process.cwd();

  if (_cached && _cachedCwd === dir) return _cached;

  try {
    const repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    _cached = path.basename(repoRoot);
    _cachedCwd = dir;
    return _cached;
  } catch {
    // Not a git repo — fall back to basename of cwd
    _cached = path.basename(dir);
    _cachedCwd = dir;
    return _cached;
  }
}

/** Reset the cache (for testing). */
export function _resetCache(): void {
  _cached = null;
  _cachedCwd = null;
}
