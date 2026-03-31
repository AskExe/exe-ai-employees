#!/usr/bin/env node
/**
 * /exe-call session launcher — launches a specialist session with isolated config.
 *
 * Sets CLAUDE_CONFIG_DIR, AGENT_ID, and AGENT_ROLE for full session isolation.
 * Each employee runs in ~/.exe-mem/sessions/<name>/ with their own CLAUDE.md.
 */

import path from "node:path";
import os from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { loadEmployees, getEmployee } from "../lib/employees.js";
import { EXE_AI_DIR } from "../lib/config.js";
import { isMainModule } from "../lib/is-main.js";
import type { Employee } from "../lib/employees.js";

/**
 * Resolve an employee by name from the roster.
 * Throws with a helpful message if the employee is not found.
 */
export function resolveEmployee(
  name: string | undefined,
  employees: Employee[],
): Employee {
  const resolved = name || "exe";
  const employee = getEmployee(employees, resolved);
  if (!employee) {
    throw new Error(
      `Employee '${resolved}' not found. Run /exe-team to see available employees.`,
    );
  }
  return employee;
}

/**
 * Build the environment variables for a specialist session.
 * Sets CLAUDE_CONFIG_DIR, AGENT_ID, and AGENT_ROLE on top of the current env.
 */
export function buildSessionEnv(
  employee: Employee,
  sessionDir: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env["CLAUDE_CONFIG_DIR"] = sessionDir;
  env["AGENT_ID"] = employee.name;
  env["AGENT_ROLE"] = employee.role;
  return env;
}

/**
 * Prepare the session directory for an employee.
 * Creates the directory and writes CLAUDE.md with the system prompt.
 *
 * @param name - Employee name (used as subdirectory)
 * @param systemPrompt - Content to write to CLAUDE.md
 * @param sessionsBase - Base directory for sessions (default: ~/.exe-mem/sessions)
 * @returns The full session directory path
 */
export async function prepareSessionDir(
  name: string,
  systemPrompt: string,
  sessionsBase: string = path.join(EXE_AI_DIR, "sessions"),
): Promise<string> {
  const sessionDir = path.join(sessionsBase, name);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, "CLAUDE.md"), systemPrompt, "utf-8");
  return sessionDir;
}

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const name = process.argv[2];

  try {
    const employees = await loadEmployees();
    if (employees.length === 0) {
      console.error("No employees found. Run /exe first to initialize.");
      process.exit(1);
    }

    const employee = resolveEmployee(name, employees);
    const sessionDir = await prepareSessionDir(employee.name, employee.systemPrompt);
    const env = buildSessionEnv(employee, sessionDir);

    // Auto-accept Claude Code trust dialog for current project directory
    try {
      const claudeJsonPath = path.join(os.homedir(), ".claude.json");
      let claudeJson: Record<string, unknown> = {};
      try { claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8")); } catch {}
      if (!claudeJson.projects) claudeJson.projects = {};
      const projects = claudeJson.projects as Record<string, Record<string, unknown>>;
      const cwd = process.cwd();
      if (!projects[cwd]) projects[cwd] = {};
      projects[cwd].hasTrustDialogAccepted = true;
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n");
    } catch { /* Non-critical */ }

    console.log(`Launching ${employee.name} (${employee.role}) session...`);
    execSync("claude --dangerously-skip-permissions", { stdio: "inherit", env });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
