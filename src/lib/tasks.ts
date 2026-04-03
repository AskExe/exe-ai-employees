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
  status: "open" | "in_progress" | "done" | "blocked" | "cancelled";
  createdAt: string;
  updatedAt: string;
  /** Set when a near-duplicate active task already exists for the same assignee. */
  warning?: string;
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

  // Check for duplicate active task (same title + assignee)
  let warning: string | undefined;
  const dupCheck = await client.execute({
    sql: "SELECT id FROM tasks WHERE title = ? AND assigned_to = ? AND status IN ('open', 'in_progress')",
    args: [opts.title, opts.assignedTo],
  });
  if (dupCheck.rows.length > 0) {
    warning = `similar active task already exists (${String(dupCheck.rows[0]!.id)}). Created new task anyway.`;
  }

  await client.execute({
    sql: `INSERT INTO tasks (id, title, assigned_to, assigned_by, project_name, priority, status, created_at, updated_at)
          VALUES (?, ?, ?, 'exe', '', 'p1', 'open', ?, ?)`,
    args: [id, opts.title, opts.assignedTo, now, now],
  });

  return { id, title: opts.title, assignedTo: opts.assignedTo, status: "open", createdAt: now, updatedAt: now, warning };
}

export async function listTasks(opts?: {
  assignedTo?: string;
  status?: string;
  projectName?: string;
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
  if (opts?.projectName) {
    conditions.push("project_name = ?");
    args.push(opts.projectName);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await client.execute({
    sql: `SELECT * FROM tasks ${where} ORDER BY created_at DESC`,
    args,
  });

  return result.rows.map((row) => rowToTask(row as Record<string, unknown>));
}

/**
 * Resolve a task by UUID, slug (filename without .md), or title substring.
 * Throws if not found or ambiguous.
 */
export async function resolveTask(identifier: string): Promise<Task> {
  const client = getClient();

  // Try exact UUID match first
  const byId = await client.execute({
    sql: "SELECT * FROM tasks WHERE id = ?",
    args: [identifier],
  });
  if (byId.rows.length === 1) {
    return rowToTask(byId.rows[0] as Record<string, unknown>);
  }

  // Try slug match on task_file (e.g. "fix-auth-bug" matches "exe/yoshi/fix-auth-bug.md")
  const bySlug = await client.execute({
    sql: "SELECT * FROM tasks WHERE task_file LIKE ?",
    args: [`%${identifier}%`],
  });
  if (bySlug.rows.length === 1) {
    return rowToTask(bySlug.rows[0] as Record<string, unknown>);
  }
  if (bySlug.rows.length > 1) {
    throw new Error(
      `Multiple tasks match slug "${identifier}". Use a more specific identifier or the full UUID.`,
    );
  }

  // Try title substring match
  const byTitle = await client.execute({
    sql: "SELECT * FROM tasks WHERE title LIKE ?",
    args: [`%${identifier}%`],
  });
  if (byTitle.rows.length === 1) {
    return rowToTask(byTitle.rows[0] as Record<string, unknown>);
  }
  if (byTitle.rows.length > 1) {
    throw new Error(
      `Multiple tasks match "${identifier}". Use a more specific identifier or the full UUID.`,
    );
  }

  throw new Error(`Task not found: "${identifier}"`);
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
