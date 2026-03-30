/**
 * Reminders — simple text reminders shown in boot brief.
 *
 * @module reminders
 */

import crypto from "node:crypto";
import { getClient } from "./turso.js";

export interface Reminder {
  id: string;
  text: string;
  createdAt: string;
  dueDate: string | null;
  completedAt: string | null;
}

export async function createReminder(text: string, dueDate?: string): Promise<Reminder> {
  const client = getClient();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO reminders (id, text, created_at, due_date) VALUES (?, ?, ?, ?)`,
    args: [id, text, now, dueDate ?? null],
  });

  return { id, text, createdAt: now, dueDate: dueDate ?? null, completedAt: null };
}

export async function listReminders(includeCompleted = false): Promise<Reminder[]> {
  const client = getClient();
  const sql = includeCompleted
    ? `SELECT id, text, created_at, due_date, completed_at FROM reminders ORDER BY due_date ASC NULLS LAST`
    : `SELECT id, text, created_at, due_date, completed_at FROM reminders WHERE completed_at IS NULL ORDER BY due_date ASC NULLS LAST`;

  const result = await client.execute(sql);

  return result.rows.map((row) => ({
    id: String(row.id),
    text: String(row.text),
    createdAt: String(row.created_at),
    dueDate: row.due_date ? String(row.due_date) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
  }));
}

export async function completeReminder(idOrText: string): Promise<Reminder | null> {
  const client = getClient();
  const now = new Date().toISOString();

  // Try exact UUID match first
  let result = await client.execute({
    sql: `SELECT id, text FROM reminders WHERE id = ? AND completed_at IS NULL`,
    args: [idOrText],
  });

  // Fallback: text substring match (case-insensitive)
  if (result.rows.length === 0) {
    result = await client.execute({
      sql: `SELECT id, text FROM reminders WHERE completed_at IS NULL AND text LIKE '%' || ? || '%'`,
      args: [idOrText],
    });
  }

  if (result.rows.length === 0) return null;

  const row = result.rows[0]!;
  const id = String(row.id);

  await client.execute({
    sql: `UPDATE reminders SET completed_at = ? WHERE id = ?`,
    args: [now, id],
  });

  return { id, text: String(row.text), createdAt: "", dueDate: null, completedAt: now };
}
