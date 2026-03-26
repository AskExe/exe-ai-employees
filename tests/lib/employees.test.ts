import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  validateEmployeeName,
  loadEmployees,
  saveEmployees,
  addEmployee,
  getEmployee,
  EMPLOYEES_PATH,
  type Employee,
} from "../../src/lib/employees.js";

describe("employees", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "exe-emp-test-"));
    tmpFile = path.join(tmpDir, "exe-employees.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("EMPLOYEES_PATH", () => {
    it("ends with exe-employees.json", () => {
      expect(EMPLOYEES_PATH).toMatch(/exe-employees\.json$/);
    });
  });

  describe("validateEmployeeName", () => {
    it("accepts lowercase alphanumeric name", () => {
      expect(validateEmployeeName("yoshi")).toEqual({ valid: true });
    });

    it("accepts single letter name", () => {
      expect(validateEmployeeName("a")).toEqual({ valid: true });
    });

    it("accepts name with digits", () => {
      expect(validateEmployeeName("bot3")).toEqual({ valid: true });
    });

    it("rejects uppercase letters", () => {
      const result = validateEmployeeName("Yoshi");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("lowercase");
    });

    it("rejects empty name", () => {
      const result = validateEmployeeName("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects name exceeding 32 chars", () => {
      const result = validateEmployeeName("a".repeat(33));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("32");
    });

    it("accepts name of exactly 32 chars", () => {
      expect(validateEmployeeName("a".repeat(32))).toEqual({ valid: true });
    });

    it("rejects hyphenated names", () => {
      const result = validateEmployeeName("test-name");
      expect(result.valid).toBe(false);
    });

    it("rejects names with underscores", () => {
      const result = validateEmployeeName("test_name");
      expect(result.valid).toBe(false);
    });

    it("rejects names starting with a digit", () => {
      const result = validateEmployeeName("1bot");
      expect(result.valid).toBe(false);
    });
  });

  describe("loadEmployees", () => {
    it("returns empty array when file does not exist", async () => {
      const result = await loadEmployees(tmpFile);
      expect(result).toEqual([]);
    });
  });

  describe("saveEmployees + loadEmployees round-trip", () => {
    it("writes and reads back employee array", async () => {
      const employees: Employee[] = [
        {
          name: "yoshi",
          role: "CTO",
          systemPrompt: "You are yoshi.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      await saveEmployees(employees, tmpFile);
      const loaded = await loadEmployees(tmpFile);
      expect(loaded).toEqual(employees);
    });

    it("handles empty array", async () => {
      await saveEmployees([], tmpFile);
      const loaded = await loadEmployees(tmpFile);
      expect(loaded).toEqual([]);
    });
  });

  describe("addEmployee", () => {
    it("appends new employee to array", () => {
      const existing: Employee[] = [
        {
          name: "exe",
          role: "COO",
          systemPrompt: "You are exe.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      const newEmp: Employee = {
        name: "yoshi",
        role: "CTO",
        systemPrompt: "You are yoshi.",
        createdAt: "2026-01-02T00:00:00.000Z",
      };
      const result = addEmployee(existing, newEmp);
      expect(result).toHaveLength(2);
      expect(result[1]).toEqual(newEmp);
    });

    it("does not mutate original array", () => {
      const existing: Employee[] = [];
      const newEmp: Employee = {
        name: "yoshi",
        role: "CTO",
        systemPrompt: "You are yoshi.",
        createdAt: "2026-01-02T00:00:00.000Z",
      };
      addEmployee(existing, newEmp);
      expect(existing).toHaveLength(0);
    });

    it("throws on duplicate name", () => {
      const existing: Employee[] = [
        {
          name: "yoshi",
          role: "CTO",
          systemPrompt: "You are yoshi.",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      const dup: Employee = {
        name: "yoshi",
        role: "Developer",
        systemPrompt: "Dup.",
        createdAt: "2026-01-02T00:00:00.000Z",
      };
      expect(() => addEmployee(existing, dup)).toThrow(
        "Employee 'yoshi' already exists"
      );
    });
  });

  describe("getEmployee", () => {
    const employees: Employee[] = [
      {
        name: "exe",
        role: "COO",
        systemPrompt: "You are exe.",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        name: "yoshi",
        role: "CTO",
        systemPrompt: "You are yoshi.",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ];

    it("finds employee by name", () => {
      const result = getEmployee(employees, "exe");
      expect(result).toBeDefined();
      expect(result!.name).toBe("exe");
      expect(result!.role).toBe("COO");
    });

    it("returns undefined for unknown name", () => {
      expect(getEmployee(employees, "nobody")).toBeUndefined();
    });
  });
});
