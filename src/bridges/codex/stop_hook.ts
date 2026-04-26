/**
 * Agent Bus — Codex Stop hook.
 *
 * Drains the agent-bus delivery queue when Codex finishes a turn.
 * If pending messages exist, returns decision=block with the messages
 * as the reason, causing Codex to continue processing them immediately.
 *
 * Run via: npx agent-bus bridge codex-stop
 *
 * Requires [features] codex_hooks = true in config.toml.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { DeliveryEvent } from "../../core/types.js";

const BUS_ROOT = path.join(os.homedir(), ".agents", "bus");
const IDENTITY_FILE = path.join(BUS_ROOT, "identity.json");

interface Identity {
  id: string;
}

function readIdentity(): string | undefined {
  try {
    const data = JSON.parse(fs.readFileSync(IDENTITY_FILE, "utf-8")) as Identity;
    return data.id;
  } catch {
    return undefined;
  }
}

function drainDelivery(agentId: string): DeliveryEvent[] {
  const deliveryDir = path.join(BUS_ROOT, "delivery", agentId);
  try {
    const files = fs.readdirSync(deliveryDir).filter(f => f.endsWith(".json")).sort();
    const events: DeliveryEvent[] = [];
    for (const file of files) {
      const fp = path.join(deliveryDir, file);
      try {
        events.push(JSON.parse(fs.readFileSync(fp, "utf-8")) as DeliveryEvent);
        fs.unlinkSync(fp);
      } catch {
        fs.unlinkSync(fp);
      }
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

// Read Codex hook input from stdin, then drain and respond
const chunks: string[] = [];
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => chunks.push(chunk));
process.stdin.on("end", () => {
  // Parse hook input (we don't need it, but Codex sends it)
  try { JSON.parse(chunks.join("")); } catch { /* no input, fine */ }

  const agentId = readIdentity();
  if (!agentId) process.exit(0);

  const events = drainDelivery(agentId);
  if (events.length === 0) process.exit(0);

  const lines = events.map(formatEvent);
  const message = "📬 Agent Bus pending messages:\n" + lines.map(l => `- ${l}`).join("\n");

  process.stdout.write(JSON.stringify({ decision: "block", reason: message }, null, 2) + "\n");
});
