#!/usr/bin/env bun
/**
 * Agent Comms — Claude Code channel bridge.
 *
 * MCP channel server that provides the "agent_comms" tool and pushes
 * incoming messages into Claude's context via <channel> events.
 *
 * Install in .mcp.json:
 *   { "mcpServers": { "agent-comms": {
 *     "command": "bun",
 *     "args": ["~/Developer/agent-comms/src/bridges/claude-code/channel.ts"]
 *   }}}
 *
 * Run: claude --dangerously-load-development-channels
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
  drainAndFormat,
  MCP_TOOL_SCHEMA,
} from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const store = new BusStore(path.join(os.homedir(), ".agents", "bus"));
const tool = new BusTool(store);
let agentId: string | undefined;
let watchTimer: ReturnType<typeof setInterval> | undefined;

// Outbound SSE listeners (for debug HTTP endpoint)
const listeners = new Set<(chunk: string) => void>();

const mcp = new McpServer(
  { name: "agent-comms", version: "0.2.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
  },
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
      'Incoming messages appear as <channel source="agent-comms"> events.',
    ].join(" "),
    inputSchema: MCP_TOOL_SCHEMA,
  },
  async (rawParams: unknown) => {
    const params = isRecord(rawParams) ? rawParams : {};
    const actionParam = params.action;
    if (!agentId && actionParam !== "register") {
      const reg = await ensureRegistered({
        store,
        harness: "claude-code",
        defaultName: `claude-code-${nanoid(4)}`,
      });
      agentId = reg.agentId;
      startDeliveryPoll();
    }

    if (!agentId) {
      return {
        content: [{ type: "text", text: "Error: failed to register" }],
        isError: true,
      };
    }

    const action = buildAction(params);
    const result = await tool.handle(
      { agentId, harness: "claude-code", pid: process.pid },
      action,
    );

    return {
      content: [{ type: "text", text: result.content }],
      isError: result.isError,
    };
  },
);

// ---------------------------------------------------------------------------
// Delivery polling (channels can't use fs.watch easily)
// ---------------------------------------------------------------------------

function startDeliveryPoll() {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    void pollDelivery();
  }, 2000);
}

async function pollDelivery() {
  if (!agentId) return;
  const lines = await drainAndFormat(store, agentId);
  for (const line of lines) {
    await mcp.server.notification({
      method: "notifications/claude/channel",
      params: { content: line, meta: {} },
    });
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());

const reg = await ensureRegistered({
  store,
  harness: "claude-code",
  defaultName: `claude-code-${nanoid(4)}`,
});
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
          ctrl.enqueue(": agent-comms connected\n\n");
          const emit = (chunk: string) => {
            ctrl.enqueue(chunk);
          };
          listeners.add(emit);
          req.signal.addEventListener("abort", () => listeners.delete(emit));
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    }

    if (req.method === "POST") {
      const body = await req.text();
      if (!agentId) return new Response("not registered", { status: 500 });
      await mcp.server.notification({
        method: "notifications/claude/channel",
        params: { content: body, meta: { source: "http" } },
      });
      return new Response("ok");
    }

    return new Response("agent-comms channel server", { status: 200 });
  },
});
