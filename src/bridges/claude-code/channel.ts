/**
 * Agent Comms — Claude Code channel bridge.
 *
 * MCP channel server that provides the "agent_comms" tool and pushes
 * incoming messages into Claude's context via <channel> events.
 *
 * Run via: npx agent-comms bridge claude-code
 * Requires: claude --dangerously-load-development-channels
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "node:path";
import * as os from "node:os";

import {
  BusStore,
  BusTool,
  buildAction,
  ensureRegistered,
  drainAndFormat,
  MCP_TOOL_PARAMS,
} from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function run(): Promise<void> {
  const store = new BusStore(path.join(os.homedir(), ".agents", "bus"));
  const tool = new BusTool(store);
  let agentId: string | undefined;
  let watchTimer: ReturnType<typeof setInterval> | undefined;

  const mcp = new McpServer(
    { name: "agent-comms", version: "0.2.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
    },
  );

  // -----------------------------------------------------------------------
  // Delivery polling (channels can't use fs.watch easily)
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Tool registration
  // -----------------------------------------------------------------------

  mcp.registerTool(
    "agent_comms",
    {
      description: [
        "Cross-harness agent communication bus. Actions:",
        "register, update, whoami, create_room, list_rooms, join_room, leave_room,",
        "send, dm, list_agents, read_room, invite, kick, destroy_room.",
        'Incoming messages appear as <channel source="agent-comms"> events.',
      ].join(" "),
      inputSchema: MCP_TOOL_PARAMS,
    },
    async (rawParams: unknown) => {
      const params = isRecord(rawParams) ? rawParams : {};
      const actionParam = params.action;
      if (!agentId && actionParam !== "register") {
        const reg = await ensureRegistered({
          cwd: process.cwd(),
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
        {
          agentId,
          harness: "claude-code",
          cwd: process.cwd(),
          pid: process.pid,
        },
        action,
      );

      return {
        content: [{ type: "text", text: result.content }],
        isError: result.isError,
      };
    },
  );

  // -----------------------------------------------------------------------
  // Startup
  // -----------------------------------------------------------------------

  await mcp.connect(new StdioServerTransport());

  const reg = await ensureRegistered({
    cwd: process.cwd(),
    store,
    harness: "claude-code",
    defaultName: `claude-code-${nanoid(4)}`,
  });
  agentId = reg.agentId;
  startDeliveryPoll();
}
