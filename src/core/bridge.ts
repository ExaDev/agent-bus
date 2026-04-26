/**
 * Agent Bus — shared bridge helpers.
 *
 * Every bridge needs the same three things:
 *   1. Build a BusAction from flat tool parameters
 *   2. Format a DeliveryEvent as human-readable text
 *   3. Register (or recover) an agent identity
 *
 * Extracted here so each bridge only wires up its harness-specific
 * push mechanism and tool registration.
 */

import * as fs from "node:fs/promises";
import type { AgentId, BusAction, DeliveryEvent, Visibility } from "./types.js";
import { BusStore } from "./store.js";
import { nanoid } from "./nanoid.js";

// ---------------------------------------------------------------------------
// buildAction — flat params → typed BusAction
// ---------------------------------------------------------------------------

/**
 * Convert flat key-value params (as received from an MCP tool call or
 * pi registerTool) into a discriminated BusAction.
 *
 * Uses explicit presence checks to satisfy exactOptionalPropertyTypes.
 */
export function buildAction(params: Record<string, unknown>): BusAction {
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
      if ("visibility" in params && params.visibility !== undefined)
        update.visibility = params.visibility as Visibility;
      if ("status" in params && params.status !== undefined)
        update.status = params.status as "active" | "idle" | "busy";
      if ("name" in params && params.name !== undefined)
        update.name = params.name as string;
      if ("tags" in params && params.tags !== undefined)
        update.tags = params.tags as string[];
      return update;
    }
    case "whoami":
      return { action: "whoami" };
    case "create_room":
      return {
        action: "create_room",
        name: (params.room as string) ?? "unnamed",
        type: (params.type as "public" | "private" | "secret") ?? "public",
        description: (params.description as string) ?? "",
      };
    case "list_rooms":
      return { action: "list_rooms" };
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
      if ("replyTo" in params && params.replyTo !== undefined)
        send.replyTo = params.replyTo as string;
      return send;
    }
    case "dm":
      return {
        action: "dm",
        target: (params.target as string) ?? (params.agent as string) ?? "",
        content: (params.content as string) ?? "",
      };
    case "list_agents":
      return { action: "list_agents" };
    case "read_room": {
      const read: BusAction & { action: "read_room" } = {
        action: "read_room",
        room: (params.room as string) ?? "",
      };
      if ("since" in params && params.since !== undefined)
        read.since = params.since as string;
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
// formatDeliveryEvent — DeliveryEvent → human-readable string
// ---------------------------------------------------------------------------

export function formatDeliveryEvent(event: DeliveryEvent): string {
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
// ensureRegistered — recover or create an agent identity
// ---------------------------------------------------------------------------

export interface RegistrationResult {
  agentId: AgentId;
  store: BusStore;
  isNew: boolean;
}

/**
 * Recover an existing identity (from `identity.json`) or register a new agent.
 * Returns the agent ID and whether this was a fresh registration.
 */
export async function ensureRegistered(opts: {
  store: BusStore;
  harness: string;
  defaultName: string;
  visibility?: Visibility;
  tags?: string[];
}): Promise<RegistrationResult> {
  await opts.store.init();

  const identity = await opts.store.readIdentity();
  if (identity) {
    await opts.store.updateAgent(identity.id, {
      status: "active",
      pid: process.pid,
    });
    return { agentId: identity.id, store: opts.store, isNew: false };
  }

  const agent = await opts.store.registerAgent({
    name: opts.defaultName,
    harness: opts.harness,
    pid: process.pid,
    visibility: opts.visibility ?? "visible",
    tags: opts.tags ?? [],
  });
  return { agentId: agent.id, store: opts.store, isNew: true };
}

// ---------------------------------------------------------------------------
// drainAndFormat — drain delivery queue, return formatted lines
// ---------------------------------------------------------------------------

export async function drainAndFormat(
  store: BusStore,
  agentId: AgentId,
): Promise<string[]> {
  const events = await store.drainDelivery(agentId);
  return events.map(formatDeliveryEvent);
}

// ---------------------------------------------------------------------------
// MCP tool schema — shared across MCP-based bridges (Claude Code, Codex)
// ---------------------------------------------------------------------------

export const MCP_TOOL_SCHEMA = {
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
    tags: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Agent tags",
    },
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
} as const;
