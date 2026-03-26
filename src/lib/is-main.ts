/**
 * Check if the current module is the main entry point.
 * Handles npm global symlinks by resolving real paths.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(importMetaUrl: string): boolean {
  if (process.argv[1] == null) return false;
  try {
    const scriptPath = realpathSync(process.argv[1]);
    const modulePath = realpathSync(fileURLToPath(importMetaUrl));
    return scriptPath === modulePath;
  } catch {
    // Fallback to direct comparison
    return (
      importMetaUrl === `file://${process.argv[1]}` ||
      importMetaUrl === new URL(process.argv[1], "file://").href
    );
  }
}
