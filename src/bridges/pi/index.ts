/**
 * Agent Bus — pi bridge extension.
 *
 * Provides the `agent_bus` tool and watches the delivery queue,
 * pushing incoming messages via sendUserMessage().
 *
 * Install: symlink to ~/.pi/agent/extensions/agent-bus/index.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import {
  BusStore,
  BusTool,
  buildAction,
  ensureRegistered,
  formatDeliveryEvent,
  drainAndFormat,
} from "../../core/index.js";
import type { AgentId } from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const BUS_ROOT = path.join(os.homedir(), ".agents", "bus");

export default function (pi: ExtensionAPI) {
  const store = new BusStore(BUS_ROOT);
  const tool = new BusTool(store);

  let agentId: AgentId | undefined;
  let watcher: fs.FSWatcher | undefined;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    const reg = await ensureRegistered({ store, harness: "pi", defaultName: `pi-${nanoid(4)}` });
    agentId = reg.agentId;

    if (!reg.isNew) {
      ctx.ui.notify(`Agent Bus: resumed as ${reg.agentId}`, "info");
      await drainAndPush();
    }

    startWatching();
  });

  pi.on("session_shutdown", async () => {
    watcher?.close();
    if (agentId) {
      await store.setAgentOffline(agentId);
    }
  });

  // -----------------------------------------------------------------------
  // Delivery watcher
  // -----------------------------------------------------------------------

  function startWatching() {
    if (!agentId) return;
    const deliveryDir = store.deliveryDir(agentId);
    fs.mkdirSync(deliveryDir, { recursive: true });

    watcher = fs.watch(deliveryDir, async (event, filename) => {
      if (event !== "rename" || !filename?.endsWith(".json")) return;
      await drainAndPush();
    });
  }

  async function drainAndPush() {
    if (!agentId) return;
    const lines = await drainAndFormat(store, agentId);
    for (const line of lines) {
      pi.sendUserMessage(`📬 ${line}`, { deliverAs: "followUp" });
    }
  }

  // -----------------------------------------------------------------------
  // Tool registration
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: "agent_bus",
    label: "Agent Bus",
    description: [
      "Cross-harness agent communication bus. Send messages to rooms and DM other agents.",
      "Actions: register, update, whoami, create_room, list_rooms, join_room, leave_room,",
      "send, dm, list_agents, read_room, invite, kick, destroy_room.",
      "Register first, then join or create rooms to communicate.",
    ].join(" "),
    promptSnippet: "Communicate with other LLM agents via rooms and DMs",
    promptGuidelines: [
      "Use agent_bus to coordinate with other running agents. Register on session start, join rooms for collaboration.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "register", "update", "whoami",
        "create_room", "list_rooms", "join_room", "leave_room",
        "send", "dm", "list_agents", "read_room",
        "invite", "kick", "destroy_room",
      ] as const, { description: "Action to perform" }),
      name: Type.Optional(Type.String({ description: "Agent display name (for register/update)" })),
      visibility: Type.Optional(StringEnum(["visible", "hidden", "ghost"] as const, {
        description: "Visibility to other agents",
      })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Agent capability tags" })),
      status: Type.Optional(StringEnum(["active", "idle", "busy"] as const, {
        description: "Agent status (for update)",
      })),
      room: Type.Optional(Type.String({ description: "Room name/ID" })),
      type: Type.Optional(StringEnum(["public", "private", "secret"] as const, {
        description: "Room type (for create_room)",
      })),
      description: Type.Optional(Type.String({ description: "Room description (for create_room)" })),
      target: Type.Optional(Type.String({ description: "Target room name or agent ID" })),
      content: Type.Optional(Type.String({ description: "Message content" })),
      replyTo: Type.Optional(Type.String({ description: "Message ID to reply to" })),
      agent: Type.Optional(Type.String({ description: "Target agent ID (for invite/kick)" })),
      since: Type.Optional(Type.String({ description: "ISO timestamp to read messages since" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!agentId) {
        return {
          content: [{ type: "text", text: "Error: not registered" }],
          details: {},
          isError: true,
        };
      }

      const action = buildAction(params as Record<string, unknown>);
      const result = await tool.handle({ agentId, harness: "pi", pid: process.pid }, action);

      return {
        content: [{ type: "text", text: result.content }],
        details: { action: params.action },
        isError: result.isError,
      };
    },
  });
}
