/**
 * Review polling logic — extracted for testability.
 *
 * The daemon calls pollPendingReviews() on a 15-minute interval as a
 * fallback for when real-time intercoms (tmux send-keys on task completion)
 * get swallowed due to timing collisions or busy sessions.
 *
 * @module review-polling
 */

import { execSync } from "node:child_process";

const BUSY_PATTERN = /[✻✽✶✳·].*…|Running…/;

export interface ReviewPollDeps {
  /** List live tmux session names */
  listTmuxSessions: () => string[];
  /** Count pending review tasks for exe */
  countPendingReviews: () => Promise<number>;
  /** Capture the last N lines from a tmux session pane */
  capturePane: (session: string, lines: number) => string;
  /** Send intercom to a tmux session */
  sendIntercom: (session: string) => void;
}

export interface ReviewPollState {
  lastIntercomSent: Map<string, number>;
  intervalMs: number;
}

/**
 * Determine which exe sessions should receive a review intercom.
 *
 * Pure decision logic — side effects delegated to deps.
 * Returns the list of sessions that were sent an intercom.
 */
export async function pollPendingReviews(
  deps: ReviewPollDeps,
  state: ReviewPollState,
): Promise<string[]> {
  // Find live exe sessions
  let sessions: string[];
  try {
    sessions = deps.listTmuxSessions().filter(s => /^exe\d+$/.test(s));
  } catch {
    return [];
  }
  if (sessions.length === 0) return [];

  // Count pending reviews (global — not per-project)
  let reviewCount: number;
  try {
    reviewCount = await deps.countPendingReviews();
  } catch {
    return [];
  }
  if (reviewCount === 0) return [];

  const sent: string[] = [];

  for (const exeSession of sessions) {
    // Deduplication: skip if intercom sent < intervalMs ago
    const lastSent = state.lastIntercomSent.get(exeSession) ?? 0;
    if (Date.now() - lastSent < state.intervalMs) continue;

    // Check if session is idle
    try {
      const pane = deps.capturePane(exeSession, 5);
      if (BUSY_PATTERN.test(pane)) continue;
    } catch {
      continue; // Session gone or capture failed
    }

    // Idle with pending reviews — send intercom
    try {
      deps.sendIntercom(exeSession);
      state.lastIntercomSent.set(exeSession, Date.now());
      sent.push(exeSession);
    } catch {
      // Send failed — continue to next
    }
  }

  return sent;
}

/**
 * Create real deps backed by tmux + DB.
 * Used by the daemon; tests inject mocks instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRealDeps(getClient: () => any): ReviewPollDeps {
  return {
    listTmuxSessions: () => {
      return execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", {
        encoding: "utf8", timeout: 3000,
      }).trim().split("\n").filter(Boolean);
    },
    countPendingReviews: async () => {
      const client = getClient();
      const result = await client.execute({
        sql: `SELECT COUNT(*) as count FROM tasks
              WHERE assigned_to = 'exe'
              AND status IN ('open', 'in_progress')
              AND title LIKE '%Review:%'`,
        args: [],
      });
      return Number(result.rows[0]?.count ?? 0);
    },
    capturePane: (session, lines) => {
      return execSync(
        `tmux capture-pane -t ${JSON.stringify(session)} -p -S -${lines} 2>/dev/null`,
        { encoding: "utf8", timeout: 3000 },
      );
    },
    sendIntercom: (session) => {
      execSync(`tmux send-keys -t ${JSON.stringify(session)} '/exe-intercom' Enter 2>/dev/null`);
    },
  };
}
