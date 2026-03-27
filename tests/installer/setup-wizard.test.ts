import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Interface as ReadlineInterface } from "node:readline";

// Mock model-downloader
const mockDownloadModel = vi.fn();
vi.mock("../../src/lib/model-downloader.js", () => ({
  downloadModel: (...args: unknown[]) => mockDownloadModel(...args),
  LOCAL_FILENAME: "jina-embeddings-v5-small-q8_0.gguf",
}));

// Mock keychain to use file fallback only
const mockGetMasterKey = vi.fn();
const mockSetMasterKey = vi.fn();
vi.mock("../../src/lib/keychain.js", () => ({
  getMasterKey: () => mockGetMasterKey(),
  setMasterKey: (key: Buffer) => mockSetMasterKey(key),
  deleteMasterKey: vi.fn().mockResolvedValue(undefined),
  exportMnemonic: vi.fn().mockResolvedValue("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"),
  importMnemonic: vi.fn(),
}));

// Mock config module to use temp paths
let mockExeAiDir = "";
const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();
const mockLoadConfigSync = vi.fn().mockReturnValue({ autoIngestion: true, autoRetrieval: true });

vi.mock("../../src/lib/config.js", () => ({
  get EXE_AI_DIR() { return mockExeAiDir; },
  get MODELS_DIR() { return path.join(mockExeAiDir, "models"); },
  get LEGACY_LANCE_PATH() { return path.join(mockExeAiDir, "local.lance"); },
  get CONFIG_PATH() { return path.join(mockExeAiDir, "config.json"); },
  loadConfig: () => mockLoadConfig(),
  loadConfigSync: () => mockLoadConfigSync(),
  saveConfig: (config: unknown) => mockSaveConfig(config),
}));

// Mock employees to avoid real filesystem access
const mockLoadEmployees = vi.fn();
const mockSaveEmployees = vi.fn();
vi.mock("../../src/lib/employees.js", () => ({
  loadEmployees: () => mockLoadEmployees(),
  saveEmployees: (employees: unknown) => mockSaveEmployees(employees),
  addEmployee: (employees: unknown[], employee: unknown) => [...(employees as unknown[]), employee],
  getEmployee: (employees: unknown[], name: string) => (employees as Array<{ name: string }>).find(e => e.name === name),
}));

import { runSetupWizard } from "../../src/lib/setup-wizard.js";

function createMockReadline(answers: string[]): ReadlineInterface {
  let idx = 0;
  return {
    question: (_prompt: string, callback: (answer: string) => void) => {
      callback(answers[idx++] ?? "");
    },
    close: vi.fn(),
  } as unknown as ReadlineInterface;
}

describe("setup-wizard v1.1", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "setup-wizard-test-"));
    mockExeAiDir = tmpDir;
    mockLoadConfig.mockResolvedValue({
      dbPath: path.join(tmpDir, "memories.db"),
      modelFile: "jina-embeddings-v5-small-q8_0.gguf",
      embeddingDim: 1024,
      batchSize: 20,
      flushIntervalMs: 10_000,
      autoIngestion: true,
      autoRetrieval: true,
      searchMode: "hybrid",
      hookSearchMode: "fts",
    });
    mockSaveConfig.mockResolvedValue(undefined);
    mockGetMasterKey.mockResolvedValue(null); // No key exists
    mockSetMasterKey.mockResolvedValue(undefined);
    mockLoadEmployees.mockResolvedValue([{ name: "exe", role: "COO", systemPrompt: "test", createdAt: "2026-01-01T00:00:00.000Z" }]);
    mockSaveEmployees.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("runSetupWizard", () => {
    it("generates master key when none exists", async () => {
      const rl = createMockReadline(["", "", "", ""]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      // Should have called setMasterKey with a 32-byte buffer
      expect(mockSetMasterKey).toHaveBeenCalledOnce();
      const key = mockSetMasterKey.mock.calls[0][0];
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    });

    it("skips key generation when key exists", async () => {
      mockGetMasterKey.mockResolvedValue(Buffer.alloc(32, 0xab));

      const rl = createMockReadline(["", "", ""]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      expect(mockSetMasterKey).not.toHaveBeenCalled();
      expect(messages.join("\n")).toContain("already exists");
    });

    it("local-only mode message shown", async () => {
      const rl = createMockReadline(["", "", "", ""]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      const output = messages.join("\n");
      expect(output).toContain("stored locally");
      expect(mockSaveConfig).toHaveBeenCalledOnce();
    });

    it("Exe Cloud coming soon note shown", async () => {
      const rl = createMockReadline(["", "", "", ""]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      const output = messages.join("\n");
      expect(output).toContain("coming soon");
      expect(output).toContain("stored locally");
      expect(mockSaveConfig).toHaveBeenCalledOnce();
    });

    it("downloads model when skipModel is false", async () => {
      mockDownloadModel.mockResolvedValue("/path/to/model.gguf");

      const rl = createMockReadline(["", "", "", ""]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: false,
        skipModelValidation: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      expect(mockDownloadModel).toHaveBeenCalledOnce();
    });

    it("prints friendly summary with next steps", async () => {
      const rl = createMockReadline(["", "", "", ""]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      const output = messages.join("\n");
      expect(output).toContain("Setup complete");
      expect(output).toContain("encrypted");
      expect(output).toContain("recording this session");
    });
  });
});
