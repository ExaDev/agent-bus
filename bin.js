#!/usr/bin/env node
// Shim: Node.js refuses to type-strip .ts files inside node_modules/.
// Copy the real CLI to a temp dir and execute it from there.
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "src");
const tmpDir = join(tmpdir(), `agent-bus-${process.pid}`);

// Copy src/ to temp location so Node can type-strip it
mkdirSync(tmpDir, { recursive: true });
cpSync(srcDir, join(tmpDir, "src"), { recursive: true });

const script = join(tmpDir, "src", "cli.ts");

try {
  execFileSync(process.execPath, [script, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (e) {
  if (e && typeof e === "object" && "status" in e) process.exit(e.status);
  throw e;
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
