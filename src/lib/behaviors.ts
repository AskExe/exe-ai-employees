/**
 * Behavioral memory — persistent per-employee patterns and corrections.
 *
 * Stores validated behaviors that load unconditionally at session start.
 * Cross-project with optional project scoping.
 *
 * @module behaviors
 */

import crypto from "node:crypto";
import { getClient } from "./turso.js";

export interface Behavior {
  id: string;
  agent_id: string;
  project_name: string | null;
  domain: string | null;
  content: string;
  active: number;
  created_at: string;
  updated_at: string;
}

/**
 * Store a new behavioral pattern. Returns the created behavior ID.
 */
export async function storeBehavior(opts: {
  agentId: string;
  content: string;
  domain?: string;
  projectName?: string;
}): Promise<string> {
  const client = getClient();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await client.execute({
    sql: `INSERT INTO behaviors (id, agent_id, project_name, domain, content, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [id, opts.agentId, opts.projectName ?? null, opts.domain ?? null, opts.content, now, now],
  });

  return id;
}

/**
 * List active behaviors for an agent, with optional project scoping.
 * Returns both global (project_name IS NULL) and project-scoped behaviors.
 */
export async function listBehaviors(
  agentId: string,
  projectName?: string,
  limit = 12,
): Promise<Behavior[]> {
  const client = getClient();
  const result = await client.execute({
    sql: `SELECT id, agent_id, project_name, domain, content, active, created_at, updated_at
          FROM behaviors
          WHERE agent_id = ? AND active = 1
            AND (project_name IS NULL OR project_name = ?)
          ORDER BY updated_at DESC LIMIT ?`,
    args: [agentId, projectName ?? "", limit],
  });

  return result.rows.map((r) => ({
    id: String(r.id),
    agent_id: String(r.agent_id),
    project_name: r.project_name ? String(r.project_name) : null,
    domain: r.domain ? String(r.domain) : null,
    content: String(r.content),
    active: Number(r.active),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }));
}

/**
 * List active behaviors in a specific domain for duplicate detection.
 */
export async function listBehaviorsByDomain(
  agentId: string,
  domain: string,
): Promise<Behavior[]> {
  const client = getClient();
  const result = await client.execute({
    sql: `SELECT id, agent_id, project_name, domain, content, active, created_at, updated_at
          FROM behaviors
          WHERE agent_id = ? AND domain = ? AND active = 1`,
    args: [agentId, domain],
  });

  return result.rows.map((r) => ({
    id: String(r.id),
    agent_id: String(r.agent_id),
    project_name: r.project_name ? String(r.project_name) : null,
    domain: r.domain ? String(r.domain) : null,
    content: String(r.content),
    active: Number(r.active),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }));
}

/**
 * Deactivate (archive) a behavior by ID. Sets active = 0.
 */
export async function deactivateBehavior(id: string): Promise<boolean> {
  const client = getClient();
  const result = await client.execute({
    sql: `UPDATE behaviors SET active = 0, updated_at = ? WHERE id = ? AND active = 1`,
    args: [new Date().toISOString(), id],
  });
  return (result.rowsAffected ?? 0) > 0;
}
