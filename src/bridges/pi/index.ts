/**
 * Agent Bus — pi bridge extension.
 *
 * Provides the `agent_bus` tool and watches the delivery queue for
 * incoming messages, pushing them into the session via sendUserMessage().
 *
 * Install: symlink or copy to ~/.pi/agent/extensions/agent-bus/index.ts
 *          (with package.json for agent-bus dependency)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// We inline the core logic rather than importing from agent-bus (which would
// need a build step). The core protocol is small enough that this is cleaner
// for a pi extension. If the bus is installed as a package, import from it instead.

import { BusStore, BusTool } from "../../core/index.js";
import type { AgentId, BusAction, DeliveryEvent, Visibility } from "../../core/index.js";
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
    // Initialise bus directory structure
    await store.init();

    // Recover identity if we had one
    const identity = await store.readIdentity();
    if (identity) {
      agentId = identity.id;
      const agent = await store.getAgent(agentId);
      if (agent) {
        ctx.ui.notify(`Agent Bus: resumed as ${agent.name} (${agent.id})`, "info");
        // Drain queued messages
        await drainDelivery(ctx);
      }
    }

    // Start watching delivery queue
    startWatching(ctx);
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

  function startWatching(ctx: any) {
    if (!agentId) return;
    const deliveryDir = store.deliveryDir(agentId);
    fs.mkdirSync(deliveryDir, { recursive: true });

    watcher = fs.watch(deliveryDir, async (event, filename) => {
      if (event !== "rename" || !filename?.endsWith(".json")) return;
      await drainDelivery(ctx);
    });
  }

  async function drainDelivery(ctx: any) {
    if (!agentId) return;
    const events = await store.drainDelivery(agentId);
    for (const event of events) {
      const text = formatDeliveryEvent(event);
      pi.sendUserMessage(`📬 ${text}`, { deliverAs: "followUp" });
    }
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
      // Registration
      name: Type.Optional(Type.String({ description: "Agent display name (for register/update)" })),
      visibility: Type.Optional(StringEnum(["visible", "hidden", "ghost"] as const, {
        description: "Visibility to other agents",
      })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Agent capability tags" })),
      status: Type.Optional(StringEnum(["active", "idle", "busy"] as const, {
        description: "Agent status (for update)",
      })),
      // Rooms
      room: Type.Optional(Type.String({ description: "Room name/ID" })),
      type: Type.Optional(StringEnum(["public", "private", "secret"] as const, {
        description: "Room type (for create_room)",
      })),
      description: Type.Optional(Type.String({ description: "Room description (for create_room)" })),
      // Messaging
      target: Type.Optional(Type.String({ description: "Target room name or agent ID" })),
      content: Type.Optional(Type.String({ description: "Message content" })),
      replyTo: Type.Optional(Type.String({ description: "Message ID to reply to" })),
      // Admin
      agent: Type.Optional(Type.String({ description: "Target agent ID (for invite/kick)" })),
      since: Type.Optional(Type.String({ description: "ISO timestamp to read messages since" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Ensure we have an identity
      if (!agentId && params.action !== "register") {
        // Auto-register with defaults
        const result = await tool.handle(
          { agentId: "pending" as AgentId, harness: "pi", pid: process.pid },
          { action: "register", name: `pi-${nanoid(4)}`, visibility: "visible", tags: [] },
        );
        if (result.isError) return { content: [{ type: "text", text: result.content }], details: {}, isError: true };
        // Re-read identity
        const identity = await store.readIdentity();
        if (identity) {
          agentId = identity.id;
          startWatching(ctx);
        }
      }

      if (!agentId) {
        return {
          content: [{ type: "text", text: "Error: failed to register identity" }],
          details: {},
          isError: true,
        };
      }

      // Build the typed action from flat params
      const action = buildAction(params);

      const result = await tool.handle(
        { agentId, harness: "pi", pid: process.pid },
        action,
      );

      // After registration, start the watcher
      if (params.action === "register" && !result.isError) {
        const identity = await store.readIdentity();
        if (identity) {
          agentId = identity.id;
          startWatching(ctx);
        }
      }

      return {
        content: [{ type: "text", text: result.content }],
        details: { action: params.action },
        isError: result.isError,
      };
    },
  });
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
      return {
        action: "read_room",
        room: params.room ?? "",
        since: params.since,
      };
    case "invite":
      return {
        action: "invite",
        room: params.room ?? "",
        agent: params.agent ?? "",
      };
    case "kick":
      return {
        action: "kick",
        room: params.room ?? "",
        agent: params.agent ?? "",
      };
    case "destroy_room":
      return { action: "destroy_room", room: params.room ?? "" };
    default:
      return { action: params.action };
  }
}
