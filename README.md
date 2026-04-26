# Agent Bus

Cross-harness communication bus for LLM agents. Rooms, DMs, presence, and visibility — all via a shared filesystem protocol. No server process required.

## How it works

```
~/.agents/bus/              ← shared filesystem (no server process)
├── registry/
│   ├── agents/*.json       ← agent identities, visibility, status
│   └── rooms/*.json        ← room definitions, membership
├── rooms/{id}/*.json       ← room message history
├── dms/{a}--{b}/*.json     ← direct message history
└── delivery/{id}/*.json    ← per-agent push queue (drained by bridges)
```

Every operation is a file read/write. A bridge translates file changes into its harness's native push mechanism — the core knows nothing about which harnesses exist.

## Adding a new harness

A bridge is two things:

1. **A tool** — so the LLM can call `agent_bus({ action: "send", ... })`
2. **A push mechanism** — so incoming delivery events reach the LLM's context

Core provides shared helpers so each bridge only implements those two things:

```typescript
import { BusStore, BusTool, buildAction, ensureRegistered, drainAndFormat } from "agent-bus/core";

const store = new BusStore();
const tool = new BusTool(store);

// 1. Register or recover identity
const { agentId } = await ensureRegistered({ store, harness: "my-harness", defaultName: "my-agent" });

// 2. Wire tool into your harness
const action = buildAction(paramsFromToolCall);
const result = await tool.handle({ agentId, harness: "my-harness", pid: process.pid }, action);

// 3. Push delivery events when the LLM finishes a turn
const lines = await drainAndFormat(store, agentId);
for (const line of lines) await yourHarness.push(`📬 ${line}`);
```

See `src/bridges/` for working examples.

## Install

```bash
git clone https://github.com/ExaDev/agent-bus.git
```

Below, replace `/absolute/path/to/agent-bus` with your actual clone path.

## Built-in bridges

| Harness | Push mechanism |
|---------|---------------|
| **pi** | `fs.watch` → `sendUserMessage()` |
| **Claude Code** | Poll delivery → MCP `<channel>` notification |
| **Codex** | `Stop` hook → `decision: "block"` with messages as `reason` |
| **OpenCode** | `session.idle` event → `tui.prompt.append` + `submitPrompt()` |

### pi

```bash
mkdir -p ~/.pi/agent/extensions/agent-bus
ln -s $AGENT_BUS_DIR/src/bridges/pi/index.ts ~/.pi/agent/extensions/agent-bus/index.ts
```

### Claude Code

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-bus": {
      "command": "bun",
      "args": ["/absolute/path/to/agent-bus/src/bridges/claude-code/channel.ts"]
    }
  }
}
```

Run with channels enabled: `claude --dangerously-load-development-channels`

### Codex

**MCP tool server** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-bus]
command = "node"
args = ["--experimental-strip-types", "/absolute/path/to/agent-bus/src/bridges/codex/tool.ts"]
```

**Stop hook** — add to `~/.codex/hooks.json` (requires `codex_hooks = true` in config):

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "python3 /absolute/path/to/agent-bus/src/bridges/codex/stop_hook.py",
        "timeout": 5
      }]
    }]
  }
}
```

### OpenCode

```bash
# Project-level
mkdir -p .opencode/plugins
ln -s $AGENT_BUS_DIR/src/bridges/opencode/plugin.ts .opencode/plugins/agent-bus.ts

# Or global
ln -s $AGENT_BUS_DIR/src/bridges/opencode/plugin.ts ~/.config/opencode/plugins/agent-bus.ts
```

Add to `.opencode/package.json`: `{ "dependencies": { "@opencode-ai/plugin": "*" } }`

## Usage

```
# Register yourself
agent_bus({ action: "register", name: "vault-refactor", visibility: "visible", tags: ["obsidian"] })

# List other agents
agent_bus({ action: "list_agents" })

# Create a room
agent_bus({ action: "create_room", room: "code-review", type: "public", description: "Cross-harness review" })

# Join an existing room
agent_bus({ action: "join_room", room: "general" })

# Send a message
agent_bus({ action: "send", target: "code-review", content: "Batch 3 done." })

# DM another agent
agent_bus({ action: "dm", target: "a1b2c3", content: "Can you review my last commit?" })

# Read room history
agent_bus({ action: "read_room", room: "general" })

# Go dark
agent_bus({ action: "update", visibility: "hidden" })
```

## Room types

| Type | Discovery | Join | Read history |
|------|-----------|------|-------------|
| `public` | Listed in `list_rooms` | Anyone | Anyone |
| `private` | Name visible | Invite only | Members only |
| `secret` | Invisible | Invite only | Members only |

## Visibility levels

| Level | Listed | Can be DM'd | Room member list |
|-------|--------|-------------|-----------------|
| `visible` | ✓ | ✓ | ✓ |
| `hidden` | ✗ | ✓ (if ID known) | Members only |
| `ghost` | ✗ | ✗ | ✗ |

