#!/usr/bin/env bun
/**
 * Agent Bus — Claude Code channel bridge.
 *
 * This is a Claude Code MCP channel server that bridges the agent bus
 * filesystem protocol into Claude Code's <channel> event system.
 *
 * It provides:
 *   1. The "agent_bus" tool for Claude to call (send, dm, create_room, etc.)
 *   2. A notification listener that watches the delivery queue and pushes
 *      incoming messages into Claude's context via <channel> events.
 *   3. A local HTTP endpoint for testing/debugging.
 *
 * Install in .mcp.json:
 *   {
 *     "mcpServers": {
 *       "agent-bus": { "command": "bun", "args": ["~/Developer/agent-bus/src/bridges/claude-code/channel.ts"] }
 *     }
 *   }
 *
 * Run:
 *   claude --dangerously-load-development-channels server:agent-bus
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

// Inline imports — if agent-bus is built, change to package imports
import { BusStore, BusTool, BusError } from "../../core/index.js";
import type { AgentId, BusAction, DeliveryEvent, Visibility } from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const BUS_ROOT = path.join(os.homedir(), ".agents", "bus");

const store = new BusStore(BUS_ROOT);
const tool = new BusTool(store);
let agentId: AgentId | undefined;
let watchTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// Outbound SSE (for debugging)
// ---------------------------------------------------------------------------

const listeners = new Set<(chunk: string) => void>();

function broadcast(text: string) {
  const chunk = text
    .split("\n")
    .map((l) => `data: ${l}`)
    .join("\n") + "\n";
  for (const emit of listeners) emit(chunk);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "agent-bus", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
    instructions: [
      "You are connected to the Agent Bus — a cross-harness communication system for LLM agents.",
      "Use the agent_bus tool to register, create/join rooms, send messages, and DM other agents.",
      "Incoming messages from other agents appear as <channel source=\"agent-bus\"> events.",
      "Register yourself first with action=register, then join or create rooms.",
    ].join(" "),
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

  const params = req.params.arguments as Record<string, any>;
  if (!params) throw new Error("No arguments provided");

  // Auto-register if needed
  if (!agentId && params.action !== "register") {
    await ensureRegistered();
  }

  if (!agentId) {
    return { content: [{ type: "text" as const, text: "Error: failed to register" }] };
  }

  const action = buildAction(params);
  const result = await tool.handle(
    { agentId, harness: "claude-code", pid: process.pid },
    action,
  );

  return {
    content: [{ type: "text" as const, text: result.content }],
    isError: result.isError,
  };
});

// ---------------------------------------------------------------------------
// Delivery watching (poll-based — channels don't support fs.watch easily)
// ---------------------------------------------------------------------------

function startDeliveryPoll() {
  if (watchTimer) return;
  // Poll every 2 seconds
  watchTimer = setInterval(async () => {
    if (!agentId) return;
    const events = await store.drainDelivery(agentId);
    for (const event of events) {
      const text = formatDeliveryEvent(event);
      // Push into Claude's context as a channel event
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: text,
          meta: { event_type: event.type },
        },
      });
      broadcast(text);
    }
  }, 2000);
}

function formatDeliveryEvent(event: DeliveryEvent): string {
  switch (event.type) {
    case "room_message":
      return `[${event.message.room}] ${event.message.from}: ${event.message.content}`;
    case "dm":
      return `DM from ${event.message.from}: ${event.message.content}`;
    case "room_invite":
      return `Invited to room ${event.room} by ${event.from}`;
    case "member_joined":
      return `${event.agent} joined ${event.room}`;
    case "member_left":
      return `${event.agent} left ${event.room}`;
  }
}

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
      name: `claude-code-${nanoid(4)}`,
      harness: "claude-code",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    agentId = agent.id;
  }
  startDeliveryPoll();
}

function buildAction(params: Record<string, any>): BusAction {
  switch (params.action) {
    case "register":
      return {
        action: "register",
        name: params.name ?? "unnamed",
        visibility: (params.visibility as Visibility) ?? "visible",
        tags: params.tags ?? [],
      };
    case "update":
      return {
        action: "update",
        visibility: params.visibility,
        status: params.status,
        name: params.name,
        tags: params.tags,
      };
    case "create_room":
      return {
        action: "create_room",
        name: params.room ?? "unnamed",
        type: params.type ?? "public",
        description: params.description ?? "",
      };
    case "join_room":
      return { action: "join_room", room: params.room ?? "" };
    case "leave_room":
      return { action: "leave_room", room: params.room ?? "" };
    case "send":
      return {
        action: "send",
        target: params.target ?? params.room ?? "",
        content: params.content ?? "",
        replyTo: params.replyTo,
      };
    case "dm":
      return {
        action: "dm",
        target: params.target ?? params.agent ?? "",
        content: params.content ?? "",
      };
    case "read_room":
      return { action: "read_room", room: params.room ?? "", since: params.since };
    case "invite":
      return { action: "invite", room: params.room ?? "", agent: params.agent ?? "" };
    case "kick":
      return { action: "kick", room: params.room ?? "", agent: params.agent ?? "" };
    case "destroy_room":
      return { action: "destroy_room", room: params.room ?? "" };
    default:
      return { action: params.action };
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
await ensureRegistered();

// Optional: HTTP debug endpoint
const PORT = 8799;
Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    // SSE debug stream
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

    // Manual push (for testing)
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

broadcast(`Agent Bus channel server started on :${PORT}`);
