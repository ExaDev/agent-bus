#!/usr/bin env npx tsx
/**
 * agent-bus — cross-harness LLM agent communication bus.
 *
 * Usage:
 *   npx agent-bus              # setup (auto-detect and configure)
 *   npx agent-bus setup        # same as above
 *   npx agent-bus status       # check current configuration
 *   npx agent-bus remove       # undo configuration
 *   npx agent-bus bridge <id>  # run a bridge (used by harness configs)
 *
 * The bridge subcommand lets harnesses invoke the bridge via npx:
 *   .mcp.json:  { "command": "npx", "args": ["agent-bus", "bridge", "claude-code"] }
 *   config.toml: command = "npx", args = ["agent-bus", "bridge", "codex"]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";

const HOME = os.homedir();
const PKG_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  configured: boolean;
  details: string[];
}

interface HarnessDef {
  id: string;
  detect: () => boolean;
  configure: () => void;
  remove: () => void;
  check: () => CheckResult;
}

// ---------------------------------------------------------------------------
// Harness definitions
// ---------------------------------------------------------------------------

const harnesses: HarnessDef[] = [
  {
    id: "pi",
    detect: () => fs.existsSync(path.join(HOME, ".pi", "agent", "extensions")),
    configure: () => configurePi(),
    remove: () => removePi(),
    check: () => checkPi(),
  },
  {
    id: "claude-code",
    detect: () => {
      try { execSync("which claude", { stdio: "pipe" }); return true; } catch { return false; }
    },
    configure: () => configureClaudeCode(),
    remove: () => removeClaudeCode(),
    check: () => checkClaudeCode(),
  },
  {
    id: "codex",
    detect: () => {
      try { execSync("which codex", { stdio: "pipe" }); return true; } catch { return false; }
    },
    configure: () => configureCodex(),
    remove: () => removeCodex(),
    check: () => checkCodex(),
  },
  {
    id: "opencode",
    detect: () => {
      try { execSync("which opencode", { stdio: "pipe" }); return true; } catch { return false; }
    },
    configure: () => configureOpenCode(),
    remove: () => removeOpenCode(),
    check: () => checkOpenCode(),
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] ?? "setup";

switch (command) {
  case "setup":
    setup();
    break;
  case "status":
    status();
    break;
  case "remove":
    remove();
    break;
  case "bridge": {
    const bridgeId = process.argv[3];
    if (!bridgeId) {
      console.error("Usage: agent-bus bridge <id>");
      process.exit(1);
    }
    runBridge(bridgeId);
    break;
  }
  default:
    console.log("Usage: agent-bus [setup|status|remove|bridge <id>]");
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Bridge runner
// ---------------------------------------------------------------------------

function runBridge(id: string): void {
  const bridgeDir = path.join(PKG_DIR, "src", "bridges", id);

  // Find the entry point for this bridge
  const entryPoints: Array<{ file: string; runner: () => [string, string[]] }> = [
    { file: path.join(bridgeDir, "channel.ts"), runner: () => tsRunner(path.join(bridgeDir, "channel.ts")) },
    { file: path.join(bridgeDir, "tool.ts"),    runner: () => tsRunner(path.join(bridgeDir, "tool.ts")) },
    { file: path.join(bridgeDir, "index.ts"),   runner: () => tsRunner(path.join(bridgeDir, "index.ts")) },
    { file: path.join(bridgeDir, "plugin.ts"),  runner: () => tsRunner(path.join(bridgeDir, "plugin.ts")) },
    { file: path.join(bridgeDir, "stop_hook.ts"), runner: () => tsRunner(path.join(bridgeDir, "stop_hook.ts")) },
  ];

  const entry = entryPoints.find(e => fs.existsSync(e.file));
  if (!entry) {
    console.error(`Unknown bridge: ${id}`);
    process.exit(1);
  }

  const [cmd, args] = entry.runner();
  const child = spawn(cmd, args, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

function tsRunner(entry: string): [string, string[]] {
  try {
    execSync("which bun", { stdio: "pipe" });
    return ["bun", [entry]];
  } catch {
    return ["npx", ["tsx", entry]];
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function setup(): void {
  console.log("🔌 Agent Bus setup\n");

  const detected = harnesses.filter(h => h.detect());

  console.log("Detected harnesses:");
  for (const h of harnesses) {
    console.log(`  ${detected.includes(h) ? "✓" : "✗"} ${h.id}`);
  }

  if (detected.length === 0) {
    console.log("\nNo supported harnesses found. Install one of: pi, Claude Code, Codex, OpenCode");
    process.exit(1);
  }

  console.log();

  for (const h of detected) {
    console.log(`Configuring ${h.id}...`);
    h.configure();
  }

  console.log(`\n✓ Done! ${detected.length} harness${detected.length === 1 ? "" : "es"} configured.`);
  console.log("\nBridges run via: npx agent-bus bridge <id>");
}

function status(): void {
  console.log("🔌 Agent Bus status\n");

  for (const h of harnesses) {
    const installed = h.detect();
    const result = installed ? h.check() : { configured: false, details: [] as string[] };

    if (!installed) {
      console.log(`  ✗ ${h.id} — not found`);
    } else if (result.configured) {
      console.log(`  ✓ ${h.id} — configured`);
      for (const detail of result.details) console.log(`    ${detail}`);
    } else {
      console.log(`  ⚠ ${h.id} — detected but not configured`);
      for (const detail of result.details) console.log(`    ${detail}`);
    }
  }
}

function remove(): void {
  console.log("🔌 Agent Bus removal\n");

  for (const h of harnesses) {
    if (h.detect()) {
      console.log(`Removing ${h.id}...`);
      h.remove();
    }
  }

  console.log("\n✓ Done!");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeJSON(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  → Wrote ${filePath}`);
}

function readJSON(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

function configurePi(): void {
  const settingsPath = path.join(HOME, ".pi", "agent", "settings.json");
  const settings = readJSON(settingsPath);

  const bridgeDir = path.join(PKG_DIR, "src", "bridges", "pi");
  const extensions = (settings.extensions as string[]) ?? [];

  if (!extensions.includes(bridgeDir)) {
    extensions.push(bridgeDir);
    settings.extensions = extensions;
    writeJSON(settingsPath, settings);
  } else {
    console.log(`  → Already in ${settingsPath}`);
  }
}

function removePi(): void {
  const settingsPath = path.join(HOME, ".pi", "agent", "settings.json");
  const settings = readJSON(settingsPath);
  const bridgeDir = path.join(PKG_DIR, "src", "bridges", "pi");

  const extensions = settings.extensions as string[] | undefined;
  if (extensions) {
    settings.extensions = extensions.filter(e => e !== bridgeDir);
    writeJSON(settingsPath, settings);
  }
}

function checkPi(): CheckResult {
  const settingsPath = path.join(HOME, ".pi", "agent", "settings.json");
  const settings = readJSON(settingsPath);
  const bridgeDir = path.join(PKG_DIR, "src", "bridges", "pi");
  const configured = ((settings.extensions as string[]) ?? []).includes(bridgeDir);
  return {
    configured,
    details: configured
      ? [`Extension: ${bridgeDir}`]
      : [`Not in ${settingsPath} extensions`],
  };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function configureClaudeCode(): void {
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const config = readJSON(mcpPath);

  if (!config.mcpServers) config.mcpServers = {};
  const servers = config.mcpServers as Record<string, unknown>;
  servers["agent-bus"] = {
    command: "npx",
    args: ["agent-bus", "bridge", "claude-code"],
  };

  writeJSON(mcpPath, config);
}

function removeClaudeCode(): void {
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const config = readJSON(mcpPath);
  const servers = config.mcpServers as Record<string, unknown> | undefined;
  if (servers?.["agent-bus"]) {
    delete servers["agent-bus"];
    writeJSON(mcpPath, config);
    console.log(`  Removed agent-bus from ${mcpPath}`);
  }
}

function checkClaudeCode(): CheckResult {
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const config = readJSON(mcpPath);
  const servers = config.mcpServers as Record<string, Record<string, unknown>> | undefined;
  const entry = servers?.["agent-bus"];
  const configured = !!entry;
  return {
    configured,
    details: configured
      ? [`Config: ${mcpPath}`, `Command: ${entry.command} ${(entry.args as string[])?.join(" ") ?? ""}`]
      : [`Not in ${mcpPath} — run setup in your project directory`],
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function configureCodex(): void {
  const codexDir = path.join(HOME, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });

  // config.toml — MCP server via npx
  const configPath = path.join(codexDir, "config.toml");
  let toml = "";
  try { toml = fs.readFileSync(configPath, "utf-8"); } catch { /* no file */ }

  if (!toml.includes("[mcp_servers.agent-bus]")) {
    const entry = `\n[mcp_servers.agent-bus]\ncommand = "npx"\nargs = ["agent-bus", "bridge", "codex"]\n`;
    fs.appendFileSync(configPath, entry);
    console.log(`  → Added MCP server to ${configPath}`);
  } else {
    console.log(`  → MCP server already in ${configPath}`);
  }

  // hooks.json — stop hook via npx
  const hooksPath = path.join(codexDir, "hooks.json");
  const hooks = readJSON(hooksPath);

  if (!hooks.hooks) hooks.hooks = {};
  const topHooks = hooks.hooks as Record<string, unknown>;
  if (!topHooks.Stop) topHooks.Stop = [{ hooks: [] }];
  const stopArray = (topHooks.Stop as Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>);

  if (!stopArray[0]) stopArray[0] = { hooks: [] };
  if (!stopArray[0].hooks) stopArray[0].hooks = [];

  const exists = stopArray[0].hooks.some(h => h.command?.includes("agent-bus"));

  if (!exists) {
    stopArray[0].hooks.push({
      type: "command",
      command: "npx agent-bus bridge codex-stop",
      timeout: 5,
    });
    writeJSON(hooksPath, hooks);
  } else {
    console.log(`  → Stop hook already in ${hooksPath}`);
  }
}

function removeCodex(): void {
  const configPath = path.join(HOME, ".codex", "config.toml");
  try {
    const toml = fs.readFileSync(configPath, "utf-8");
    fs.writeFileSync(configPath, toml.replace(/\n\[mcp_servers\.agent-bus\][^\n]*(\n[^\[]*)*/g, ""));
    console.log(`  Removed MCP server from ${configPath}`);
  } catch { /* no config */ }

  const hooksPath = path.join(HOME, ".codex", "hooks.json");
  const hooks = readJSON(hooksPath);
  const topHooks = hooks.hooks as Record<string, unknown> | undefined;
  const stopArray = topHooks?.Stop as Array<{ hooks: Array<{ command: string }> }> | undefined;
  if (stopArray?.[0]?.hooks) {
    stopArray[0].hooks = stopArray[0].hooks.filter(h => !h.command?.includes("agent-bus"));
    writeJSON(hooksPath, hooks);
  }
}

function checkCodex(): CheckResult {
  const details: string[] = [];

  const configPath = path.join(HOME, ".codex", "config.toml");
  try {
    const toml = fs.readFileSync(configPath, "utf-8");
    details.push(toml.includes("[mcp_servers.agent-bus]")
      ? `MCP server: configured in ${configPath}`
      : `MCP server: not in ${configPath}`);
  } catch {
    details.push(`MCP server: no ${configPath}`);
  }

  const hooksPath = path.join(HOME, ".codex", "hooks.json");
  const hooks = readJSON(hooksPath);
  const topHooks = hooks.hooks as Record<string, unknown> | undefined;
  const stopArray = topHooks?.Stop as Array<{ hooks: Array<{ command: string }> }> | undefined;
  const hasHook = stopArray?.[0]?.hooks?.some(h => h.command?.includes("agent-bus"));
  details.push(hasHook
    ? `Stop hook: configured in ${hooksPath}`
    : `Stop hook: not in ${hooksPath}`);

  return {
    configured: details.every(d => d.includes("configured")),
    details,
  };
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

function configureOpenCode(): void {
  const configPaths = [
    path.join(process.cwd(), "opencode.json"),
    path.join(HOME, ".config", "opencode", "opencode.json"),
  ];

  const found = configPaths.find(p => fs.existsSync(p));
  const configPath = found ?? path.join(process.cwd(), "opencode.json");
  const config = readJSON(configPath);

  const plugins = (config.plugin as string[]) ?? [];
  if (!plugins.includes("agent-bus")) {
    plugins.push("agent-bus");
    config.plugin = plugins;
    writeJSON(configPath, config);
  } else {
    console.log(`  → Already in ${configPath}`);
  }
}

function removeOpenCode(): void {
  const configPaths = [
    path.join(process.cwd(), "opencode.json"),
    path.join(HOME, ".config", "opencode", "opencode.json"),
  ];

  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;
    const config = readJSON(configPath);
    const plugins = config.plugin as string[] | undefined;
    if (plugins) {
      config.plugin = plugins.filter(p => p !== "agent-bus");
      writeJSON(configPath, config);
    }
  }
}

function checkOpenCode(): CheckResult {
  const configPaths = [
    path.join(process.cwd(), "opencode.json"),
    path.join(HOME, ".config", "opencode", "opencode.json"),
  ];

  const details: string[] = [];
  let configured = false;

  for (const configPath of configPaths) {
    const config = readJSON(configPath);
    if (((config.plugin as string[]) ?? []).includes("agent-bus")) {
      configured = true;
      details.push(`Plugin: configured in ${configPath}`);
    }
  }

  if (!configured) {
    details.push(`Not found — checked ${configPaths.join(", ")}`);
  }

  return { configured, details };
}
