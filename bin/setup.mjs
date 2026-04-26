#!/usr/bin/env node
/**
 * agent-bus setup — detect installed harnesses and configure bridges.
 *
 * Usage:
 *   npx github:ExaDev/agent-bus          # setup (default)
 *   npx github:ExaDev/agent-bus setup     # same as above
 *   npx github:ExaDev/agent-bus status    # check current configuration
 *   npx github:ExaDev/agent-bus remove    # undo configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

const HOME = os.homedir();
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

// ---------------------------------------------------------------------------
// Harness detection
// ---------------------------------------------------------------------------

const harnesses = [
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
  default:
    console.log(`Usage: agent-bus [setup|status|remove]`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function setup() {
  console.log("🔌 Agent Bus setup\n");

  // 1. Detect harnesses
  const detected = harnesses.filter(h => h.detect());

  console.log("Detected harnesses:");
  for (const h of harnesses) {
    const found = detected.includes(h);
    console.log(`  ${found ? "✓" : "✗"} ${h.id}`);
  }

  if (detected.length === 0) {
    console.log("\nNo supported harnesses found. Install one of: pi, Claude Code, Codex, OpenCode");
    process.exit(1);
  }

  console.log();

  // 3. Configure each detected harness
  for (const h of detected) {
    console.log(`Configuring ${h.id}...`);
    h.configure();
  }

  console.log(`\n✓ Done! ${detected.length} harness${detected.length === 1 ? "" : "es"} configured.`);
}

function status() {
  console.log("🔌 Agent Bus status\n");
  console.log(`Package: ${SCRIPT_DIR}\n`);

  for (const h of harnesses) {
    const installed = h.detect();
    const result = installed ? h.check() : null;

    if (!installed) {
      console.log(`  ✗ ${h.id} — not found`);
    } else if (result.configured) {
      console.log(`  ✓ ${h.id} — configured`);
      for (const detail of result.details) {
        console.log(`    ${detail}`);
      }
    } else {
      console.log(`  ⚠ ${h.id} — detected but not configured`);
      for (const detail of result.details) {
        console.log(`    ${detail}`);
      }
    }
  }
}

function remove() {
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

function install(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    fs.unlinkSync(linkPath);
  }
  fs.copyFileSync(target, linkPath);
  console.log(`  → Installed ${linkPath}`);
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
  console.log(`  → Wrote ${filePath}`);
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function bridgePath(...segments) {
  return path.resolve(SCRIPT_DIR, "..", "src", "bridges", ...segments);
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

function configurePi() {
  const extDir = path.join(HOME, ".pi", "agent", "extensions", "agent-bus");
  install(bridgePath("pi", "index.ts"), path.join(extDir, "index.ts"));
}

function removePi() {
  const extDir = path.join(HOME, ".pi", "agent", "extensions", "agent-bus");
  fs.rmSync(extDir, { recursive: true, force: true });
  console.log(`  Removed ${extDir}`);
}

function checkPi() {
  const link = path.join(HOME, ".pi", "agent", "extensions", "agent-bus", "index.ts");
  const exists = fs.existsSync(link);
  return {
    configured: exists,
    details: exists ? [`Installed: ${link}`] : [`Not installed — expected at ${link}`],
  };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

function configureClaudeCode() {
  // Project .mcp.json
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const config = readJSON(mcpPath);

  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers["agent-bus"] = {
    command: "bun",
    args: [bridgePath("claude-code", "channel.ts")],
  };

  writeJSON(mcpPath, config);
}

function removeClaudeCode() {
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const config = readJSON(mcpPath);
  if (config.mcpServers?.["agent-bus"]) {
    delete config.mcpServers["agent-bus"];
    writeJSON(mcpPath, config);
    console.log(`  Removed agent-bus from ${mcpPath}`);
  }
}

function checkClaudeCode() {
  const mcpPath = path.join(process.cwd(), ".mcp.json");
  const config = readJSON(mcpPath);
  const configured = !!config.mcpServers?.["agent-bus"];
  return {
    configured,
    details: configured
      ? [`Config: ${mcpPath}`]
      : [`Not in ${mcpPath} — run setup in your project directory`],
  };
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function configureCodex() {
  const codexDir = path.join(HOME, ".codex");

  // config.toml — append MCP server entry
  const configPath = path.join(codexDir, "config.toml");
  fs.mkdirSync(codexDir, { recursive: true });

  let toml = "";
  try { toml = fs.readFileSync(configPath, "utf-8"); } catch { /* empty */ }

  if (!toml.includes("[mcp_servers.agent-bus]")) {
    const entry = `\n[mcp_servers.agent-bus]\ncommand = "node"\nargs = ["--experimental-strip-types", "${bridgePath("codex", "tool.ts")}"]\n`;
    fs.appendFileSync(configPath, entry);
    console.log(`  → Added MCP server to ${configPath}`);
  } else {
    console.log(`  → MCP server already in ${configPath}`);
  }

  // hooks.json
  const hooksPath = path.join(codexDir, "hooks.json");
  const hookCommand = `python3 ${bridgePath("codex", "stop_hook.py")}`;
  const hooks = readJSON(hooksPath);

  if (!hooks.hooks) hooks.hooks = {};
  if (!hooks.hooks.Stop) hooks.hooks.Stop = [{ hooks: [] }];

  const stopHook = hooks.hooks.Stop[0];
  if (!stopHook.hooks) stopHook.hooks = [];

  const exists = stopHook.hooks.some(h =>
    h.type === "command" && h.command?.includes("stop_hook.py"),
  );

  if (!exists) {
    stopHook.hooks.push({
      type: "command",
      command: hookCommand,
      timeout: 5,
    });
    writeJSON(hooksPath, hooks);
  } else {
    console.log(`  → Stop hook already in ${hooksPath}`);
  }
}

function removeCodex() {
  const configPath = path.join(HOME, ".codex", "config.toml");
  try {
    let toml = fs.readFileSync(configPath, "utf-8");
    toml = toml.replace(/\n\[mcp_servers\.agent-bus\][^\n]*(\n[^\[]*)*/g, "");
    fs.writeFileSync(configPath, toml);
    console.log(`  Removed MCP server from ${configPath}`);
  } catch { /* no config */ }

  const hooksPath = path.join(HOME, ".codex", "hooks.json");
  const hooks = readJSON(hooksPath);
  if (hooks.hooks?.Stop?.[0]?.hooks) {
    hooks.hooks.Stop[0].hooks = hooks.hooks.Stop[0].hooks.filter(
      h => !h.command?.includes("stop_hook.py"),
    );
    writeJSON(hooksPath, hooks);
  }
}

function checkCodex() {
  const details = [];

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
  const hasHook = hooks.hooks?.Stop?.[0]?.hooks?.some(
    h => h.command?.includes("stop_hook.py"),
  );
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

function configureOpenCode() {
  // Prefer project-level, fall back to global
  const projectPluginDir = path.join(process.cwd(), ".opencode", "plugins");
  const globalPluginDir = path.join(HOME, ".config", "opencode", "plugins");

  const pluginDir = fs.existsSync(path.join(process.cwd(), ".opencode"))
    ? projectPluginDir
    : globalPluginDir;

  install(bridgePath("opencode", "plugin.ts"), path.join(pluginDir, "agent-bus.ts"));
}

function removeOpenCode() {
  const locations = [
    path.join(process.cwd(), ".opencode", "plugins", "agent-bus.ts"),
    path.join(HOME, ".config", "opencode", "plugins", "agent-bus.ts"),
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      fs.unlinkSync(loc);
      console.log(`  Removed ${loc}`);
    }
  }
}

function checkOpenCode() {
  const locations = [
    path.join(process.cwd(), ".opencode", "plugins", "agent-bus.ts"),
    path.join(HOME, ".config", "opencode", "plugins", "agent-bus.ts"),
  ];
  const found = locations.find(l => fs.existsSync(l));
  return {
    configured: !!found,
    details: found
      ? [`Plugin: ${found}`]
      : [`Not found — checked ${locations.join(", ")}`],
  };
}
