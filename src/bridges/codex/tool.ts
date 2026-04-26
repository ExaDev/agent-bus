#!/usr/bin/env node
/**
 * Agent Bus — Codex MCP tool server.
 *
 * Provides the "agent_bus" tool for Codex to call.
 * Push delivery is handled by the Stop hook (stop_hook.py).
 *
 * Install in ~/.codex/config.toml:
 *   [mcp_servers.agent-bus]
 *   command = "node"
 *   args = ["--experimental-strip-types", "~/Developer/agent-bus/src/bridges/codex/tool.ts"]
 *
 * Or: codex mcp add agent-bus -- node --experimental-strip-types ~/Developer/agent-bus/src/bridges/codex/tool.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import * as os from "node:os";

import {
  BusStore,
  BusTool,
  buildAction,
  ensureRegistered,
  MCP_TOOL_SCHEMA,
} from "../../core/index.js";
import type { AgentId } from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const store = new BusStore(path.join(os.homedir(), ".agents", "bus"));
const tool = new BusTool(store);
let agentId: AgentId | undefined;

const mcp = new Server(
  { name: "agent-bus", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "agent_bus",
      description: [
        "Cross-harness agent communication bus. Actions:",
        "register, update, whoami, create_room, list_rooms, join_room, leave_room,",
        "send, dm, list_agents, read_room, invite, kick, destroy_room.",
        "Incoming messages are delivered automatically via the Stop hook.",
      ].join(" "),
      inputSchema: MCP_TOOL_SCHEMA,
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "agent_bus") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }

  const params = req.params.arguments as Record<string, unknown>;
  if (!params) throw new Error("No arguments provided");

  if (!agentId && params.action !== "register") {
    const reg = await ensureRegistered({ store, harness: "codex", defaultName: `codex-${nanoid(4)}` });
    agentId = reg.agentId;
  }

  if (!agentId) {
    return { content: [{ type: "text" as const, text: "Error: failed to register" }] };
  }

  const action = buildAction(params);
  const result = await tool.handle({ agentId, harness: "codex", pid: process.pid }, action);

  return {
    content: [{ type: "text" as const, text: result.content }],
    isError: result.isError,
  };
});

await mcp.connect(new StdioServerTransport());

const reg = await ensureRegistered({ store, harness: "codex", defaultName: `codex-${nanoid(4)}` });
agentId = reg.agentId;
