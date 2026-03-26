import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

/** Default directories for exe-mem data — overridable via EXE_MEM_DIR env var */
export const EXE_AI_DIR = process.env.EXE_MEM_DIR ?? path.join(os.homedir(), ".exe-mem");
export const DB_PATH = path.join(EXE_AI_DIR, "memories.db");
export const MODELS_DIR = path.join(EXE_AI_DIR, "models");
export const CONFIG_PATH = path.join(EXE_AI_DIR, "config.json");

/** @deprecated v1.0 path — used only for migration detection */
export const LEGACY_LANCE_PATH = path.join(EXE_AI_DIR, "local.lance");

export interface TursoConfig {
  url: string;
  authToken: string;
}

export interface CloudConfig {
  /** API key for Exe Cloud sync (exe_sk_...) */
  apiKey: string;
  /** Sync endpoint URL */
  endpoint: string;
}

export interface ExeAiConfig {
  turso?: TursoConfig;
  cloud?: CloudConfig;
  /** Path to local SQLite database (default: ~/.exe-mem/memories.db) */
  dbPath: string;
  modelFile: string;
  embeddingDim: number;
  batchSize: number;
  flushIntervalMs: number;
  /** Auto-ingest tool call outputs into memory (default: true) */
  autoIngestion: boolean;
  /** Auto-inject relevant memories into context (default: true) */
  autoRetrieval: boolean;
  /** Search mode for MCP tools: "hybrid" (vector + keywords) or "fts" (keywords only) (default: "hybrid") */
  searchMode: "hybrid" | "fts";
  /** Search mode for hooks: "fts" (fast, no model) or "hybrid" (better quality, uses daemon) (default: "hybrid") */
  hookSearchMode: "fts" | "hybrid";
}

const DEFAULT_CONFIG: ExeAiConfig = {
  dbPath: DB_PATH,
  modelFile: "jina-embeddings-v5-small-q4_k_m.gguf",
  embeddingDim: 1024,
  batchSize: 20,
  flushIntervalMs: 10_000,
  autoIngestion: true,
  autoRetrieval: true,
  searchMode: "hybrid",
  hookSearchMode: "hybrid",
};

/**
 * Strip legacy v1.0 fields and log deprecation warnings.
 */
function migrateLegacyConfig(raw: Record<string, unknown>): Record<string, unknown> {
  if ("r2" in raw) {
    process.stderr.write(
      "[exe-mem] Warning: config.json contains deprecated 'r2' field from v1.0. " +
      "R2 sync has been replaced by Turso in v1.1. The 'r2' field will be ignored.\n"
    );
    delete raw.r2;
  }
  if ("syncIntervalMs" in raw) {
    delete raw.syncIntervalMs;
  }
  return raw;
}

/**
 * Load exe-mem configuration from ~/.exe-mem/config.json.
 * Returns defaults merged with any user overrides.
 * Creates the ~/.exe-mem/ directory if it does not exist.
 */
export async function loadConfig(): Promise<ExeAiConfig> {
  const dir = process.env.EXE_MEM_DIR ?? EXE_AI_DIR;
  await mkdir(dir, { recursive: true });

  const configPath = path.join(dir, "config.json");
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, dbPath: path.join(dir, "memories.db") };
  }

  const raw = await readFile(configPath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migrated = migrateLegacyConfig(parsed);
    const config = { ...DEFAULT_CONFIG, dbPath: path.join(dir, "memories.db"), ...migrated };
    // Expand ~ in dbPath — libsql doesn't handle tilde
    if (config.dbPath.startsWith("~")) {
      config.dbPath = config.dbPath.replace(/^~/, os.homedir());
    }
    return config;
  } catch {
    return { ...DEFAULT_CONFIG, dbPath: path.join(dir, "memories.db") };
  }
}

/**
 * Synchronous config read for hooks that need a fast check before imports.
 * Returns defaults if config file doesn't exist or is malformed.
 */
export function loadConfigSync(): ExeAiConfig {
  const dir = process.env.EXE_MEM_DIR ?? EXE_AI_DIR;
  const configPath = path.join(dir, "config.json");
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, dbPath: path.join(dir, "memories.db") };
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migrated = migrateLegacyConfig(parsed);
    return { ...DEFAULT_CONFIG, dbPath: path.join(dir, "memories.db"), ...migrated };
  } catch {
    return { ...DEFAULT_CONFIG, dbPath: path.join(dir, "memories.db") };
  }
}

/**
 * Save configuration to ~/.exe-mem/config.json.
 * Creates the directory if it doesn't exist. Preserves existing fields.
 */
export async function saveConfig(config: ExeAiConfig): Promise<void> {
  const dir = process.env.EXE_MEM_DIR ?? EXE_AI_DIR;
  await mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Load config from a specific path (used in tests).
 */
export async function loadConfigFrom(configPath: string): Promise<ExeAiConfig> {
  const raw = await readFile(configPath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migrated = migrateLegacyConfig(parsed);
    return { ...DEFAULT_CONFIG, ...migrated };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
