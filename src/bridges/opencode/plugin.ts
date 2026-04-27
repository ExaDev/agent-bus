/**
 * Agent Comms — OpenCode plugin bridge.
 *
 * Drains delivery queue on session.idle and injects messages via
 * tui.prompt.append + tui.submitPrompt.
 *
 * Install (project):  ln -s ~/Developer/agent-comms/src/bridges/opencode/plugin.ts .opencode/plugins/agent-comms.ts
 * Install (global):   ln -s ~/Developer/agent-comms/src/bridges/opencode/plugin.ts ~/.config/opencode/plugins/agent-comms.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  BusStore,
  ensureRegistered,
  drainAndFormat,
} from "../../core/index.js";
import { nanoid } from "../../core/nanoid.js";

const store = new BusStore(path.join(os.homedir(), ".agents", "bus"));

// Minimal interface for the OpenCode SDK client we actually use
interface OpenCodeClient {
  tui: {
    appendPrompt(body: { text: string }): Promise<unknown>;
    submitPrompt(): Promise<unknown>;
  };
  session: {
    list(): Promise<{ data: { id: string }[] }>;
    prompt(opts: {
      path: { id: string };
      body: { parts: { type: string; text: string }[] };
    }): Promise<unknown>;
  };
}

function isOpenCodeClient(value: unknown): value is OpenCodeClient {
  if (typeof value !== "object" || value === null) return false;
  if (!("tui" in value)) return false;
  if (!("session" in value)) return false;
  return true;
}

export const AgentCommsPlugin = async (opts: {
  project: unknown;
  client: unknown;
  $: unknown;
  directory: string;
  worktree: string;
}) => {
  if (!isOpenCodeClient(opts.client)) {
    throw new Error("Agent Comms plugin requires a valid OpenCode client");
  }
  const client = opts.client;

  const reg = await ensureRegistered({
    cwd: process.cwd(),
    store,
    harness: "opencode",
    defaultName: `opencode-${nanoid(4)}`,
  });
  const agentId = reg.agentId;

  // Watch delivery dir and push immediately when messages arrive
  const deliveryDir = store.deliveryDir(agentId);
  fs.mkdirSync(deliveryDir, { recursive: true });
  fs.watch(deliveryDir, (event, filename) => {
    if (event !== "rename" || !filename?.endsWith(".json")) return;
    void drainAndInject();
  });

  async function drainAndInject() {
    const lines = await drainAndFormat(store, agentId);
    if (lines.length === 0) return;

    const message = "📬 Agent Comms:\n" + lines.map((l) => `- ${l}`).join("\n");
    try {
      await client.tui.appendPrompt({ text: message });
      await client.tui.submitPrompt();
    } catch {
      // Fallback: prompt the current session directly
      const sessions = await client.session.list();
      const current = sessions.data[0];
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

  return {
    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.idle") {
        await drainAndInject();
      }
    },
  };
};
