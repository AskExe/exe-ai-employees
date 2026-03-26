/**
 * Setup wizard for exe-ai-employees.
 *
 * Steps:
 * 1. Generate master key (or skip if exists)
 * 2. Sync configuration (Exe Cloud coming soon / local-only)
 * 3. Download embedding model
 * 4. Validate model
 * 5. Save config
 *
 * @module setup-wizard
 */

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import {
  MODELS_DIR,
  LEGACY_LANCE_PATH,
  loadConfig,
  saveConfig,
} from "./config.js";
import { getMasterKey, setMasterKey } from "./keychain.js";
import { downloadModel, LOCAL_FILENAME } from "./model-downloader.js";

export interface SetupOptions {
  skipModel?: boolean;
  skipModelValidation?: boolean;
  createReadline?: () => ReadlineInterface;
  log?: (msg: string) => void;
}

/**
 * Prompt for a single value from readline, re-prompting if empty.
 */
function ask(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const doAsk = (): void => {
      rl.question(prompt, (answer: string) => {
        resolve(answer.trim());
      });
    };
    doAsk();
  });
}

/**
 * Validate the model loads and produces 1024-dim embeddings.
 */
export async function validateModel(log: (msg: string) => void): Promise<void> {
  log("Validating model...");
  const { embedDirect } = await import("./embedder.js");
  const result = await embedDirect("test embedding");
  if (result.length !== 1024) {
    throw new Error(`Model produced ${result.length}-dim embeddings, expected 1024`);
  }
  log("Model validation passed (1024-dim embeddings confirmed).");
}

/**
 * Run the full setup wizard flow.
 */
export async function runSetupWizard(opts: SetupOptions = {}): Promise<void> {
  const {
    skipModel = false,
    skipModelValidation = false,
    log = (msg: string) => process.stderr.write(msg + "\n"),
  } = opts;

  const rl = opts.createReadline
    ? opts.createReadline()
    : createInterface({ input: process.stdin, output: process.stderr });

  try {
    log("");
    log("=== exe-ai-employees Setup ===");
    log("");

    // Step 0: Check for legacy v1.0 database
    if (existsSync(LEGACY_LANCE_PATH)) {
      log("Found v1.0 LanceDB at ~/.exe-mem/local.lance");
      log("  v1.1 uses libSQL (SQLite). Your existing memories are not automatically migrated.");
      log("  The old directory will not be modified or deleted.");
      log("");
    }

    // Step 1: Master key generation
    const existingKey = await getMasterKey();
    if (existingKey) {
      log("Encryption key already exists — skipping generation.");
    } else {
      log("Generating 256-bit encryption key...");
      const key = crypto.randomBytes(32);
      await setMasterKey(key);
      log("Encryption key generated and stored securely.");
    }
    log("");

    // Step 2: Sync configuration
    log("How do you want to sync?");
    log("");
    log("  1. Exe Cloud (Coming Soon)");
    log("     Zero-setup encrypted sync across machines.");
    log("     Sign up at askexe.com to get notified when available.");
    log("");
    log("  2. Local only (Recommended)");
    log("     No sync. Free forever. You can add sync later.");
    log("");

    const syncChoice = await ask(rl, "Choose [1/2]: ");

    if (syncChoice === "1") {
      log("");
      log("Exe Cloud is coming soon!");
      log("Sign up at https://askexe.com for early access.");
      log("Running in local-only mode for now.");
    } else {
      log("Running in local-only mode.");
    }
    log("");

    // Step 3: Download model (unless --skip-model)
    if (!skipModel) {
      log("Note: jina-embeddings-v5-text-small is licensed CC-BY-NC-4.0 (non-commercial)");
      log("");

      await downloadModel({
        destDir: MODELS_DIR,
        onProgress: (downloaded, total) => {
          const pct = ((downloaded / total) * 100).toFixed(1);
          const dlMB = (downloaded / 1e6).toFixed(0);
          const totalMB = (total / 1e6).toFixed(0);
          process.stderr.write(`\rDownloading model: ${pct}% (${dlMB}/${totalMB} MB)`);
        },
      });
      process.stderr.write("\n");
      log("Model downloaded and verified.");
    }

    // Step 4: Validate model
    if (!skipModel && !skipModelValidation) {
      await validateModel(log);
    }

    // Step 5: Save config
    const config = await loadConfig();
    await saveConfig(config);
    log("");

    // Step 6: Success summary
    log("=== Setup Complete ===");
    log("Database: " + config.dbPath);
    log("Sync: local-only");
    log("Encryption: SQLCipher (AES-256)");
    if (!skipModel) {
      log("Model: " + LOCAL_FILENAME);
    }
    log("");
  } finally {
    rl.close();
  }
}
