---
description: Delete memories by ID, agent, or search query
allowed-tools: Bash
---

Delete memories from the local database. Requires confirmation before deletion.

Usage:
- `/exe-forget --id <memory-id>` — delete a single memory by ID
- `/exe-forget --agent <name>` — delete all memories for an employee
- `/exe-forget --query "<search>"` — delete memories matching a search query

```bash
node "$(npm root -g)/exe-ai-employees/dist/bin/exe-forget.js" "$ARGUMENTS"
```
