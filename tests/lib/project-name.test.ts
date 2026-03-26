import { describe, it, expect, beforeEach } from "vitest";
import { getProjectName, _resetCache } from "../../src/lib/project-name.js";

describe("getProjectName", () => {
  beforeEach(() => {
    _resetCache();
  });

  it("returns repo root name for cwd inside a git repo", () => {
    const name = getProjectName(process.cwd());
    // Directory name depends on local clone — just verify it returns a non-empty string
    expect(name.length).toBeGreaterThan(0);
    expect(name).not.toBe("tmp");
  });

  it("resolves subdirectory to repo root name", () => {
    const name = getProjectName(process.cwd() + "/src");
    const rootName = getProjectName(process.cwd());
    expect(name).toBe(rootName);
  });

  it("falls back to basename for non-git directory", () => {
    const name = getProjectName("/tmp");
    expect(name).toBe("tmp");
  });

  it("caches result per cwd", () => {
    const first = getProjectName(process.cwd());
    const second = getProjectName(process.cwd());
    expect(first).toBe(second);
  });

  it("different cwds get different results", () => {
    const repo = getProjectName(process.cwd());
    _resetCache();
    const tmp = getProjectName("/tmp");
    expect(repo).not.toBe(tmp);
  });
});
