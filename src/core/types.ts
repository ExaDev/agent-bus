/**
 * Agent Bus — core types defining the shared protocol.
 *
 * All types are harness-agnostic. Bridges translate between this protocol
 * and their harness's native push mechanism (pi extensions, CC channels, etc.).
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type AgentId = string & { readonly __brand: unique symbol };
export type RoomId = string & { readonly __brand: unique symbol };

export type Visibility = "visible" | "hidden" | "ghost";
export type AgentStatus = "active" | "idle" | "busy" | "offline";
export type RoomType = "public" | "private" | "secret";

export interface AgentIdentity {
  /** Unique agent identifier (nanoid, 8 chars). */
  id: AgentId;
  /** Human-readable name, set by the agent or user. */
  name: string;
  /** Which harness is running this agent. */
  harness: "pi" | "claude-code" | "codex" | "opencode" | "unknown";
  /** OS process ID for liveness checks. */
  pid: number;
  startedAt: string;
  visibility: Visibility;
  status: AgentStatus;
  /** Tags describing the agent's purpose or expertise. */
  tags: string[];
  /** Rooms this agent is subscribed to. */
  subscribedRooms: RoomId[];
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export interface Room {
  id: RoomId;
  name: string;
  type: RoomType;
  owner: AgentId;
  createdAt: string;
  description: string;
  /** Members list — only present for private and secret rooms. */
  members: AgentId[];
  /** Agents invited but not yet joined. */
  invited: AgentId[];
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface RoomMessage {
  id: string;
  from: AgentId;
  room: RoomId;
  content: string;
  timestamp: string;
  /** If this is a reply to another message. */
  replyTo: string | undefined;
}

export interface DmMessage {
  id: string;
  from: AgentId;
  to: AgentId;
  content: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Delivery (pushed to individual agent queues)
// ---------------------------------------------------------------------------

export type DeliveryEvent =
  | { type: "room_message"; message: RoomMessage }
  | { type: "dm"; message: DmMessage }
  | { type: "room_invite"; room: RoomId; from: AgentId }
  | { type: "member_joined"; room: RoomId; agent: AgentId }
  | { type: "member_left"; room: RoomId; agent: AgentId };

// ---------------------------------------------------------------------------
// Tool interface (harness-agnostic actions the LLM calls)
// ---------------------------------------------------------------------------

export type BusAction =
  | { action: "register"; name: string; visibility: Visibility; tags: string[] }
  | { action: "update"; visibility?: Visibility; status?: AgentStatus; name?: string; tags?: string[] }
  | { action: "create_room"; name: string; type: RoomType; description: string }
  | { action: "list_rooms" }
  | { action: "join_room"; room: string }
  | { action: "leave_room"; room: string }
  | { action: "send"; target: string; content: string; replyTo?: string }
  | { action: "dm"; target: string; content: string }
  | { action: "list_agents" }
  | { action: "read_room"; room: string; since?: string }
  | { action: "invite"; room: string; agent: string }
  | { action: "kick"; room: string; agent: string }
  | { action: "destroy_room"; room: string }
  | { action: "whoami" };
