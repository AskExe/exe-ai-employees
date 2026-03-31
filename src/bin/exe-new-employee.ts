#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  loadEmployees,
  saveEmployees,
  addEmployee,
  validateEmployeeName,
} from "../lib/employees.js";
import { getTemplate, buildCustomEmployeePrompt } from "../lib/employee-templates.js";
import type { Employee } from "../lib/employees.js";
import { isMainModule } from "../lib/is-main.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse --template flag
  let templateName: string | undefined;
  let name: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--template" && i + 1 < args.length) {
      templateName = args[i + 1];
      i++; // skip next arg
    } else if (!name) {
      name = args[i];
    }
  }

  if (!name) {
    console.error("Usage: exe-new-employee <name> [--template <template>]");
    process.exit(1);
  }

  // Validate name
  const validation = validateEmployeeName(name);
  if (!validation.valid) {
    console.error(`Invalid name: ${validation.error}`);
    process.exit(1);
  }

  // Load existing employees
  const employees = await loadEmployees();

  // Build the new employee
  let newEmployee: Employee;

  // Auto-detect template: explicit --template flag, or match by name
  const effectiveTemplate = templateName ?? name;
  const template = getTemplate(effectiveTemplate);

  if (templateName && !template) {
    console.error(
      `Unknown template: ${templateName}. Available templates: yoshi, mari, tom`
    );
    process.exit(1);
  }

  if (template) {
    newEmployee = {
      ...template,
      name,
      createdAt: new Date().toISOString(),
    };
  } else {
    newEmployee = {
      name,
      role: "specialist",
      systemPrompt: buildCustomEmployeePrompt(name, "specialist"),
      createdAt: new Date().toISOString(),
    };
  }

  // Add to roster (checks for duplicates)
  let updated: Employee[];
  try {
    updated = addEmployee(employees, newEmployee);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Save
  await saveEmployees(updated);

  // Create employee task folder in current working directory
  const taskDir = path.join(process.cwd(), "exe", name);
  if (!existsSync(taskDir)) {
    mkdirSync(taskDir, { recursive: true });
  }

  console.log(`Created employee: ${newEmployee.name} (${newEmployee.role})`);
  console.log(`Run /exe-call ${newEmployee.name} to start a session.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

export { main };
