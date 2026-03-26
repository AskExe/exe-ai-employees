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
  exportMnemonic: vi.fn(),
  importMnemonic: vi.fn(),
}));

// Mock config module to use temp paths
let mockExeAiDir = "";
const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();

vi.mock("../../src/lib/config.js", () => ({
  get EXE_AI_DIR() { return mockExeAiDir; },
  get MODELS_DIR() { return path.join(mockExeAiDir, "models"); },
  get LEGACY_LANCE_PATH() { return path.join(mockExeAiDir, "local.lance"); },
  get CONFIG_PATH() { return path.join(mockExeAiDir, "config.json"); },
  loadConfig: () => mockLoadConfig(),
  saveConfig: (config: unknown) => mockSaveConfig(config),
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
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("runSetupWizard", () => {
    it("generates master key when none exists", async () => {
      // Local-only mode (choose option 2)
      const rl = createMockReadline(["2"]);
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

      const rl = createMockReadline(["2"]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      expect(mockSetMasterKey).not.toHaveBeenCalled();
      expect(messages.join("\n")).toContain("already exists");
    });

    it("local-only mode when user chooses option 2", async () => {
      const rl = createMockReadline(["2"]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      const output = messages.join("\n");
      expect(output).toContain("local-only");
      expect(mockSaveConfig).toHaveBeenCalledOnce();
    });

    it("Exe Cloud coming soon when user chooses option 1", async () => {
      const rl = createMockReadline(["1"]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      const output = messages.join("\n");
      expect(output).toContain("coming soon");
      expect(output).toContain("local-only");
      expect(mockSaveConfig).toHaveBeenCalledOnce();
    });

    it("downloads model when skipModel is false", async () => {
      mockDownloadModel.mockResolvedValue("/path/to/model.gguf");

      const rl = createMockReadline(["2"]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: false,
        skipModelValidation: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      expect(mockDownloadModel).toHaveBeenCalledOnce();
    });

    it("prints encryption status in summary", async () => {
      const rl = createMockReadline(["2"]);
      const messages: string[] = [];

      await runSetupWizard({
        skipModel: true,
        createReadline: () => rl,
        log: (msg: string) => messages.push(msg),
      });

      const output = messages.join("\n");
      expect(output).toContain("AES-256");
      expect(output).toContain("Setup Complete");
    });
  });
});
