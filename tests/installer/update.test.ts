import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process and fs before importing the module under test
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  getLocalVersion,
  getRemoteVersion,
  checkForUpdate,
} from "../../src/bin/update.js";

const mockExecSync = vi.mocked(execSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("update version check", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("getLocalVersion", () => {
    it("reads version from package.json at the given path", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ name: "exe-ai-employees", version: "0.1.0" }),
      );

      const version = getLocalVersion("/some/package/root");

      expect(version).toBe("0.1.0");
      expect(mockReadFileSync).toHaveBeenCalledWith(
        "/some/package/root/package.json",
        "utf-8",
      );
    });
  });

  describe("getRemoteVersion", () => {
    it("returns trimmed output from npm view", () => {
      mockExecSync.mockReturnValue("0.2.0\n");

      const version = getRemoteVersion();

      expect(version).toBe("0.2.0");
      expect(mockExecSync).toHaveBeenCalledWith(
        "npm view exe-mem version",
        expect.objectContaining({
          encoding: "utf-8",
          timeout: 15000,
        }),
      );
    });

    it("returns null when execSync throws (npm unreachable)", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("npm ERR! code E404");
      });

      const version = getRemoteVersion();

      expect(version).toBeNull();
    });
  });

  describe("checkForUpdate", () => {
    it("returns updateAvailable: false when versions match", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: "0.1.0" }),
      );
      mockExecSync.mockReturnValue("0.1.0\n");

      const result = checkForUpdate("/pkg");

      expect(result.updateAvailable).toBe(false);
      expect(result.localVersion).toBe("0.1.0");
      expect(result.remoteVersion).toBe("0.1.0");
      expect(result.error).toBeUndefined();
    });

    it("returns updateAvailable: true when remote is newer", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: "0.1.0" }),
      );
      mockExecSync.mockReturnValue("0.2.0\n");

      const result = checkForUpdate("/pkg");

      expect(result.updateAvailable).toBe(true);
      expect(result.localVersion).toBe("0.1.0");
      expect(result.remoteVersion).toBe("0.2.0");
    });

    it("returns updateAvailable: false with error when registry unreachable", () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ version: "0.1.0" }),
      );
      mockExecSync.mockImplementation(() => {
        throw new Error("network error");
      });

      const result = checkForUpdate("/pkg");

      expect(result.updateAvailable).toBe(false);
      expect(result.localVersion).toBe("0.1.0");
      expect(result.remoteVersion).toBeUndefined();
      expect(result.error).toContain("npm registry");
    });
  });
});
