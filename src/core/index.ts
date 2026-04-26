/**
 * Agent Bus — cross-harness LLM agent communication.
 *
 * Core protocol: types, filesystem store, tool handler.
 * Bridges (pi extension, Claude Code channel) are in ../bridges/.
 */

export { BusStore, BusError } from "./store.js";
export { BusTool } from "./tool.js";
export type { ToolContext, ToolResult } from "./tool.js";
export {
  buildAction,
  formatDeliveryEvent,
  ensureRegistered,
  drainAndFormat,
  MCP_TOOL_SCHEMA,
} from "./bridge.js";
export type { RegistrationResult } from "./bridge.js";
export * from "./types.js";
