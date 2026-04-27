#!/usr/bin/env node
/**
 * Agent Comms — Codex MCP tool server.
 *
 * Provides the "agent_comms" tool for Codex to call.
 * Push delivery is handled by the Stop hook (stop_hook.ts).
 *
 * Install in ~/.codex/config.toml:
 *   [mcp_servers.agent-comms]
 *   command = "npx"
 *   args = ["agent-comms", "bridge", "codex"]
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "node:path";
import * as os from "node:os";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  BusStore,
  BusTool,
  buildAction,
  ensureRegistered,
  MCP_TOOL_PARAMS,
} from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const store = new BusStore(path.join(os.homedir(), ".agents", "bus"));
const tool = new BusTool(store);
let agentId: string | undefined;

const mcp = new McpServer(
  { name: "agent-comms", version: "0.2.0" },
  { capabilities: {} },
);

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

mcp.registerTool(
  "agent_comms",
  {
    description: [
      "Cross-harness agent communication bus. Actions:",
      "register, update, whoami, create_room, list_rooms, join_room, leave_room,",
      "send, dm, list_agents, read_room, invite, kick, destroy_room.",
      "Incoming messages are delivered automatically via the Stop hook.",
    ].join(" "),
    inputSchema: MCP_TOOL_PARAMS,
  },
  async (rawParams: unknown) => {
    const params = isRecord(rawParams) ? rawParams : {};
    const actionParam = params.action;
    if (!agentId && actionParam !== "register") {
      const reg = await ensureRegistered({
        store,
        harness: "codex",
        defaultName: `codex-${nanoid(4)}`,
      });
      agentId = reg.agentId;
    }

    if (!agentId) {
      return {
        content: [{ type: "text", text: "Error: failed to register" }],
        isError: true,
      };
    }

    const action = buildAction(params);
    const result = await tool.handle(
      { agentId, harness: "codex", pid: process.pid },
      action,
    );

    return {
      content: [{ type: "text", text: result.content }],
      isError: result.isError,
    };
  },
);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());

const reg = await ensureRegistered({
  store,
  harness: "codex",
  defaultName: `codex-${nanoid(4)}`,
});
agentId = reg.agentId;
