/**
 * Agent Comms — shared protocol types and Zod schemas.
 *
 * Every type is derived from its Zod schema (single source of truth).
 * Use `Schema.parse(raw)` at JSON boundaries instead of `JSON.parse(raw) as T`.
 * Use `Schema.is(value)` for type narrowing.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema-attached type guard helper
// ---------------------------------------------------------------------------

function defineSchema<T extends z.ZodType>(schema: T) {
  return Object.assign(schema, {
    is(value: unknown): value is z.infer<T> {
      return schema.safeParse(value).success;
    },
  });
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

// Agent and Room IDs are plain strings internally.
// Branded types removed — they caused unused-var warnings since
// Zod brand schemas are never referenced as values.
export type AgentId = string;
export type RoomId = string;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const Visibility = defineSchema(
  z.union([z.literal("visible"), z.literal("hidden"), z.literal("ghost")]),
);
export type Visibility = z.infer<typeof Visibility>;

export const AgentStatus = defineSchema(
  z.union([
    z.literal("active"),
    z.literal("idle"),
    z.literal("busy"),
    z.literal("offline"),
  ]),
);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const RoomType = defineSchema(
  z.union([z.literal("public"), z.literal("private"), z.literal("secret")]),
);
export type RoomType = z.infer<typeof RoomType>;

// ---------------------------------------------------------------------------
// AgentIdentity
// ---------------------------------------------------------------------------

export const AgentIdentitySchema = defineSchema(
  z.object({
    id: z.string(),
    name: z.string(),
    harness: z.string(),
    pid: z.number(),
    startedAt: z.string(),
    visibility: Visibility,
    status: AgentStatus,
    tags: z.array(z.string()),
    subscribedRooms: z.array(z.string()),
  }),
);
export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------

export const RoomSchema = defineSchema(
  z.object({
    id: z.string(),
    name: z.string(),
    type: RoomType,
    owner: z.string(),
    createdAt: z.string(),
    description: z.string(),
    members: z.array(z.string()),
    invited: z.array(z.string()),
  }),
);
export type Room = z.infer<typeof RoomSchema>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const RoomMessageSchema = defineSchema(
  z.object({
    id: z.string(),
    from: z.string(),
    room: z.string(),
    content: z.string(),
    timestamp: z.string(),
    replyTo: z.string().optional(),
  }),
);
export type RoomMessage = z.infer<typeof RoomMessageSchema>;

export const DmMessageSchema = defineSchema(
  z.object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    content: z.string(),
    timestamp: z.string(),
  }),
);
export type DmMessage = z.infer<typeof DmMessageSchema>;

// ---------------------------------------------------------------------------
// Delivery events
// ---------------------------------------------------------------------------

export const DeliveryEventSchema = defineSchema(
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("room_message"),
      message: RoomMessageSchema,
    }),
    z.object({
      type: z.literal("dm"),
      message: DmMessageSchema,
    }),
    z.object({
      type: z.literal("room_invite"),
      room: z.string(),
      from: z.string(),
    }),
    z.object({
      type: z.literal("member_joined"),
      room: z.string(),
      agent: z.string(),
    }),
    z.object({
      type: z.literal("member_left"),
      room: z.string(),
      agent: z.string(),
    }),
  ]),
);
export type DeliveryEvent = z.infer<typeof DeliveryEventSchema>;

// ---------------------------------------------------------------------------
// BusAction
// ---------------------------------------------------------------------------

export const BusActionSchema = defineSchema(
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("register"),
      name: z.string(),
      visibility: Visibility,
      tags: z.array(z.string()),
    }),
    z.object({
      action: z.literal("update"),
      visibility: Visibility.optional(),
      status: AgentStatus.optional(),
      name: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
    z.object({ action: z.literal("whoami") }),
    z.object({
      action: z.literal("create_room"),
      name: z.string(),
      type: RoomType,
      description: z.string(),
    }),
    z.object({ action: z.literal("list_rooms") }),
    z.object({
      action: z.literal("join_room"),
      room: z.string(),
    }),
    z.object({
      action: z.literal("leave_room"),
      room: z.string(),
    }),
    z.object({
      action: z.literal("send"),
      target: z.string(),
      content: z.string(),
      replyTo: z.string().optional(),
    }),
    z.object({
      action: z.literal("dm"),
      target: z.string(),
      content: z.string(),
    }),
    z.object({ action: z.literal("list_agents") }),
    z.object({
      action: z.literal("read_room"),
      room: z.string(),
      since: z.string().optional(),
    }),
    z.object({
      action: z.literal("invite"),
      room: z.string(),
      agent: z.string(),
    }),
    z.object({
      action: z.literal("kick"),
      room: z.string(),
      agent: z.string(),
    }),
    z.object({
      action: z.literal("destroy_room"),
      room: z.string(),
    }),
  ]),
);
export type BusAction = z.infer<typeof BusActionSchema>;
