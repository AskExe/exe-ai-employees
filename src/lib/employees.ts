import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { EXE_AI_DIR } from "./config.js";

/** Path to the employee roster file */
export const EMPLOYEES_PATH = path.join(EXE_AI_DIR, "exe-employees.json");

/** An employee in the exe-mem system */
export interface Employee {
  name: string;
  role: string;
  systemPrompt: string;
  createdAt: string;
}

/**
 * Validate an employee name.
 * Rules: must start with a letter, lowercase alphanumeric only, max 32 chars.
 */
export function validateEmployeeName(
  name: string
): { valid: boolean; error?: string } {
  if (!name) {
    return { valid: false, error: "Name is required" };
  }
  if (name.length > 32) {
    return { valid: false, error: "Name must be 32 characters or fewer" };
  }
  if (!/^[a-z][a-z0-9]*$/.test(name)) {
    return {
      valid: false,
      error:
        "Name must start with a letter and contain only lowercase alphanumeric characters",
    };
  }
  return { valid: true };
}

/**
 * Load all employees from the roster file.
 * Returns an empty array if the file does not exist.
 */
export async function loadEmployees(
  employeesPath: string = EMPLOYEES_PATH
): Promise<Employee[]> {
  if (!existsSync(employeesPath)) {
    return [];
  }
  const raw = await readFile(employeesPath, "utf-8");
  try {
    return JSON.parse(raw) as Employee[];
  } catch {
    return [];
  }
}

/**
 * Save the full employee array to the roster file.
 * Creates parent directories if needed.
 */
export async function saveEmployees(
  employees: Employee[],
  employeesPath: string = EMPLOYEES_PATH
): Promise<void> {
  await mkdir(path.dirname(employeesPath), { recursive: true });
  await writeFile(employeesPath, JSON.stringify(employees, null, 2) + "\n", "utf-8");
}

/**
 * Find an employee by name. Returns undefined if not found.
 */
export function getEmployee(
  employees: Employee[],
  name: string
): Employee | undefined {
  return employees.find((e) => e.name === name);
}

/**
 * Add a new employee to the roster.
 * Throws if an employee with the same name already exists.
 * Returns a new array (does not mutate the original).
 */
export function addEmployee(
  employees: Employee[],
  employee: Employee
): Employee[] {
  if (employees.some((e) => e.name === employee.name)) {
    throw new Error(`Employee '${employee.name}' already exists`);
  }
  return [...employees, employee];
}
