---
description: Search your memories for relevant past work
allowed-tools: Bash
---

Search your memories using keywords. Returns the most relevant past tool calls, errors, and outputs.

Usage: `/exe:search <query>`

Run this command with the user's query:
```bash
node "$(npm root -g)/exe-ai-employees/dist/bin/exe-search.js" "$ARGUMENTS"
```
