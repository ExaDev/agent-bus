/**
 * Agent Bus — OpenCode plugin bridge.
 *
 * Drains delivery queue on session.idle and injects messages via
 * tui.prompt.append + tui.submitPrompt.
 *
 * Install (project):  ln -s ~/Developer/agent-bus/src/bridges/opencode/plugin.ts .opencode/plugins/agent-bus.ts
 * Install (global):   ln -s ~/Developer/agent-bus/src/bridges/opencode/plugin.ts ~/.config/opencode/plugins/agent-bus.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  BusStore,
  BusTool,
  buildAction,
  ensureRegistered,
  drainAndFormat,
} from "../../core/index.js";
import type { AgentId } from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const store = new BusStore(path.join(os.homedir(), ".agents", "bus"));
const tool = new BusTool(store);

let agentId: AgentId | undefined;
let watcher: fs.FSWatcher | undefined;

export const AgentBusPlugin = async ({ client }: {
  project: unknown;
  client: any; // @opencode-ai/sdk — typed as any to avoid hard dep
  $: unknown;
  directory: string;
  worktree: string;
}) => {
  const reg = await ensureRegistered({ store, harness: "opencode", defaultName: `opencode-${nanoid(4)}` });
  agentId = reg.agentId;

  // Watch delivery dir so we know when messages arrive
  const deliveryDir = store.deliveryDir(agentId);
  fs.mkdirSync(deliveryDir, { recursive: true });
  watcher = fs.watch(deliveryDir, () => {
    // Don't push immediately — session.idle will drain
  });

  async function drainAndInject() {
    if (!agentId) return;
    const lines = await drainAndFormat(store, agentId);
    if (lines.length === 0) return;

    const message = "📬 Agent Bus:\n" + lines.map(l => `- ${l}`).join("\n");
    try {
      await client.tui.appendPrompt({ body: { text: message } });
      await client.tui.submitPrompt();
    } catch {
      // Fallback: prompt the current session directly
      const sessions = await client.session.list();
      const current = sessions.data?.[0];
      if (current) {
        await client.session.prompt({
          path: { id: current.id },
          body: { parts: [{ type: "text", text: message }] },
        });
      }
    }
  }

  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.idle") {
        await drainAndInject();
      }
    },
  };
};
