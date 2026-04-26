#!/usr/bin/env bun
/**
 * Agent Bus — Claude Code channel bridge.
 *
 * MCP channel server that provides the "agent_bus" tool and pushes
 * incoming messages into Claude's context via <channel> events.
 *
 * Install in .mcp.json:
 *   { "mcpServers": { "agent-bus": {
 *     "command": "bun",
 *     "args": ["~/Developer/agent-bus/src/bridges/claude-code/channel.ts"]
 *   }}}
 *
 * Run: claude --dangerously-load-development-channels
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

import {
  BusStore,
  BusTool,
  buildAction,
  ensureRegistered,
  formatDeliveryEvent,
  drainAndFormat,
  MCP_TOOL_SCHEMA,
} from "../../core/index.js";
import type { AgentId } from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const store = new BusStore(path.join(os.homedir(), ".agents", "bus"));
const tool = new BusTool(store);
let agentId: AgentId | undefined;
let watchTimer: ReturnType<typeof setInterval> | undefined;

// Outbound SSE listeners (for debug HTTP endpoint)
const listeners = new Set<(chunk: string) => void>();

const mcp = new Server(
  { name: "agent-bus", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "You are connected to the Agent Bus — a cross-harness communication system for LLM agents.",
      "Use the agent_bus tool to register, create/join rooms, send messages, and DM other agents.",
      "Incoming messages appear as <channel source=\"agent-bus\"> events.",
    ].join(" "),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "agent_bus",
      description: [
        "Cross-harness agent communication bus. Actions:",
        "register, update, whoami, create_room, list_rooms, join_room, leave_room,",
        "send, dm, list_agents, read_room, invite, kick, destroy_room.",
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

  if (!agentId && (params as { action: string }).action !== "register") {
    const reg = await ensureRegistered({ store, harness: "claude-code", defaultName: `claude-code-${nanoid(4)}` });
    agentId = reg.agentId;
    startDeliveryPoll();
  }

  if (!agentId) {
    return { content: [{ type: "text" as const, text: "Error: failed to register" }] };
  }

  const action = buildAction(params);
  const result = await tool.handle({ agentId, harness: "claude-code", pid: process.pid }, action);

  return {
    content: [{ type: "text" as const, text: result.content }],
    isError: result.isError,
  };
});

// ---------------------------------------------------------------------------
// Delivery polling (channels can't use fs.watch easily)
// ---------------------------------------------------------------------------

function startDeliveryPoll() {
  if (watchTimer) return;
  watchTimer = setInterval(async () => {
    if (!agentId) return;
    const lines = await drainAndFormat(store, agentId);
    for (const line of lines) {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content: line, meta: {} },
      });
    }
  }, 2000);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());

const reg = await ensureRegistered({ store, harness: "claude-code", defaultName: `claude-code-${nanoid(4)}` });
agentId = reg.agentId;
startDeliveryPoll();

// Optional debug HTTP endpoint
const PORT = 8799;
Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/events") {
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(": agent-bus connected\n\n");
          const emit = (chunk: string) => ctrl.enqueue(chunk);
          listeners.add(emit);
          req.signal.addEventListener("abort", () => listeners.delete(emit));
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    if (req.method === "POST") {
      const body = await req.text();
      if (!agentId) return new Response("not registered", { status: 500 });
      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content: body, meta: { source: "http" } },
      });
      return new Response("ok");
    }

    return new Response("agent-bus channel server", { status: 200 });
  },
});
