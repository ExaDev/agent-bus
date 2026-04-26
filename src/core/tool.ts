/**
 * Tool handler — processes BusAction objects and returns human-readable results.
 *
 * This is the shared logic that every bridge calls into. Bridges just:
 *   1. Parse the LLM's tool call into a BusAction
 *   2. Call handleAction(action)
 *   3. Return the result string to the LLM
 */

import type {
  AgentId,
  AgentIdentity,
  BusAction,
  Room,
  RoomMessage,
} from "./types.js";
import { BusStore, BusError } from "./store.js";

export interface ToolContext {
  agentId: AgentId;
  harness: AgentIdentity["harness"];
  pid: number;
}

export interface ToolResult {
  content: string;
  /** If true, the result is an error. */
  isError: boolean;
}

export class BusTool {
  constructor(private readonly store: BusStore) {}

  async handle(ctx: ToolContext, action: BusAction): Promise<ToolResult> {
    try {
      switch (action.action) {
        case "register":
          return await this.register(ctx, action);
        case "update":
          return await this.update(ctx, action);
        case "whoami":
          return await this.whoami(ctx);
        case "create_room":
          return await this.createRoom(ctx, action);
        case "list_rooms":
          return await this.listRooms(ctx);
        case "join_room":
          return await this.joinRoom(ctx, action);
        case "leave_room":
          return await this.leaveRoom(ctx, action);
        case "send":
          return await this.send(ctx, action);
        case "dm":
          return await this.dm(ctx, action);
        case "list_agents":
          return await this.listAgents(ctx);
        case "read_room":
          return await this.readRoom(ctx, action);
        case "invite":
          return await this.invite(ctx, action);
        case "kick":
          return await this.kick(ctx, action);
        case "destroy_room":
          return await this.destroyRoom(ctx, action);
        default:
          return { content: `Unknown action: ${(action as { action: string }).action}`, isError: true };
      }
    } catch (err) {
      if (err instanceof BusError) {
        return { content: `Error: ${err.message} (${err.code})`, isError: true };
      }
      return { content: `Internal error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private async register(
    ctx: ToolContext,
    action: BusAction & { action: "register" },
  ): Promise<ToolResult> {
    const agent = await this.store.registerAgent({
      name: action.name,
      harness: ctx.harness,
      pid: ctx.pid,
      visibility: action.visibility,
      tags: action.tags,
    });
    return {
      content: `Registered as ${agent.name} (${agent.id}) with visibility "${agent.visibility}".`,
      isError: false,
    };
  }

  private async update(
    ctx: ToolContext,
    action: BusAction & { action: "update" },
  ): Promise<ToolResult> {
    const patch: Partial<Pick<AgentIdentity, "name" | "visibility" | "status" | "tags" | "pid">> = {};
    if (action.visibility !== undefined) patch.visibility = action.visibility;
    if (action.status !== undefined) patch.status = action.status;
    if (action.name !== undefined) patch.name = action.name;
    if (action.tags !== undefined) patch.tags = action.tags;
    const agent = await this.store.updateAgent(ctx.agentId, patch);
    return {
      content: `Updated: name=${agent.name}, visibility=${agent.visibility}, status=${agent.status}`,
      isError: false,
    };
  }

  private async whoami(ctx: ToolContext): Promise<ToolResult> {
    const agent = await this.store.getAgent(ctx.agentId);
    if (!agent) return { content: "Not registered.", isError: true };
    return {
      content: [
        `ID: ${agent.id}`,
        `Name: ${agent.name}`,
        `Harness: ${agent.harness}`,
        `Visibility: ${agent.visibility}`,
        `Status: ${agent.status}`,
        `Tags: ${agent.tags.join(", ") || "(none)"}`,
        `Rooms: ${agent.subscribedRooms.join(", ") || "(none)"}`,
      ].join("\n"),
      isError: false,
    };
  }

  private async createRoom(
    ctx: ToolContext,
    action: BusAction & { action: "create_room" },
  ): Promise<ToolResult> {
    const room = await this.store.createRoom({
      name: action.name,
      type: action.type,
      owner: ctx.agentId,
      description: action.description,
    });
    // Auto-join the creator
    await this.store.joinRoom(room.id, ctx.agentId);
    return {
      content: `Created ${room.type} room "${room.name}" (${room.id}).`,
      isError: false,
    };
  }

  private async listRooms(ctx: ToolContext): Promise<ToolResult> {
    const rooms = await this.store.listRooms(ctx.agentId);
    if (rooms.length === 0) return { content: "No rooms found.", isError: false };

    const lines = rooms.map((r: Room) => {
      const memberFlag = r.members.includes(ctx.agentId) ? "✓" : " ";
      return `[${memberFlag}] ${r.type.padEnd(7)} ${r.name} (${r.members.length} members) — ${r.description}`;
    });
    return {
      content: `Rooms ([✓] = joined):\n${lines.join("\n")}`,
      isError: false,
    };
  }

  private async joinRoom(
    ctx: ToolContext,
    action: BusAction & { action: "join_room" },
  ): Promise<ToolResult> {
    const roomId = action.room as import("./types.js").RoomId;
    const room = await this.store.joinRoom(roomId, ctx.agentId);
    return {
      content: `Joined room "${room.name}" (${room.members.length} members).`,
      isError: false,
    };
  }

  private async leaveRoom(
    ctx: ToolContext,
    action: BusAction & { action: "leave_room" },
  ): Promise<ToolResult> {
    await this.store.leaveRoom(action.room as import("./types.js").RoomId, ctx.agentId);
    return { content: `Left room "${action.room}".`, isError: false };
  }

  private async send(
    ctx: ToolContext,
    action: BusAction & { action: "send" },
  ): Promise<ToolResult> {
    const roomId = action.target as import("./types.js").RoomId;
    const msg = await this.store.sendRoomMessage(roomId, ctx.agentId, action.content, action.replyTo);
    return {
      content: `Sent to ${action.target}: ${msg.id}`,
      isError: false,
    };
  }

  private async dm(
    ctx: ToolContext,
    action: BusAction & { action: "dm" },
  ): Promise<ToolResult> {
    const targetId = action.target as import("./types.js").AgentId;
    const msg = await this.store.sendDm(ctx.agentId, targetId, action.content);
    return {
      content: `DM sent to ${action.target}: ${msg.id}`,
      isError: false,
    };
  }

  private async listAgents(ctx: ToolContext): Promise<ToolResult> {
    const agents = await this.store.listAgents(ctx.agentId);
    if (agents.length === 0) return { content: "No other agents online.", isError: false };

    const lines = agents.map((a: AgentIdentity) => {
      const self = a.id === ctx.agentId ? " (you)" : "";
      return `${a.id}  ${a.name.padEnd(25)} ${a.harness.padEnd(12)} ${a.status.padEnd(7)} ${a.visibility}${self}`;
    });
    return {
      content: `Agents:\n  ID      Name                      Harness      Status  Visibility\n${lines.map((l) => `  ${l}`).join("\n")}`,
      isError: false,
    };
  }

  private async readRoom(
    ctx: ToolContext,
    action: BusAction & { action: "read_room" },
  ): Promise<ToolResult> {
    const roomId = action.room as import("./types.js").RoomId;
    const messages = await this.store.readRoomMessages(roomId, action.since);
    if (messages.length === 0) return { content: "No messages.", isError: false };

    const lines = messages.map((m: RoomMessage) => {
      const time = m.timestamp.slice(11, 19);
      return `[${time}] ${m.from}: ${m.content}`;
    });
    return { content: lines.join("\n"), isError: false };
  }

  private async invite(
    ctx: ToolContext,
    action: BusAction & { action: "invite" },
  ): Promise<ToolResult> {
    await this.store.inviteToRoom(
      action.room as import("./types.js").RoomId,
      action.agent as import("./types.js").AgentId,
      ctx.agentId,
    );
    return { content: `Invited ${action.agent} to ${action.room}.`, isError: false };
  }

  private async kick(
    ctx: ToolContext,
    action: BusAction & { action: "kick" },
  ): Promise<ToolResult> {
    await this.store.kickFromRoom(
      action.room as import("./types.js").RoomId,
      action.agent as import("./types.js").AgentId,
      ctx.agentId,
    );
    return { content: `Kicked ${action.agent} from ${action.room}.`, isError: false };
  }

  private async destroyRoom(
    ctx: ToolContext,
    action: BusAction & { action: "destroy_room" },
  ): Promise<ToolResult> {
    await this.store.destroyRoom(action.room as import("./types.js").RoomId, ctx.agentId);
    return { content: `Destroyed room "${action.room}".`, isError: false };
  }
}
