#!/usr/bin/env node
// Shim: npx installs into node_modules/, and Node.js refuses to
// type-strip .ts files inside node_modules. This .js entry point
// re-invokes node on the real .ts script so it runs outside that
// restriction.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "setup.ts");

// Forward all args. execFileSync throws on non-zero exit.
try {
  execFileSync(process.execPath, [script, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
} catch (e) {
  // execFileSync throws with .status on non-zero exit — propagate it
  if (e && typeof e === "object" && "status" in e) process.exit(e.status);
  throw e;
}
