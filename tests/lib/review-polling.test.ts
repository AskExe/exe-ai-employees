/**
 * Tests for src/lib/review-polling.ts — pure logic tests (no tmux or DB required).
 */

import { describe, it, expect, vi } from "vitest";
import { pollPendingReviews, type ReviewPollDeps, type ReviewPollState } from "../../src/lib/review-polling.js";

function createMockDeps(overrides?: Partial<ReviewPollDeps>): ReviewPollDeps {
  return {
    listTmuxSessions: () => ["exe1", "exe2", "yoshi-exe1"],
    countPendingReviews: async () => 3,
    capturePane: () => "❯ ", // idle prompt
    sendIntercom: vi.fn(),
    ...overrides,
  };
}

function createState(overrides?: Partial<ReviewPollState>): ReviewPollState {
  return {
    lastIntercomSent: new Map(),
    intervalMs: 15 * 60 * 1000,
    ...overrides,
  };
}

describe("review-polling", () => {
  describe("pollPendingReviews", () => {
    it("sends intercom to idle exe sessions with pending reviews", async () => {
      const deps = createMockDeps();
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual(["exe1", "exe2"]);
      expect(deps.sendIntercom).toHaveBeenCalledTimes(2);
      expect(deps.sendIntercom).toHaveBeenCalledWith("exe1");
      expect(deps.sendIntercom).toHaveBeenCalledWith("exe2");
    });

    it("filters out non-exe sessions (employee sessions)", async () => {
      const deps = createMockDeps({
        listTmuxSessions: () => ["yoshi-exe1", "mari-exe2", "tom2-exe1"],
      });
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual([]);
      expect(deps.sendIntercom).not.toHaveBeenCalled();
    });

    it("skips when no pending reviews", async () => {
      const deps = createMockDeps({ countPendingReviews: async () => 0 });
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual([]);
      expect(deps.sendIntercom).not.toHaveBeenCalled();
    });

    it("skips busy sessions (spinner detected)", async () => {
      const deps = createMockDeps({
        listTmuxSessions: () => ["exe1", "exe2"],
        capturePane: (session) =>
          session === "exe1" ? "✻ Reading file…" : "❯ ",
      });
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual(["exe2"]);
    });

    it("skips busy sessions (Running tool)", async () => {
      const deps = createMockDeps({
        listTmuxSessions: () => ["exe1"],
        capturePane: () => "Running…",
      });
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual([]);
    });

    it("deduplicates — skips sessions with recent intercom", async () => {
      const deps = createMockDeps({ listTmuxSessions: () => ["exe1"] });
      const state = createState();
      state.lastIntercomSent.set("exe1", Date.now() - 5 * 60 * 1000); // 5 min ago

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual([]);
      expect(deps.sendIntercom).not.toHaveBeenCalled();
    });

    it("sends after dedup interval expires", async () => {
      const deps = createMockDeps({ listTmuxSessions: () => ["exe1"] });
      const state = createState();
      state.lastIntercomSent.set("exe1", Date.now() - 16 * 60 * 1000); // 16 min ago

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual(["exe1"]);
    });

    it("updates lastIntercomSent on successful send", async () => {
      const deps = createMockDeps({ listTmuxSessions: () => ["exe1"] });
      const state = createState();
      const before = Date.now();

      await pollPendingReviews(deps, state);

      expect(state.lastIntercomSent.has("exe1")).toBe(true);
      expect(state.lastIntercomSent.get("exe1")!).toBeGreaterThanOrEqual(before);
    });

    it("returns empty array when tmux is unavailable", async () => {
      const deps = createMockDeps({
        listTmuxSessions: () => { throw new Error("tmux not found"); },
      });
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual([]);
    });

    it("returns empty array when DB query fails", async () => {
      const deps = createMockDeps({
        countPendingReviews: async () => { throw new Error("DB error"); },
      });
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual([]);
    });

    it("continues to next session when capturePane fails", async () => {
      const deps = createMockDeps({
        listTmuxSessions: () => ["exe1", "exe2"],
        capturePane: (session) => {
          if (session === "exe1") throw new Error("session gone");
          return "❯ ";
        },
      });
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual(["exe2"]);
    });

    it("continues to next session when sendIntercom fails", async () => {
      const sendIntercom = vi.fn((session: string) => {
        if (session === "exe1") throw new Error("send failed");
      });
      const deps = createMockDeps({
        listTmuxSessions: () => ["exe1", "exe2"],
        sendIntercom,
      });
      const state = createState();

      const sent = await pollPendingReviews(deps, state);

      expect(sent).toEqual(["exe2"]);
      expect(sendIntercom).toHaveBeenCalledTimes(2);
    });
  });
});
