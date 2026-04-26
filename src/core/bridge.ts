/**
 * Agent Comms — shared bridge helpers.
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
import type { BusAction, DeliveryEvent, Visibility } from "./types.js";
import { BusStore } from "./store.js";
import { nanoid } from "./nanoid.js";

// ---------------------------------------------------------------------------
// Narrowing helpers for params from MCP/pi tool calls
// ---------------------------------------------------------------------------

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function getString(
  params: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  const value = params[key];
  return isString(value) ? value : fallback;
}

function getOptionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  return isString(value) ? value : undefined;
}

function getOptionalStringArray(
  params: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = params[key];
  return isStringArray(value) ? value : undefined;
}

function getOptionalEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = params[key];
  if (isString(value) && (values as readonly string[]).includes(value)) {
    return value as T;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// buildAction — flat params → typed BusAction
// ---------------------------------------------------------------------------

const VISIBILITY_VALUES = ["visible", "hidden", "ghost"] as const;
const STATUS_VALUES = ["active", "idle", "busy"] as const;
const ROOM_TYPE_VALUES = ["public", "private", "secret"] as const;

export function buildAction(params: Record<string, unknown>): BusAction {
  const action = isString(params.action) ? params.action : "whoami";

  switch (action) {
    case "register":
      return {
        action: "register",
        name: getString(params, "name", "unnamed"),
        visibility:
          getOptionalEnum(params, "visibility", VISIBILITY_VALUES) ?? "visible",
        tags: getOptionalStringArray(params, "tags") ?? [],
      };
    case "update": {
      const update: BusAction & { action: "update" } = { action: "update" };
      const visibility = getOptionalEnum(
        params,
        "visibility",
        VISIBILITY_VALUES,
      );
      if (visibility !== undefined) update.visibility = visibility;
      const status = getOptionalEnum(params, "status", STATUS_VALUES);
      if (status !== undefined) update.status = status;
      const name = getOptionalString(params, "name");
      if (name !== undefined) update.name = name;
      const tags = getOptionalStringArray(params, "tags");
      if (tags !== undefined) update.tags = tags;
      return update;
    }
    case "whoami":
      return { action: "whoami" };
    case "create_room":
      return {
        action: "create_room",
        name: getString(params, "room", "unnamed"),
        type: getOptionalEnum(params, "type", ROOM_TYPE_VALUES) ?? "public",
        description: getString(params, "description", ""),
      };
    case "list_rooms":
      return { action: "list_rooms" };
    case "join_room":
      return { action: "join_room", room: getString(params, "room", "") };
    case "leave_room":
      return { action: "leave_room", room: getString(params, "room", "") };
    case "send": {
      const send: BusAction & { action: "send" } = {
        action: "send",
        target:
          getString(params, "target", "") || getString(params, "room", ""),
        content: getString(params, "content", ""),
      };
      const replyTo = getOptionalString(params, "replyTo");
      if (replyTo !== undefined) send.replyTo = replyTo;
      return send;
    }
    case "dm":
      return {
        action: "dm",
        target:
          getString(params, "target", "") || getString(params, "agent", ""),
        content: getString(params, "content", ""),
      };
    case "list_agents":
      return { action: "list_agents" };
    case "read_room": {
      const read: BusAction & { action: "read_room" } = {
        action: "read_room",
        room: getString(params, "room", ""),
      };
      const since = getOptionalString(params, "since");
      if (since !== undefined) read.since = since;
      return read;
    }
    case "invite":
      return {
        action: "invite",
        room: getString(params, "room", ""),
        agent: getString(params, "agent", ""),
      };
    case "kick":
      return {
        action: "kick",
        room: getString(params, "room", ""),
        agent: getString(params, "agent", ""),
      };
    case "destroy_room":
      return {
        action: "destroy_room",
        room: getString(params, "room", ""),
      };
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
  agentId: string;
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
  agentId: string,
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
        "register",
        "update",
        "whoami",
        "create_room",
        "list_rooms",
        "join_room",
        "leave_room",
        "send",
        "dm",
        "list_agents",
        "read_room",
        "invite",
        "kick",
        "destroy_room",
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
    since: {
      type: "string" as const,
      description: "ISO timestamp for read_room",
    },
  },
  required: ["action"],
} as const;
