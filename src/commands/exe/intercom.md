---
description: Receive dispatched task via tmux send-keys and begin working
allowed-tools: Bash
---

# Intercom — Task Dispatch Receiver

Triggered by exe via `tmux send-keys -t {window} '/exe:intercom' Enter`. Scans the employee's task folder and starts working immediately if tasks exist.

```bash
# Session key: walk process tree to find Claude Code PID
KEY=$$
while [ "$KEY" -gt 1 ] 2>/dev/null; do
  CMD=$(ps -p $KEY -o comm= 2>/dev/null)
  case "$CMD" in *claude*) break ;; esac
  KEY=$(ps -p $KEY -o ppid= 2>/dev/null | tr -d ' ')
done
AGENT=$(KEY="$KEY" node -e "try { const a = JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.exe-mem/session-cache/active-agent-'+process.env.KEY+'.json','utf8')); console.log(a.agentId); } catch { console.log('UNKNOWN'); }" 2>/dev/null)

# Skip if no agent
if [ "$AGENT" = "UNKNOWN" ] || [ "$AGENT" = "default" ]; then
  exit 0
fi
```

Check your task folder for open tasks:
```bash
ls exe/"$AGENT"/*.md 2>/dev/null | head -5
```

### For employees
**If task files exist:** Read them, pick the highest-priority open one, and begin working immediately. Do not ask what to do.
**If no task files:** Stay silent.

---

## Context-full intercom format

When an employee's context window fills, they send this intercom to exe before stopping:

```
/exe:intercom context-full: <name> hit capacity. Checkpoint saved. Resume task <task-id>.
```

**What exe does when it receives this:**
1. Kill the employee's session: `tmux kill-session -t <name>-<exe-session>`
2. Create a resume task via `create_task` (auto-dispatches a fresh session)
3. Report to founder

**What the employee does before sending this:**
1. `store_memory` with text starting `"CONTEXT CHECKPOINT [<task-id>]: ..."` — captures current state
2. Send the context-full intercom to exe
3. Stop — do not continue working

**What the resumed session does on boot:**
1. `recall_my_memory("CONTEXT CHECKPOINT [<task-id>]")` — retrieves exact state
2. Continues from where the previous session stopped
