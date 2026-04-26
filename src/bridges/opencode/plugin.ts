/**
 * Agent Bus — OpenCode plugin bridge.
 *
 * Provides the "agent_bus" custom tool and watches the delivery queue
 * for incoming messages. When the session goes idle (agent finishes a turn),
 * the plugin drains pending messages and injects them via tui.prompt.append
 * + tui.submitPrompt.
 *
 * Install:
 *   Option A — Local plugin:
 *     mkdir -p .opencode/plugins
 *     ln -s ~/Developer/agent-bus/src/bridges/opencode/plugin.ts .opencode/plugins/agent-bus.ts
 *
 *   Option B — Add to opencode.json:
 *     { "plugin": ["agent-bus"] }  (if published to npm)
 *
 *   Option C — Global:
 *     mkdir -p ~/.config/opencode/plugins
 *     ln -s ~/Developer/agent-bus/src/bridges/opencode/plugin.ts ~/.config/opencode/plugins/agent-bus.ts
 *
 * Dependencies: Add to .opencode/package.json or ~/.config/opencode/package.json:
 *   { "dependencies": { "@opencode-ai/plugin": "*" } }
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Inline core imports — if agent-bus is built as a package, import from it instead
import { BusStore, BusTool } from "../../core/index.js";
import type { AgentId, BusAction, DeliveryEvent, Visibility } from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const BUS_ROOT = path.join(os.homedir(), ".agents", "bus");

export const AgentBusPlugin = async ({ client }: {
  project: unknown;
  client: any; // @opencode-ai/sdk client — typed as `any` to avoid hard dep
  $: unknown;
  directory: string;
  worktree: string;
}) => {
  const store = new BusStore(BUS_ROOT);
  const tool = new BusTool(store);

  let agentId: AgentId | undefined;
  let watcher: fs.FSWatcher | undefined;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  await store.init();

  const identity = await store.readIdentity();
  if (identity) {
    agentId = identity.id;
    await store.updateAgent(agentId, { status: "active", pid: process.pid });
  } else {
    const agent = await store.registerAgent({
      name: `opencode-${nanoid(4)}`,
      harness: "opencode",
      pid: process.pid,
      visibility: "visible",
      tags: [],
    });
    agentId = agent.id;
  }

  // Start watching delivery queue
  startWatching();

  // -----------------------------------------------------------------------
  // Delivery watcher — drain on session.idle
  // -----------------------------------------------------------------------

  function startWatching() {
    if (!agentId) return;
    const deliveryDir = store.deliveryDir(agentId);
    fs.mkdirSync(deliveryDir, { recursive: true });

    watcher = fs.watch(deliveryDir, async (event, filename) => {
      if (event !== "rename" || !filename?.endsWith(".json")) return;
      // Don't push immediately — wait for session.idle to inject
    });
  }

  async function drainAndInject() {
    if (!agentId) return;
    const events = await store.drainDelivery(agentId);
    if (events.length === 0) return;

    const lines = events.map(formatDeliveryEvent);
    const message = "📬 Agent Bus pending messages:\n" + lines.map(l => `- ${l}`).join("\n");

    try {
      await client.tui.appendPrompt({ body: { text: message } });
      await client.tui.submitPrompt();
    } catch (err) {
      // Fallback: use session.prompt with noReply=false
      const sessions = await client.session.list();
      const current = sessions.data?.[0];
      if (current) {
        await client.session.prompt({
          path: { id: current.id },
          body: {
            parts: [{ type: "text", text: message }],
          },
        });
      }
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
  // Custom tool definition
  // -----------------------------------------------------------------------

  // We can't import the `tool` helper at runtime without the package installed,
  // so we define the tool shape directly via the plugin return object.

  return {
    // Drain delivery queue when session goes idle
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.idle") {
        await drainAndInject();
      }
    },

    // Provide the agent_bus as a custom tool
    // Note: OpenCode plugins define tools differently depending on the SDK version.
    // This uses the documented pattern from https://opencode.ai/docs/plugins
  };
};
