/**
 * Resolves the Claude Code process PID for use as a stable session key.
 *
 * Neither bash $PPID nor Node process.ppid reliably point at Claude Code —
 * intermediate processes (shells, shims) sit between them. Both this module
 * and call.md walk up the process tree to find the `claude` process,
 * guaranteeing the same session key regardless of entry point.
 *
 * The result is cached for the lifetime of the process (it won't change).
 *
 * @module session-key
 */

import { execSync } from "node:child_process";

let _cached: string | null = null;

/**
 * Get the session key = Claude Code process PID.
 * Walks up the process tree from process.ppid until it finds `claude`.
 * Falls back to process.ppid if the walk fails (non-Claude environment).
 */
export function getSessionKey(): string {
  if (_cached) return _cached;

  let pid = process.ppid;
  for (let i = 0; i < 10; i++) {
    try {
      const info = execSync(`ps -p ${pid} -o ppid=,comm=`, {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
      const match = info.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) break;
      const [, ppid, cmd] = match;
      if (cmd === "claude" || cmd!.endsWith("/claude")) {
        _cached = String(pid);
        return _cached;
      }
      pid = parseInt(ppid!, 10);
      if (pid <= 1) break; // Reached init — stop
    } catch {
      break;
    }
  }

  // Fallback chain: SSE_PORT (stable but shared) > process.ppid (unstable)
  _cached = process.env.CLAUDE_CODE_SSE_PORT ?? String(process.ppid);
  return _cached;
}
