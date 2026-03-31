---
description: Set up exe-ai-employees — encryption, search model, and team
allowed-tools: Bash, AskUserQuestion, Write, Read
---

Set up exe-ai-employees. Follow these steps exactly:

## Step 1: Run Setup Wizard

The setup wizard handles everything in one flow:

```bash
node "$(npm root -g)/exe-ai-employees/dist/bin/setup.js"
```

This will:
1. Generate an encryption key and show your 24-word recovery phrase
2. Ask about sync preferences (local-only is the default)
3. Download the AI search model (~397MB, one-time)
4. Name your AI employees (CTO, Engineer, CMO)

The model download may take a few minutes depending on your connection.

## Step 2: Done

After the wizard completes, tell the user:
- Setup is complete — their data is encrypted and stored locally
- They can start using Claude Code normally — everything is recorded automatically
- Type /exe to meet their team coordinator
- They can change settings anytime with `/exe-settings`
