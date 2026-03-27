/**
 * Messaging module — local inter-agent message queue backed by libSQL.
 *
 * Simple write-to-DB, read-from-DB message passing between agents.
 * Delivery/orchestration is left to the user — this module just
 * provides the queue.
 *
 * @module messaging
 */

import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { getClient } from "./turso.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  id: string;
  fromAgent: string;
  targetAgent: string;
  targetProject: string | null;
  content: string;
  priority: "normal" | "urgent";
  status: "pending" | "delivered" | "processed" | "failed";
  createdAt: string;
  deliveredAt: string | null;
  processedAt: string | null;
}

export interface SendMessageInput {
  fromAgent: string;
  targetAgent: string;
  targetProject?: string;
  content: string;
  priority?: "normal" | "urgent";
}

// ---------------------------------------------------------------------------
// ULID generator (time-sortable unique ID — no external dependency)
// ---------------------------------------------------------------------------

function generateUlid(): string {
  const timestamp = Date.now().toString(36).padStart(10, "0");
  const random = crypto.randomBytes(10).toString("hex").slice(0, 16);
  return (timestamp + random).toUpperCase();
}

// ---------------------------------------------------------------------------
// Row → Message mapper
// ---------------------------------------------------------------------------

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    fromAgent: row.from_agent as string,
    targetAgent: row.target_agent as string,
    targetProject: (row.target_project as string) ?? null,
    content: row.content as string,
    priority: (row.priority as "normal" | "urgent") ?? "normal",
    status: (row.status as Message["status"]) ?? "pending",
    createdAt: row.created_at as string,
    deliveredAt: (row.delivered_at as string) ?? null,
    processedAt: (row.processed_at as string) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a message to the DB. Stays as 'pending' until the recipient reads it.
 */
export async function sendMessage(input: SendMessageInput): Promise<Message> {
  const client = getClient();
  const id = generateUlid();
  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO messages (id, from_agent, target_agent, target_project, content, priority, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    args: [
      id,
      input.fromAgent,
      input.targetAgent,
      input.targetProject ?? null,
      input.content,
      input.priority ?? "normal",
      now,
    ],
  });

  const result = await client.execute({
    sql: "SELECT * FROM messages WHERE id = ?",
    args: [id],
  });

  return rowToMessage(result.rows[0] as Record<string, unknown>);
}

/**
 * Get pending messages for an agent.
 */
export async function getPendingMessages(targetAgent: string): Promise<Message[]> {
  const client = getClient();
  const result = await client.execute({
    sql: `SELECT * FROM messages
          WHERE target_agent = ? AND status IN ('pending', 'delivered')
          ORDER BY id`,
    args: [targetAgent],
  });

  return result.rows.map((row) => rowToMessage(row as Record<string, unknown>));
}

/**
 * Mark a message as delivered (recipient's session received it).
 */
export async function markDelivered(messageId: string): Promise<void> {
  const client = getClient();
  await client.execute({
    sql: "UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?",
    args: [new Date().toISOString(), messageId],
  });
}

/**
 * Mark a message as processed by the recipient.
 */
export async function markProcessed(messageId: string): Promise<void> {
  const client = getClient();
  await client.execute({
    sql: "UPDATE messages SET status = 'processed', processed_at = ? WHERE id = ?",
    args: [new Date().toISOString(), messageId],
  });
}

// ---------------------------------------------------------------------------
// Basic tmux delivery — find session, push intercom
// ---------------------------------------------------------------------------

/** Get the current tmux session name, or null if not in tmux. */
function getMyTmuxSession(): string | null {
  try {
    return execSync("tmux display-message -p '#{session_name}'", {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Extract the root exe session from a session name: yoshi-exe1 → exe1 */
function extractExeSession(sessionName: string): string | null {
  const match = sessionName.match(/(exe\d+)$/);
  return match?.[1] ?? null;
}

/** Check if a tmux session exists. */
function tmuxSessionExists(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${JSON.stringify(name)}`, {
      timeout: 3000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to deliver a message via tmux send-keys.
 * Constructs exact session name: `{agent}-{exeSession}` — never prefix-matches.
 * Returns true if intercom was sent, false if session not found.
 */
export function deliverViaTmux(targetAgent: string): boolean {
  const mySession = getMyTmuxSession();
  if (!mySession) return false;

  const exeSession = extractExeSession(mySession);
  if (!exeSession) return false;

  const targetSession = `${targetAgent}-${exeSession}`;
  if (!tmuxSessionExists(targetSession)) return false;

  try {
    execSync(
      `tmux send-keys -t ${JSON.stringify(targetSession)} '/exe:intercom' Enter`,
      { timeout: 3000, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}
