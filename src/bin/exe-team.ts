#!/usr/bin/env node
import { loadEmployees } from "../lib/employees.js";
import { initStore } from "../lib/store.js";
import { getClient } from "../lib/turso.js";
import { isMainModule } from "../lib/is-main.js";

async function main(): Promise<void> {
  const employees = await loadEmployees();

  if (employees.length === 0) {
    console.log(
      "No employees registered. Run /exe:new-employee to create one."
    );
    return;
  }

  // Initialize store to access memory counts
  await initStore();
  const client = getClient();

  // Gather memory counts per employee — query plaintext agent_id directly
  const counts: Map<string, number> = new Map();
  let totalMemories = 0;

  for (const emp of employees) {
    let count = 0;
    try {
      const result = await client.execute({
        sql: "SELECT COUNT(*) as cnt FROM memories WHERE agent_id = ?",
        args: [emp.name],
      });
      count = (result.rows[0]?.cnt as number) ?? 0;
    } catch {
      count = 0;
    }
    counts.set(emp.name, count);
    totalMemories += count;
  }

  // Print formatted table
  const nameWidth = Math.max(
    10,
    ...employees.map((e) => e.name.length)
  );
  const roleWidth = Math.max(
    21,
    ...employees.map((e) => e.role.length)
  );
  const memWidth = 8;
  const dateWidth = 19;

  console.log("Employee Roster");
  console.log("===============");
  console.log(
    `${"Name".padEnd(nameWidth)} | ${"Role".padEnd(roleWidth)} | ${"Memories".padEnd(memWidth)} | Created`
  );
  console.log(
    `${"-".repeat(nameWidth)}-|-${"-".repeat(roleWidth)}-|-${"-".repeat(memWidth)}-|-${"-".repeat(dateWidth)}`
  );

  for (const emp of employees) {
    const memCount = counts.get(emp.name) ?? 0;
    const created = emp.createdAt.slice(0, 10);
    console.log(
      `${emp.name.padEnd(nameWidth)} | ${emp.role.padEnd(roleWidth)} | ${String(memCount).padStart(memWidth)} | ${created}`
    );
  }

  console.log("");
  console.log(
    `Total: ${employees.length} employees, ${totalMemories} memories`
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { main };
