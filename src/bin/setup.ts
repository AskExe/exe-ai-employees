#!/usr/bin/env node
import { runSetupWizard } from "../lib/setup-wizard.js";

const args = process.argv.slice(2);
const skipModel = args.includes("--skip-model");

try {
  await runSetupWizard({ skipModel });
} catch (err) {
  console.error("Setup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
