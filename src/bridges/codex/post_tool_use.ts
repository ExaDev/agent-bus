/**
 * Agent Comms — Codex PostToolUse hook.
 *
 * Drains the agent-comms delivery queue after every tool call within a turn.
 * If pending messages exist, injects them as additional context so Codex
 * processes them mid-turn.
 *
 * Run via: npx agent-comms bridge codex-post-tool-use
 *
 * Requires [features] codex_hooks = true in config.toml.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DeliveryEventSchema } from "../../core/types.js";
import type { DeliveryEvent } from "../../core/types.js";

const BUS_ROOT = path.join(os.homedir(), ".agents", "bus");
const IDENTITY_DIR = path.join(BUS_ROOT, "identity");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readIdentity(): string | undefined {
  try {
    const files = fs
      .readdirSync(IDENTITY_DIR)
      .filter((f) => f.startsWith("codex--"));
    if (files.length === 0) return undefined;
    const latest = files.sort((a, b) => {
      const sa = fs.statSync(path.join(IDENTITY_DIR, a));
      const sb = fs.statSync(path.join(IDENTITY_DIR, b));
      return sb.mtimeMs - sa.mtimeMs;
    })[0];
    if (!latest) return undefined;
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(IDENTITY_DIR, latest), "utf-8"),
    );
    if (isRecord(parsed) && typeof parsed.id === "string") {
      return parsed.id;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function drainDelivery(agentId: string): DeliveryEvent[] {
  const deliveryDir = path.join(BUS_ROOT, "delivery", agentId);
  try {
    const files = fs
      .readdirSync(deliveryDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const events: DeliveryEvent[] = [];
    for (const file of files) {
      const fp = path.join(deliveryDir, file);
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(fp, "utf-8"));
        events.push(DeliveryEventSchema.parse(parsed));
        fs.unlinkSync(fp);
      } catch {
        fs.unlinkSync(fp);
      }
    }
    events.sort((a, b) => {
      const ta =
        a.type === "room_message" || a.type === "dm" ? a.message.timestamp : "";
      const tb =
        b.type === "room_message" || b.type === "dm" ? b.message.timestamp : "";
      return ta.localeCompare(tb);
    });
    return events;
  } catch {
    return [];
  }
}

function formatEvent(event: DeliveryEvent): string {
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

export function run(): void {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => chunks.push(chunk));
  process.stdin.on("end", () => {
    // Parse hook input (we don't need it, but consume it)
    try {
      JSON.parse(chunks.join(""));
    } catch {
      /* no input, fine */
    }

    const agentId = readIdentity();
    if (!agentId) process.exit(0);

    const events = drainDelivery(agentId);
    if (events.length === 0) process.exit(0);

    const lines = events.map(formatEvent);
    const message =
      "📬 Agent Comms pending messages:\n" +
      lines.map((l) => `- ${l}`).join("\n");

    process.stdout.write(
      JSON.stringify(
        {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: message,
          },
        },
        null,
        2,
      ) + "\n",
    );
  });
}
