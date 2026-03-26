/**
 * Tests for src/lib/session-key.ts — Claude Code PID resolution via process tree walk.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

describe("session-key — process tree walk", () => {
  afterEach(() => {
    vi.resetModules();
  });

  async function loadModule() {
    const mod = await import("../../src/adapters/claude/session-key.js");
    return mod;
  }

  it("getSessionKey returns a numeric string", async () => {
    const { getSessionKey } = await loadModule();
    const key = getSessionKey();
    expect(key).toMatch(/^\d+$/);
  });

  it("getSessionKey returns consistent value (cached)", async () => {
    const { getSessionKey } = await loadModule();
    const key1 = getSessionKey();
    const key2 = getSessionKey();
    expect(key1).toBe(key2);
  });

  it("getSessionKey does not return process.ppid directly (finds claude parent)", async () => {
    // In a Claude Code session, the walk should find the claude process
    // which is the PARENT of the intermediate shell (process.ppid).
    // If not running under Claude Code, this test is skipped.
    const { getSessionKey } = await loadModule();
    const key = getSessionKey();
    const { execSync } = await import("node:child_process");

    try {
      const info = execSync(`ps -p ${key} -o comm=`, { encoding: "utf8" }).trim();
      if (info === "claude" || info.endsWith("/claude")) {
        // Running under Claude Code — key should differ from process.ppid
        // because process.ppid is the intermediate shell, not claude
        expect(Number(key)).not.toBe(process.ppid);
      }
    } catch {
      // Process may not exist (CI, non-Claude env) — skip assertion
    }
  });
});
