/**
 * Bare-bones task primitives — just data, no orchestration.
 * Schema matches exe-os for upgrade compatibility.
 *
 * @module tasks
 */

import crypto from "node:crypto";
import { getClient } from "./turso.js";

export interface Task {
  id: string;
  title: string;
  assignedTo: string;
  status: "open" | "in_progress" | "done";
  createdAt: string;
  updatedAt: string;
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    title: row.title as string,
    assignedTo: row.assigned_to as string,
    status: row.status as Task["status"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createTask(opts: {
  title: string;
  assignedTo: string;
}): Promise<Task> {
  const client = getClient();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO tasks (id, title, assigned_to, assigned_by, project_name, priority, status, created_at, updated_at)
          VALUES (?, ?, ?, 'exe', '', 'p1', 'open', ?, ?)`,
    args: [id, opts.title, opts.assignedTo, now, now],
  });

  return { id, title: opts.title, assignedTo: opts.assignedTo, status: "open", createdAt: now, updatedAt: now };
}

export async function listTasks(opts?: {
  assignedTo?: string;
  status?: string;
}): Promise<Task[]> {
  const client = getClient();
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (opts?.assignedTo) {
    conditions.push("assigned_to = ?");
    args.push(opts.assignedTo);
  }
  if (opts?.status) {
    conditions.push("status = ?");
    args.push(opts.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await client.execute({
    sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC`,
    args,
  });

  return result.rows.map((row) => rowToTask(row as Record<string, unknown>));
}

export async function updateTask(id: string, status: Task["status"]): Promise<boolean> {
  const client = getClient();
  const now = new Date().toISOString();
  const result = await client.execute({
    sql: "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
    args: [status, now, id],
  });
  return (result.rowsAffected ?? 0) > 0;
}
