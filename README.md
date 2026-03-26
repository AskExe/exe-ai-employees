# exe-ai-employees

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white) ![License: MIT](https://img.shields.io/badge/license-MIT-green.svg) ![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white) ![MCP](https://img.shields.io/badge/protocol-MCP-8B5CF6) ![Local-first](https://img.shields.io/badge/local--first-yes-00C9A7)

> No company can be run by AI. But ONE person can have many AI employees, today.

**Persistent memory for Claude Code.** Your AI remembers every conversation, every fix, every decision — and finds them when they matter.

---

## The problem

Every time you start a new Claude Code session, your AI starts from zero. That debugging session last Tuesday? Gone. The deployment fix that took an hour to figure out? Forgotten. The architecture decision you talked through? Lost.

You end up re-explaining context, re-debugging the same issues, and watching your AI make the same mistakes twice.

## What exe-ai-employees does

It gives Claude Code a memory. Automatically.

Every tool call — every file read, every command run, every edit made — is captured and stored on your machine. The next time your AI needs that context, it finds it on its own. No copy-pasting. No "remember when we..." prompts. It just knows.

## Install

```bash
npm install -g exe-ai-employees
exe-ai --global
```

That's it. Two commands. The installer registers everything Claude Code needs — hooks, search tools, and slash commands.

On your first session, run `/exe:setup` inside Claude Code to generate your encryption key and download the search model.

## What you get

### Your AI remembers everything

Every tool call is silently recorded in the background. File edits, terminal commands, search results, errors — all of it. You don't need to do anything. It happens automatically.

### It finds what's relevant

When you're working on something, exe-ai-employees searches your past sessions and surfaces what's useful. Debugging a payment bug? It pulls up the last time you touched that code. Deploying to production? It remembers the gotchas from your last deploy.

This works two ways:
- **Keyword search** — fast, exact matching (~10ms)
- **Semantic search** — meaning-based matching using an AI model that runs on your machine. "Fix the auth bug" finds memories about "JWT token expiration in login handler" even though the words are completely different.

### Multiple agents, separate memories

If you run more than one AI agent (say, one for coding and one for content), each gets its own memory space. They can also look up what the other one did — useful when work overlaps.

### Your data stays on your machine

Everything is stored locally in an encrypted database. The embedding model runs on your device — no API calls, no data leaving your machine. Your work stays yours.

## How it works

```
You start a Claude Code session
        |
        v
Hooks silently capture every tool call ──> stored locally (encrypted)
        |
        v
You ask a question or start a task
        |
        v
exe-ai-employees searches your history ──> injects relevant context
        |
        v
Your AI responds with full context from past sessions
```

**Hooks** run in the background and capture your work. They add near-zero latency (~50ms) to each action.

**Search tools** let your AI actively look up past work when it needs to. These run through an MCP server that stays alive for your entire session, so searches are fast (~200ms).

**The embedding model** (397MB) runs locally on your machine. It converts your memories into searchable vectors. No API keys, no usage fees, no data sent anywhere.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js 18 or later

## Commands

| Command | What it does |
|---------|-------------|
| `/exe:setup` | First-time setup: encryption key + search model |
| `/exe:search "query"` | Search your memories |
| `/exe:settings` | Toggle memory capture, search modes |
| `/exe:forget` | Delete memories by ID, agent, or query |
| `/exe:team` | View registered agents and memory counts |
| `/exe:new-employee` | Create a new agent identity |

## MCP Tools

| Tool | Description |
|------|-------------|
| `recall_my_memory` | Search your past work using semantic + full-text hybrid search |
| `ask_team_memory` | Search another agent's memories |
| `store_memory` | Write a structured memory record |
| `get_session_context` | Get recent context from the current session |

## Development

```bash
git clone https://github.com/AskExe/exe-ai-employees.git
cd exe-ai-employees
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
