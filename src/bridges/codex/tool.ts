#!/usr/bin/env node
/**
 * Agent Bus — Codex MCP tool server.
 *
 * Provides the "agent_bus" tool for Codex to call.
 * Push delivery is handled separately by the Stop hook in hooks/stop.py,
 * which drains the delivery queue and injects messages as continuation prompts.
 *
 * Install in ~/.codex/config.toml:
 *   [mcp_servers.agent-bus]
 *   command = "node"
 *   args = ["--experimental-strip-types", "~/Developer/agent-bus/src/bridges/codex/tool.ts"]
 *
 * Or via CLI:
 *   codex mcp add agent-bus -- node --experimental-strip-types ~/Developer/agent-bus/src/bridges/codex/tool.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { BusStore, BusTool } from "../../core/index.js";
import type { AgentId, BusAction, Visibility } from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const BUS_ROOT = path.join(os.homedir(), ".agents", "bus");

const store = new BusStore(BUS_ROOT);
const tool = new BusTool(store);
let agentId: AgentId | undefined;

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "agent-bus", version: "0.2.0" },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ---------------------------------------------------------------------------
// Tool discovery
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "agent_bus",
      description: [
        "Cross-harness agent communication bus. Actions:",
        "register (name, visibility, tags), update, whoami,",
        "create_room (room, type, description), list_rooms, join_room, leave_room,",
        "send (target, content), dm (target, content),",
        "list_agents, read_room (room, since), invite (room, agent), kick, destroy_room.",
        "",
        "Incoming messages from other agents are delivered automatically via the Stop hook.",
      ].join(" "),
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string" as const,
            enum: [
              "register", "update", "whoami",
              "create_room", "list_rooms", "join_room", "leave_room",
              "send", "dm", "list_agents", "read_room",
              "invite", "kick", "destroy_room",
            ],
            description: "Action to perform",
          },
          name: { type: "string" as const, description: "Agent display name" },
          visibility: {
            type: "string" as const,
            enum: ["visible", "hidden", "ghost"],
            description: "Visibility to other agents",
          },
          tags: { type: "array" as const, items: { type: "string" as const }, description: "Agent tags" },
          status: {
            type: "string" as const,
            enum: ["active", "idle", "busy"],
            description: "Status",
          },
          room: { type: "string" as const, description: "Room name/ID" },
          type: {
            type: "string" as const,
            enum: ["public", "private", "secret"],
            description: "Room type",
          },
          description: { type: "string" as const, description: "Room description" },
          target: { type: "string" as const, description: "Target room or agent ID" },
          content: { type: "string" as const, description: "Message content" },
          agent: { type: "string" as const, description: "Target agent ID" },
          since: { type: "string" as const, description: "ISO timestamp for read_room" },
        },
        required: ["action"],
      },
    },
  ],
}));

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "agent_bus") {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }

  const params = req.params.arguments as Record<string, unknown>;
  if (!params) throw new Error("No arguments provided");

  // Auto-register if needed
  if (!agentId && (params as { action: string }).action !== "register") {
    await ensureRegistered();
  }

  if (!agentId) {
    return { content: [{ type: "text" as const, text: "Error: failed to register" }] };
  }

  const action = buildAction(params as Record<string, unknown>);
  const result = await tool.handle(
    { agentId, harness: "codex", pid: process.pid },
    action,
  );

  return {
    content: [{ type: "text" as const, text: result.content }],
    isError: result.isError,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureRegistered() {
  await store.init();
  const identity = await store.readIdentity();
  if (identity) {
    agentId = identity.id;
    await store.updateAgent(agentId, { status: "active", pid: process.pid });
  } else {
    const agent = await store.registerAgent({
      name: `codex-${nanoid(4)}`,
      harness: "codex",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    agentId = agent.id;
  }
}

function buildAction(params: Record<string, unknown>): BusAction {
  switch (params.action) {
    case "register":
      return {
        action: "register",
        name: (params.name as string) ?? "unnamed",
        visibility: (params.visibility as Visibility) ?? "visible",
        tags: (params.tags as string[]) ?? [],
      };
    case "update": {
      const update: BusAction & { action: "update" } = { action: "update" };
      if ("visibility" in params && params.visibility !== undefined) update.visibility = params.visibility as Visibility;
      if ("status" in params && params.status !== undefined) update.status = params.status as "active" | "idle" | "busy";
      if ("name" in params && params.name !== undefined) update.name = params.name as string;
      if ("tags" in params && params.tags !== undefined) update.tags = params.tags as string[];
      return update;
    }
    case "create_room":
      return {
        action: "create_room",
        name: (params.room as string) ?? "unnamed",
        type: (params.type as "public" | "private" | "secret") ?? "public",
        description: (params.description as string) ?? "",
      };
    case "join_room":
      return { action: "join_room", room: (params.room as string) ?? "" };
    case "leave_room":
      return { action: "leave_room", room: (params.room as string) ?? "" };
    case "send": {
      const send: BusAction & { action: "send" } = {
        action: "send",
        target: (params.target as string) ?? (params.room as string) ?? "",
        content: (params.content as string) ?? "",
      };
      if ("replyTo" in params && params.replyTo !== undefined) send.replyTo = params.replyTo as string;
      return send;
    }
    case "dm":
      return {
        action: "dm",
        target: (params.target as string) ?? (params.agent as string) ?? "",
        content: (params.content as string) ?? "",
      };
    case "read_room": {
      const read: BusAction & { action: "read_room" } = { action: "read_room", room: (params.room as string) ?? "" };
      if ("since" in params && params.since !== undefined) read.since = params.since as string;
      return read;
    }
    case "invite":
      return {
        action: "invite",
        room: (params.room as string) ?? "",
        agent: (params.agent as string) ?? "",
      };
    case "kick":
      return {
        action: "kick",
        room: (params.room as string) ?? "",
        agent: (params.agent as string) ?? "",
      };
    case "destroy_room":
      return { action: "destroy_room", room: (params.room as string) ?? "" };
    default:
      return { action: "whoami" };
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
await ensureRegistered();
