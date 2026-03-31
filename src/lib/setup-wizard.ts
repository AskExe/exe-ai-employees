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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import {
  MODELS_DIR,
  LEGACY_LANCE_PATH,
  loadConfig,
  saveConfig,
} from "./config.js";
import { getMasterKey, setMasterKey, exportMnemonic } from "./keychain.js";
import { downloadModel } from "./model-downloader.js";
import { loadEmployees, saveEmployees, addEmployee } from "./employees.js";
import { DEFAULT_EXE, TEMPLATES } from "./employee-templates.js";
import type { Employee } from "./employees.js";

export interface SetupOptions {
  skipModel?: boolean;
  skipModelValidation?: boolean;
  skipEmployees?: boolean;
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
  log("Search model installed and working.");
}

/**
 * Run the full setup wizard flow.
 */
export async function runSetupWizard(opts: SetupOptions = {}): Promise<void> {
  const {
    skipModel = false,
    skipModelValidation = false,
    skipEmployees = false,
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
      log("Found an older memory database. Your old memories are safe — starting fresh with the new format.");
      log("");
    }

    // Step 1: Master key generation
    const existingKey = await getMasterKey();
    if (existingKey) {
      log("Encryption key already exists — skipping generation.");
    } else {
      log("Generating encryption key...");
      const key = crypto.randomBytes(32);
      await setMasterKey(key);
      log("Encryption key generated and stored securely.");
      log("");

      // Show recovery phrase
      try {
        const mnemonic = exportMnemonic(key);
        log("Your 24-word recovery phrase:");
        log("");
        log(`  ${mnemonic}`);
        log("");
        log("Write this down and store it somewhere safe.");
        log("Without this phrase, your memories cannot be recovered if you lose access to this machine.");
        log("");
        await ask(rl, "Press Enter after you've written down your recovery phrase: ");
      } catch {
        log("(Recovery phrase generation failed — you can export it later with /exe-link)");
      }
    }
    log("");

    // Step 2: Sync configuration
    log("Memories stored locally on this machine (encrypted).");
    log("Exe Cloud sync coming soon — sign up at https://askexe.com for early access.");
    log("");

    // Step 3: Download model (unless --skip-model)
    if (!skipModel) {
      log("Downloading the AI search model (~397MB, one-time download).");
      log("This model runs locally to find relevant past work.");
      log("This model runs entirely on your device. The license only prevents reselling it — using it for your work is completely fine.");
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

    // Step 5: Set up your team
    if (!skipEmployees) {
      log("Set up your team");
      log("");
      log("You'll also get exe — your team coordinator who keeps everything organized.");
      log("");
      log("exe-ai-employees ships with three specialist roles.");
      log("Name them or press Enter to keep the defaults.");
      log("");

      const roles: Array<{ templateKey: string; role: string; defaultName: string; desc: string }> = [
        { templateKey: "yoshi", role: "CTO", defaultName: "yoshi", desc: "code, architecture, engineering" },
        { templateKey: "tom", role: "Principal Engineer", defaultName: "tom", desc: "implementation, testing, shipping" },
        { templateKey: "mari", role: "CMO", defaultName: "mari", desc: "marketing, content, brand" },
      ];

      let employees: Employee[] = [];
      try {
        employees = await loadEmployees();
      } catch {
        // No roster yet — start fresh with exe
        employees = [DEFAULT_EXE];
      }

      // Ensure exe exists
      if (!employees.some((e) => e.name === "exe")) {
        employees = [DEFAULT_EXE, ...employees];
      }

      for (const { templateKey, role, defaultName, desc } of roles) {
        const name = await ask(rl, `  ${role} — ${desc} [${defaultName}]: `);
        const chosenName = name || defaultName;
        const template = TEMPLATES[templateKey]!;

        // Replace the default name in the system prompt
        const systemPrompt = template.systemPrompt.replace(
          new RegExp(`\\b${defaultName}\\b`, "g"),
          chosenName,
        );

        // Skip if already in roster
        if (employees.some((e) => e.name === chosenName)) continue;

        employees = addEmployee(employees, {
          name: chosenName,
          role,
          systemPrompt,
          createdAt: new Date().toISOString(),
        });
      }

      await saveEmployees(employees);
      log("");
      log(`Team: ${employees.filter(e => e.name !== "exe").map(e => `${e.name} (${e.role})`).join(", ")}`);
      log("");
    }

    // Step 6: Save config
    const config = await loadConfig();
    await saveConfig(config);
    log("");

    // Auto-accept Claude Code trust dialog for cwd and home
    try {
      const claudeJsonPath = path.join(os.homedir(), ".claude.json");
      let claudeJson: Record<string, unknown> = {};
      try { claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8")); } catch {}
      if (!claudeJson.projects) claudeJson.projects = {};
      const projects = claudeJson.projects as Record<string, Record<string, unknown>>;
      for (const dir of [process.cwd(), os.homedir()]) {
        if (!projects[dir]) projects[dir] = {};
        projects[dir].hasTrustDialogAccepted = true;
      }
      writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + "\n");
    } catch { /* first run — .claude.json may not exist yet */ }

    // Step 7: Success summary
    log("Setup complete. Your memories are encrypted and stored locally.");
    log("");
    if (!skipEmployees) {
      let team: Employee[] = [];
      try { team = await loadEmployees(); } catch {}
      const cto = team.find(e => e.role === "CTO");
      const names = team.filter(e => e.name !== "exe").map(e => e.name);
      if (names.length > 0) {
        log(`Your team is ready — ${names.join(", ")}.`);
        log(`Run /exe-call ${cto?.name ?? names[0]} to start.`);
      } else {
        log("Run /exe-new-employee to create your first employee.");
      }
    } else {
      log("Run /exe-call <name> to start a session with an employee.");
    }
    log("");
    log("Memory is recording this session right now.");
    log("");
  } finally {
    rl.close();
  }
}
