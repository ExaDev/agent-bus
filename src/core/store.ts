/**
 * Filesystem layout for the agent bus.
 *
 * All paths are relative to a configurable bus root (default: ~/.agents/bus/).
 * Every operation is a file read/write — no server process needed.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nanoid } from "./nanoid.js";
import type {
  AgentId,
  AgentIdentity,
  AgentStatus,
  DeliveryEvent,
  DmMessage,
  Room,
  RoomId,
  RoomMessage,
  RoomType,
  Visibility,
} from "./types.js";

export class BusError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "BusError";
  }
}

export class BusStore {
  constructor(public readonly root: string = path.join(os.homedir(), ".agents", "bus")) {}

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------

  agentPath(id: AgentId): string {
    return path.join(this.root, "registry", "agents", `${id}.json`);
  }

  roomPath(id: RoomId): string {
    return path.join(this.root, "registry", "rooms", `${id}.json`);
  }

  roomMessagesDir(id: RoomId): string {
    return path.join(this.root, "rooms", id);
  }

  dmDir(a: AgentId, b: AgentId): string {
    const sorted = [a, b].sort();
    return path.join(this.root, "dms", `${sorted[0]}--${sorted[1]}`);
  }

  deliveryDir(id: AgentId): string {
    return path.join(this.root, "delivery", id);
  }

  identityPath(): string {
    return path.join(this.root, "identity.json");
  }

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  async readIdentity(): Promise<{ id: AgentId } | undefined> {
    try {
      const raw = await fs.readFile(this.identityPath(), "utf-8");
      return JSON.parse(raw) as { id: AgentId };
    } catch {
      return undefined;
    }
  }

  async writeIdentity(id: AgentId): Promise<void> {
    await fs.mkdir(path.dirname(this.identityPath()), { recursive: true });
    await fs.writeFile(this.identityPath(), JSON.stringify({ id }), { encoding: "utf-8", mode: 0o644 });
  }

  // -------------------------------------------------------------------------
  // Agent registry
  // -------------------------------------------------------------------------

  async registerAgent(opts: {
    name: string;
    harness: AgentIdentity["harness"];
    pid: number;
    visibility: Visibility;
    tags: string[];
  }): Promise<AgentIdentity> {
    const existing = await this.readIdentity();
    if (existing) {
      return this.updateAgent(existing.id, {
        name: opts.name,
        visibility: opts.visibility,
        tags: opts.tags,
        status: "active",
        pid: opts.pid,
      });
    }

    const id = nanoid(8) as AgentId;
    const agent: AgentIdentity = {
      id,
      name: opts.name,
      harness: opts.harness,
      pid: opts.pid,
      startedAt: new Date().toISOString(),
      visibility: opts.visibility,
      status: "active",
      tags: opts.tags,
      subscribedRooms: [],
    };

    await fs.mkdir(path.dirname(this.agentPath(id)), { recursive: true });
    await fs.writeFile(this.agentPath(id), JSON.stringify(agent, null, 2), "utf-8");
    await this.writeIdentity(id);
    return agent;
  }

  async getAgent(id: AgentId): Promise<AgentIdentity | undefined> {
    try {
      const raw = await fs.readFile(this.agentPath(id), "utf-8");
      return JSON.parse(raw) as AgentIdentity;
    } catch {
      return undefined;
    }
  }

  async updateAgent(
    id: AgentId,
    patch: Partial<Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">>,
  ): Promise<AgentIdentity> {
    const agent = await this.getAgent(id);
    if (!agent) throw new BusError(`Agent ${id} not found`, "AGENT_NOT_FOUND");

    Object.assign(agent, patch);
    await fs.writeFile(this.agentPath(id), JSON.stringify(agent, null, 2), "utf-8");
    return agent;
  }

  async listAgents(requesterId: AgentId): Promise<AgentIdentity[]> {
    const dir = path.join(this.root, "registry", "agents");
    try {
      const files = await fs.readdir(dir);
      const agents: AgentIdentity[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const agent = JSON.parse(raw) as AgentIdentity;
        // Ghost agents are invisible to everyone
        if (agent.visibility === "ghost" && agent.id !== requesterId) continue;
        agents.push(agent);
      }
      return agents;
    } catch {
      return [];
    }
  }

  async setAgentOffline(id: AgentId): Promise<void> {
    const agent = await this.getAgent(id);
    if (agent) {
      agent.status = "offline";
      await fs.writeFile(this.agentPath(id), JSON.stringify(agent, null, 2), "utf-8");
    }
  }

  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------

  async createRoom(opts: {
    name: string;
    type: RoomType;
    owner: AgentId;
    description: string;
  }): Promise<Room> {
    const id = (opts.type === "secret" ? `_${opts.name}` : opts.name) as RoomId;
    const existing = await this.getRoom(id);
    if (existing) throw new BusError(`Room ${id} already exists`, "ROOM_EXISTS");

    const room: Room = {
      id,
      name: opts.name,
      type: opts.type,
      owner: opts.owner,
      createdAt: new Date().toISOString(),
      description: opts.description,
      members: [opts.owner],
      invited: [],
    };

    await fs.mkdir(path.dirname(this.roomPath(id)), { recursive: true });
    await fs.writeFile(this.roomPath(id), JSON.stringify(room, null, 2), "utf-8");
    await fs.mkdir(this.roomMessagesDir(id), { recursive: true });
    return room;
  }

  async getRoom(id: RoomId): Promise<Room | undefined> {
    try {
      const raw = await fs.readFile(this.roomPath(id), "utf-8");
      return JSON.parse(raw) as Room;
    } catch {
      return undefined;
    }
  }

  async listRooms(requesterId: AgentId): Promise<Room[]> {
    const dir = path.join(this.root, "registry", "rooms");
    try {
      const files = await fs.readdir(dir);
      const rooms: Room[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const room = JSON.parse(raw) as Room;
        // Secret rooms: only visible to members
        if (room.type === "secret" && !room.members.includes(requesterId)) continue;
        rooms.push(room);
      }
      return rooms;
    } catch {
      return [];
    }
  }

  async joinRoom(roomId: RoomId, agentId: AgentId): Promise<Room> {
    const room = await this.getRoom(roomId);
    if (!room) throw new BusError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");

    if (room.type === "public") {
      if (!room.members.includes(agentId)) {
        room.members.push(agentId);
      }
    } else {
      // private/secret: must be invited or owner
      if (!room.invited.includes(agentId) && room.owner !== agentId && !room.members.includes(agentId)) {
        throw new BusError(`Not invited to room ${roomId}`, "NOT_INVITED");
      }
      room.invited = room.invited.filter((id) => id !== agentId);
      if (!room.members.includes(agentId)) {
        room.members.push(agentId);
      }
    }

    await fs.writeFile(this.roomPath(roomId), JSON.stringify(room, null, 2), "utf-8");

    // Update agent's subscribed rooms
    const agent = await this.getAgent(agentId);
    if (agent && !agent.subscribedRooms.includes(roomId)) {
      agent.subscribedRooms.push(roomId);
      await fs.writeFile(this.agentPath(agentId), JSON.stringify(agent, null, 2), "utf-8");
    }

    // Notify other members
    await this.deliverToMembers(
      roomId,
      { type: "member_joined", room: roomId, agent: agentId },
      agentId,
    );

    return room;
  }

  async leaveRoom(roomId: RoomId, agentId: AgentId): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) throw new BusError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");

    room.members = room.members.filter((id) => id !== agentId);
    await fs.writeFile(this.roomPath(roomId), JSON.stringify(room, null, 2), "utf-8");

    const agent = await this.getAgent(agentId);
    if (agent) {
      agent.subscribedRooms = agent.subscribedRooms.filter((id) => id !== roomId);
      await fs.writeFile(this.agentPath(agentId), JSON.stringify(agent, null, 2), "utf-8");
    }

    await this.deliverToMembers(
      roomId,
      { type: "member_left", room: roomId, agent: agentId },
      agentId,
    );

    // Destroy room if empty and not public lobby
    if (room.members.length === 0 && room.owner === agentId) {
      await this.destroyRoom(roomId, agentId);
    }
  }

  async inviteToRoom(roomId: RoomId, targetId: AgentId, inviterId: AgentId): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) throw new BusError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== inviterId) throw new BusError("Only the room owner can invite", "NOT_OWNER");

    if (!room.invited.includes(targetId) && !room.members.includes(targetId)) {
      room.invited.push(targetId);
    }
    await fs.writeFile(this.roomPath(roomId), JSON.stringify(room, null, 2), "utf-8");

    await this.deliver(targetId, { type: "room_invite", room: roomId, from: inviterId });
  }

  async kickFromRoom(roomId: RoomId, targetId: AgentId, kickerId: AgentId): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) throw new BusError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== kickerId) throw new BusError("Only the room owner can kick", "NOT_OWNER");

    room.members = room.members.filter((id) => id !== targetId);
    room.invited = room.invited.filter((id) => id !== targetId);
    await fs.writeFile(this.roomPath(roomId), JSON.stringify(room, null, 2), "utf-8");
  }

  async destroyRoom(roomId: RoomId, agentId: AgentId): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) throw new BusError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (room.owner !== agentId) throw new BusError("Only the room owner can destroy", "NOT_OWNER");

    // Remove from all members' subscribed rooms
    for (const memberId of room.members) {
      const member = await this.getAgent(memberId);
      if (member) {
        member.subscribedRooms = member.subscribedRooms.filter((id) => id !== roomId);
        await fs.writeFile(this.agentPath(memberId), JSON.stringify(member, null, 2), "utf-8");
      }
    }

    // Remove room files
    await fs.unlink(this.roomPath(roomId)).catch(() => {});
    await fs.rm(this.roomMessagesDir(roomId), { recursive: true }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async sendRoomMessage(
    roomId: RoomId,
    from: AgentId,
    content: string,
    replyTo?: string,
  ): Promise<RoomMessage> {
    const room = await this.getRoom(roomId);
    if (!room) throw new BusError(`Room ${roomId} not found`, "ROOM_NOT_FOUND");
    if (!room.members.includes(from)) throw new BusError(`Not a member of ${roomId}`, "NOT_MEMBER");

    const id = `${Date.now()}-${nanoid(6)}`;
    const message: RoomMessage = {
      id,
      from,
      room: roomId,
      content,
      timestamp: new Date().toISOString(),
      replyTo,
    };

    await fs.mkdir(this.roomMessagesDir(roomId), { recursive: true });
    await fs.writeFile(
      path.join(this.roomMessagesDir(roomId), `${id}.json`),
      JSON.stringify(message, null, 2),
      "utf-8",
    );

    // Deliver to all other members
    await this.deliverToMembers(roomId, { type: "room_message", message }, from);

    return message;
  }

  async readRoomMessages(roomId: RoomId, since?: string): Promise<RoomMessage[]> {
    const dir = this.roomMessagesDir(roomId);
    try {
      const files = await fs.readdir(dir);
      const messages: RoomMessage[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        const msg = JSON.parse(raw) as RoomMessage;
        if (!since || msg.timestamp > since) {
          messages.push(msg);
        }
      }
      messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      return messages;
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // DMs
  // -------------------------------------------------------------------------

  async sendDm(from: AgentId, to: AgentId, content: string): Promise<DmMessage> {
    // Check recipient exists and isn't ghost (unless it's yourself)
    if (to !== from) {
      const recipient = await this.getAgent(to);
      if (!recipient) throw new BusError(`Agent ${to} not found`, "AGENT_NOT_FOUND");
      if (recipient.visibility === "ghost")
        throw new BusError(`Cannot DM agent ${to}`, "AGENT_NOT_FOUND");
    }

    const id = `${Date.now()}-${nanoid(6)}`;
    const message: DmMessage = {
      id,
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
    };

    const dir = this.dmDir(from, to);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(message, null, 2), "utf-8");

    // Deliver to recipient's queue
    await this.deliver(to, { type: "dm", message });

    return message;
  }

  // -------------------------------------------------------------------------
  // Delivery
  // -------------------------------------------------------------------------

  async deliver(agentId: AgentId, event: DeliveryEvent): Promise<void> {
    const dir = this.deliveryDir(agentId);
    await fs.mkdir(dir, { recursive: true });
    const id = `${Date.now()}-${nanoid(6)}`;
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify(event, null, 2),
      "utf-8",
    );
  }

  async drainDelivery(agentId: AgentId): Promise<DeliveryEvent[]> {
    const dir = this.deliveryDir(agentId);
    try {
      const files = await fs.readdir(dir);
      const events: DeliveryEvent[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(dir, file), "utf-8");
        events.push(JSON.parse(raw) as DeliveryEvent);
        await fs.unlink(path.join(dir, file));
      }
      events.sort((a, b) => {
        const ta = "message" in a ? (a.message as { timestamp: string }).timestamp : "";
        const tb = "message" in b ? (b.message as { timestamp: string }).timestamp : "";
        return ta.localeCompare(tb);
      });
      return events;
    } catch {
      return [];
    }
  }

  private async deliverToMembers(
    roomId: RoomId,
    event: DeliveryEvent,
    excludeAgent: AgentId,
  ): Promise<void> {
    const room = await this.getRoom(roomId);
    if (!room) return;

    for (const memberId of room.members) {
      if (memberId !== excludeAgent) {
        await this.deliver(memberId, event);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Bus initialisation
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    const dirs = [
      path.join(this.root, "registry", "agents"),
      path.join(this.root, "registry", "rooms"),
      path.join(this.root, "rooms"),
      path.join(this.root, "dms"),
      path.join(this.root, "delivery"),
    ];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }
}
