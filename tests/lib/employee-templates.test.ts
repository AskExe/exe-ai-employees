import { describe, it, expect } from "vitest";
import {
  DEFAULT_EXE,
  TEMPLATES,
  getTemplate,
} from "../../src/lib/employee-templates.js";

describe("employee-templates", () => {
  describe("DEFAULT_EXE", () => {
    it("has name 'exe'", () => {
      expect(DEFAULT_EXE.name).toBe("exe");
    });

    it("has role containing 'COO'", () => {
      expect(DEFAULT_EXE.role).toContain("COO");
    });

    it("has a createdAt ISO string", () => {
      expect(DEFAULT_EXE.createdAt).toBeTruthy();
      expect(new Date(DEFAULT_EXE.createdAt).toISOString()).toBe(
        DEFAULT_EXE.createdAt
      );
    });

    it("system prompt mentions coordinator role", () => {
      expect(DEFAULT_EXE.systemPrompt).toContain("coordinator");
    });

    it("system prompt mentions ask_team_memory", () => {
      expect(DEFAULT_EXE.systemPrompt).toContain("ask_team_memory");
    });
  });

  describe("TEMPLATES", () => {
    it("has yoshi, tom, mari keys", () => {
      expect(Object.keys(TEMPLATES)).toEqual(
        expect.arrayContaining(["yoshi", "tom", "mari"])
      );
      expect(Object.keys(TEMPLATES)).toHaveLength(3);
    });

    it("yoshi has role CTO and architecture mention", () => {
      expect(TEMPLATES.yoshi.role).toBe("CTO");
      expect(TEMPLATES.yoshi.systemPrompt.toLowerCase()).toContain(
        "architecture"
      );
    });

    it("yoshi has name and systemPrompt", () => {
      expect(TEMPLATES.yoshi.name).toBe("yoshi");
      expect(TEMPLATES.yoshi.systemPrompt.length).toBeGreaterThan(0);
    });

    it("mari has role CMO and design mention", () => {
      expect(TEMPLATES.mari.role).toBe("CMO");
      expect(TEMPLATES.mari.systemPrompt.toLowerCase()).toContain("design");
    });

    it("mari has name and systemPrompt", () => {
      expect(TEMPLATES.mari.name).toBe("mari");
      expect(TEMPLATES.mari.systemPrompt.length).toBeGreaterThan(0);
    });

    it("tom has role Principal Engineer", () => {
      expect(TEMPLATES.tom.role).toBe("Principal Engineer");
      expect(TEMPLATES.tom.name).toBe("tom");
      expect(TEMPLATES.tom.systemPrompt.length).toBeGreaterThan(0);
    });

    it("all templates have name, role, systemPrompt fields", () => {
      for (const [key, tmpl] of Object.entries(TEMPLATES)) {
        expect(tmpl.name).toBe(key);
        expect(typeof tmpl.role).toBe("string");
        expect(typeof tmpl.systemPrompt).toBe("string");
      }
    });
  });

  describe("getTemplate", () => {
    it("returns yoshi template", () => {
      const tmpl = getTemplate("yoshi");
      expect(tmpl).toBeDefined();
      expect(tmpl!.name).toBe("yoshi");
      expect(tmpl!.role).toBe("CTO");
    });

    it("returns undefined for unknown name", () => {
      expect(getTemplate("unknown")).toBeUndefined();
    });
  });
});
