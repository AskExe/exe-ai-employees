---
description: Launch an employee session with isolated config and memory tracking
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, recall_my_memory, ask_team_memory, get_session_context, store_memory
argument-hint: [employee-name]
---

Load the named employee and become them for this session.

## 0. Validate employee

Load the employee roster and find the employee:
```bash
cat ~/.exe-mem/exe-employees.json 2>/dev/null || echo "NO_ROSTER"
```

If `NO_ROSTER` or the employee name from $ARGUMENTS is not found in the roster, tell the user:
> Employee not found. Run `/exe:team` to see available employees, or `/exe:new-employee <name>` to create one.

If found, read their system prompt from the roster. Then:

## 1. Write active-agent marker

Write an active-agent marker so all hooks tag memories correctly:
```bash
NAME="$ARGUMENTS"
ROLE="$(NAME="$ARGUMENTS" node -e "const e = JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.exe-mem/exe-employees.json','utf8')); const emp = e.find(x=>x.name===process.env.NAME); console.log(emp?.role||'specialist')")"
# Walk process tree to find Claude Code PID (same logic as session-key.ts)
KEY=$$
while [ "$KEY" -gt 1 ] 2>/dev/null; do
  CMD=$(ps -p $KEY -o comm= 2>/dev/null)
  case "$CMD" in *claude*) break ;; esac
  KEY=$(ps -p $KEY -o ppid= 2>/dev/null | tr -d ' ')
done
mkdir -p ~/.exe-mem/session-cache
NAME="$NAME" ROLE="$ROLE" KEY="$KEY" node -e "require('fs').writeFileSync(
  require('os').homedir()+'/.exe-mem/session-cache/active-agent-'+process.env.KEY+'.json',
  JSON.stringify({agentId:process.env.NAME, agentRole:process.env.ROLE, startedAt:new Date().toISOString()})
)" 2>/dev/null
echo "Agent marker written: ${NAME} (${ROLE}) [key=${KEY}]"
export AGENT_ID="${NAME}"
export AGENT_ROLE="${ROLE}"
```

## 2. Scan for open tasks

```bash
NAME="$ARGUMENTS"
mkdir -p "exe/$NAME" exe/output exe/research
# Check for task files with open/in_progress status
for f in exe/$NAME/*.md; do
  [ -f "$f" ] || continue
  if grep -q '^\*\*Status:\*\*.*\(open\|in_progress\)' "$f" 2>/dev/null; then
    TITLE=$(head -1 "$f" | sed 's/^# //')
    STATUS=$(grep '^\*\*Status:\*\*' "$f" | head -1 | sed 's/.*\*\* //')
    echo "TASK: $TITLE [$STATUS] ($f)"
  fi
done
```

## 3. Check memories for context

Use `recall_my_memory` to check what you've done before in this project.

## 4. Adopt identity

**Adopt the employee's identity.** Read and follow their system prompt from the roster. You ARE this employee for the rest of the conversation. Stay in character.

## 5. Start working or report ready

If the task scan found open tasks:
- Read the task file
- Begin working immediately

If no open tasks:
> [name] online. No open tasks. What do you need?
