---
description: Set up exe-ai-employees — encryption and embedding model
allowed-tools: Bash, AskUserQuestion, Write, Read
---

Set up the exe-ai-employees memory system. Follow these steps exactly:

## Step 1: Run Setup Wizard

The setup wizard handles encryption key generation, sync configuration, and model download in one flow:

```bash
node "$(npm root -g)/exe-ai-employees/dist/bin/setup.js"
```

This will:
1. Generate a 256-bit encryption key (or skip if one exists)
2. Ask about sync preferences (local-only is the default)
3. Download the Jina v5-small embedding model (397MB) — required for semantic search
4. Validate the model produces correct embeddings

The model download may take a few minutes depending on your connection.

## Step 2: Confirm

After the wizard completes, tell the user:
- Setup complete
- Encryption: always on (SQLCipher AES-256)
- Their memories are stored locally at `~/.exe-mem/memories.db`
- They can change settings anytime with `/exe:settings`
- Memory capture starts automatically on their next session
