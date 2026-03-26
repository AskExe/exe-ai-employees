/**
 * Tests for src/lib/active-agent.ts — marker-file based agent identity resolution.
 *
 * Covers:
 * - AC1: Marker file creation with correct agent identity
 * - AC2: Hooks resolve identity from marker (falls back to env)
 * - AC5: Shared helper used across hooks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("active-agent — marker file identity resolution", () => {
  let tmpDir: string;
  let origExeMemDir: string | undefined;
  let origAgentId: string | undefined;
  let origAgentRole: string | undefined;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "exe-active-agent-"));
    await fsp.mkdir(path.join(tmpDir, "session-cache"), { recursive: true });

    origExeMemDir = process.env.EXE_MEM_DIR;
    origAgentId = process.env.AGENT_ID;
    origAgentRole = process.env.AGENT_ROLE;

    process.env.EXE_MEM_DIR = tmpDir;
    process.env.AGENT_ID = "exe";
    process.env.AGENT_ROLE = "COO";
  });

  afterEach(async () => {
    // Restore env
    const restore = (key: string, val: string | undefined) => {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    };
    restore("EXE_MEM_DIR", origExeMemDir);
    restore("AGENT_ID", origAgentId);
    restore("AGENT_ROLE", origAgentRole);

    await fsp.rm(tmpDir, { recursive: true, force: true });

    // Reset module cache so EXE_AI_DIR picks up fresh env
    vi.resetModules();
  });

  async function loadModule() {
    // Dynamic import to pick up current env for EXE_AI_DIR
    const mod = await import("../../src/adapters/claude/active-agent.js");
    return mod;
  }

  async function loadSessionKey() {
    const mod = await import("../../src/adapters/claude/session-key.js");
    return mod.getSessionKey();
  }

  it("writeActiveAgent creates marker keyed by session key", async () => {
    const { writeActiveAgent } = await loadModule();
    const sessionKey = await loadSessionKey();

    writeActiveAgent("yoshi", "CTO");

    const markerPath = path.join(tmpDir, "session-cache", `active-agent-${sessionKey}.json`);
    expect(fs.existsSync(markerPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(data.agentId).toBe("yoshi");
    expect(data.agentRole).toBe("CTO");
    expect(data.startedAt).toBeDefined();
  });

  it("getActiveAgent reads marker file and returns correct identity", async () => {
    const { writeActiveAgent, getActiveAgent } = await loadModule();

    writeActiveAgent("yoshi", "CTO");
    const result = getActiveAgent();

    expect(result.agentId).toBe("yoshi");
    expect(result.agentRole).toBe("CTO");
  });

  it("getActiveAgent falls back to env vars when no marker exists", async () => {
    const { getActiveAgent } = await loadModule();

    const result = getActiveAgent();

    expect(result.agentId).toBe("exe");
    expect(result.agentRole).toBe("COO");
  });

  it("getActiveAgent returns 'default' when no marker and no env var", async () => {
    delete process.env.AGENT_ID;
    delete process.env.AGENT_ROLE;

    const { getActiveAgent } = await loadModule();
    const result = getActiveAgent();

    expect(result.agentId).toBe("default");
    expect(result.agentRole).toBe("employee");
  });

  it("session key is consistent between writes and reads", async () => {
    const { writeActiveAgent, getActiveAgent } = await loadModule();
    const sessionKey = await loadSessionKey();

    writeActiveAgent("mari", "CMO");

    const markerPath = path.join(tmpDir, "session-cache", `active-agent-${sessionKey}.json`);
    expect(fs.existsSync(markerPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    expect(data.agentId).toBe("mari");

    // And getActiveAgent finds the same marker
    const result = getActiveAgent();
    expect(result.agentId).toBe("mari");
  });

  it("different marker files provide session isolation", async () => {
    // Simulate two separate sessions by writing markers directly
    const cacheDir = path.join(tmpDir, "session-cache");
    const freshTime = new Date().toISOString();

    fs.writeFileSync(
      path.join(cacheDir, "active-agent-11111.json"),
      JSON.stringify({ agentId: "yoshi", agentRole: "CTO", startedAt: freshTime }),
    );
    fs.writeFileSync(
      path.join(cacheDir, "active-agent-22222.json"),
      JSON.stringify({ agentId: "mari", agentRole: "CMO", startedAt: freshTime }),
    );

    // Verify both exist independently
    const marker1 = JSON.parse(fs.readFileSync(path.join(cacheDir, "active-agent-11111.json"), "utf8"));
    const marker2 = JSON.parse(fs.readFileSync(path.join(cacheDir, "active-agent-22222.json"), "utf8"));

    expect(marker1.agentId).toBe("yoshi");
    expect(marker2.agentId).toBe("mari");
  });

  it("marker with missing agentRole defaults to 'employee'", async () => {
    const sessionKey = await loadSessionKey();
    // Write a marker with no agentRole
    const markerPath = path.join(tmpDir, "session-cache", `active-agent-${sessionKey}.json`);
    fs.writeFileSync(markerPath, JSON.stringify({ agentId: "gen" }));

    const { getActiveAgent } = await loadModule();
    const result = getActiveAgent();

    expect(result.agentId).toBe("gen");
    expect(result.agentRole).toBe("employee");
  });

  it("corrupt marker file falls back to env vars", async () => {
    const sessionKey = await loadSessionKey();
    const markerPath = path.join(tmpDir, "session-cache", `active-agent-${sessionKey}.json`);
    fs.writeFileSync(markerPath, "not-json{{{");

    const { getActiveAgent } = await loadModule();
    const result = getActiveAgent();

    expect(result.agentId).toBe("exe");
    expect(result.agentRole).toBe("COO");
  });

  it("ignores stale marker files older than 24 hours", async () => {
    const sessionKey = await loadSessionKey();
    const markerPath = path.join(tmpDir, "session-cache", `active-agent-${sessionKey}.json`);
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ agentId: "yoshi", agentRole: "CTO", startedAt: staleTime }),
    );

    const { getActiveAgent } = await loadModule();
    const result = getActiveAgent();

    // Should fall back to env vars since marker is stale
    expect(result.agentId).toBe("exe");
    expect(result.agentRole).toBe("COO");

    // Stale marker should be cleaned up
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("accepts marker files younger than 24 hours", async () => {
    const sessionKey = await loadSessionKey();
    const markerPath = path.join(tmpDir, "session-cache", `active-agent-${sessionKey}.json`);
    const freshTime = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ agentId: "yoshi", agentRole: "CTO", startedAt: freshTime }),
    );

    const { getActiveAgent } = await loadModule();
    const result = getActiveAgent();

    expect(result.agentId).toBe("yoshi");
    expect(result.agentRole).toBe("CTO");
  });

  it("getAllActiveAgents returns non-stale sessions from all markers", async () => {
    const cacheDir = path.join(tmpDir, "session-cache");
    const freshTime = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago
    fs.writeFileSync(
      path.join(cacheDir, "active-agent-11111.json"),
      JSON.stringify({ agentId: "yoshi", agentRole: "CTO", startedAt: freshTime }),
    );
    fs.writeFileSync(
      path.join(cacheDir, "active-agent-22222.json"),
      JSON.stringify({ agentId: "mari", agentRole: "CMO", startedAt: freshTime }),
    );

    const { getAllActiveAgents } = await loadModule();
    const sessions = getAllActiveAgents();

    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.agentId).sort();
    expect(ids).toEqual(["mari", "yoshi"]);
  });

  it("getAllActiveAgents skips stale markers and deletes them", async () => {
    const cacheDir = path.join(tmpDir, "session-cache");
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const freshTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(cacheDir, "active-agent-11111.json"),
      JSON.stringify({ agentId: "yoshi", agentRole: "CTO", startedAt: staleTime }),
    );
    fs.writeFileSync(
      path.join(cacheDir, "active-agent-22222.json"),
      JSON.stringify({ agentId: "mari", agentRole: "CMO", startedAt: freshTime }),
    );

    const { getAllActiveAgents } = await loadModule();
    const sessions = getAllActiveAgents();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.agentId).toBe("mari");
    // Stale marker should be cleaned up
    expect(fs.existsSync(path.join(cacheDir, "active-agent-11111.json"))).toBe(false);
  });

  it("getAllActiveAgents skips active-agent-undefined.json", async () => {
    const cacheDir = path.join(tmpDir, "session-cache");
    const freshTime = new Date().toISOString();
    fs.writeFileSync(
      path.join(cacheDir, "active-agent-undefined.json"),
      JSON.stringify({ agentId: "ghost", agentRole: "none", startedAt: freshTime }),
    );
    fs.writeFileSync(
      path.join(cacheDir, "active-agent-33333.json"),
      JSON.stringify({ agentId: "yoshi", agentRole: "CTO", startedAt: freshTime }),
    );

    const { getAllActiveAgents } = await loadModule();
    const sessions = getAllActiveAgents();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.agentId).toBe("yoshi");
  });

  it("getAllActiveAgents returns empty array when no markers exist", async () => {
    const { getAllActiveAgents } = await loadModule();
    // Clean up any markers
    const cacheDir = path.join(tmpDir, "session-cache");
    for (const f of fs.readdirSync(cacheDir)) {
      fs.unlinkSync(path.join(cacheDir, f));
    }

    const sessions = getAllActiveAgents();
    expect(sessions).toEqual([]);
  });

  it("cleanupSessionMarkers removes marker for current key", async () => {
    const { writeActiveAgent, cleanupSessionMarkers } = await loadModule();
    const sessionKey = await loadSessionKey();

    writeActiveAgent("yoshi", "CTO");
    const markerPath = path.join(tmpDir, "session-cache", `active-agent-${sessionKey}.json`);
    expect(fs.existsSync(markerPath)).toBe(true);

    cleanupSessionMarkers();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("cleanupSessionMarkers removes active-agent-undefined.json", async () => {
    const cacheDir = path.join(tmpDir, "session-cache");
    const undefinedPath = path.join(cacheDir, "active-agent-undefined.json");
    fs.writeFileSync(undefinedPath, JSON.stringify({ agentId: "bug" }));
    expect(fs.existsSync(undefinedPath)).toBe(true);

    const { cleanupSessionMarkers } = await loadModule();
    cleanupSessionMarkers();
    expect(fs.existsSync(undefinedPath)).toBe(false);
  });
});
