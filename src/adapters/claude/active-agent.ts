/**
 * Resolves the active agent identity for the current Claude Code session.
 *
 * When `/exe-call <name>` runs, it writes a marker file keyed by the
 * Claude Code process PID (resolved via process tree walk in session-key.ts).
 * Hooks read this marker to determine the real agent identity, since the
 * process env still carries the parent session's AGENT_ID from settings.json.
 *
 * @module active-agent
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import { EXE_AI_DIR } from "../../lib/config.js";
import { getSessionKey } from "./session-key.js";

const CACHE_DIR = path.join(EXE_AI_DIR, "session-cache");
const STALE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface AgentIdentity {
  agentId: string;
  agentRole: string;
}

export interface ActiveSession {
  agentId: string;
  agentRole: string;
  startedAt: string;
  sessionKey: string;
}

function getMarkerPath(): string {
  return path.join(CACHE_DIR, `active-agent-${getSessionKey()}.json`);
}

/**
 * Write an active-agent marker for this Claude Code session.
 * Called by `/exe-call` before adopting the employee identity.
 */
export function writeActiveAgent(agentId: string, agentRole: string): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      getMarkerPath(),
      JSON.stringify({ agentId, agentRole, startedAt: new Date().toISOString() }),
    );
  } catch {
    // Non-critical — fall back to env vars
  }
}

/**
 * Remove the active-agent marker for this session.
 * Called by summary-worker on session end to prevent port reuse inheritance.
 */
export function clearActiveAgent(): void {
  try {
    unlinkSync(getMarkerPath());
  } catch {
    // May not exist — that's fine
  }
}

/**
 * Resolve the active agent for this session.
 * Reads the marker file first, falls back to process.env.
 */
export function getActiveAgent(): AgentIdentity {
  try {
    const markerPath = getMarkerPath();
    const raw = readFileSync(markerPath, "utf8");
    const data = JSON.parse(raw) as { agentId?: string; agentRole?: string; startedAt?: string };
    if (data.agentId) {
      // Ignore stale markers (> 24h) — SSE ports can be reused
      if (data.startedAt) {
        const age = Date.now() - new Date(data.startedAt).getTime();
        if (age > STALE_MS) {
          try { unlinkSync(markerPath); } catch { /* best effort */ }
          // Fall through to env
        } else {
          return {
            agentId: data.agentId,
            agentRole: data.agentRole || "employee",
          };
        }
      } else {
        return {
          agentId: data.agentId,
          agentRole: data.agentRole || "employee",
        };
      }
    }
  } catch {
    // No marker — fall through to env
  }

  return {
    agentId: process.env.AGENT_ID || "default",
    agentRole: process.env.AGENT_ROLE || "employee",
  };
}

/**
 * Scan all active-agent markers and return non-stale sessions.
 * Used to determine which employees are truly running.
 */
export function getAllActiveAgents(): ActiveSession[] {
  try {
    const files = readdirSync(CACHE_DIR);
    const sessions: ActiveSession[] = [];

    for (const file of files) {
      if (!file.startsWith("active-agent-") || !file.endsWith(".json")) continue;
      const key = file.slice("active-agent-".length, -".json".length);
      if (key === "undefined") continue; // Skip buggy markers

      try {
        const raw = readFileSync(path.join(CACHE_DIR, file), "utf8");
        const data = JSON.parse(raw) as { agentId?: string; agentRole?: string; startedAt?: string };
        if (!data.agentId) continue;

        if (data.startedAt) {
          const age = Date.now() - new Date(data.startedAt).getTime();
          if (age > STALE_MS) {
            try { unlinkSync(path.join(CACHE_DIR, file)); } catch {}
            continue;
          }
        }

        sessions.push({
          agentId: data.agentId,
          agentRole: data.agentRole || "employee",
          startedAt: data.startedAt || new Date().toISOString(),
          sessionKey: key,
        });
      } catch {
        // Skip corrupt files
      }
    }

    return sessions;
  } catch {
    return [];
  }
}

/**
 * Clean up stale markers on session startup.
 * Removes the marker for the current session key (leftover from a previous session)
 * and the buggy "undefined" marker from the old call.md bug.
 */
export function cleanupSessionMarkers(): void {
  const key = getSessionKey();
  try { unlinkSync(path.join(CACHE_DIR, `active-agent-${key}.json`)); } catch {}
  try { unlinkSync(path.join(CACHE_DIR, "active-agent-undefined.json")); } catch {}
}
