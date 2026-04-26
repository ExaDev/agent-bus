#!/usr/bin/env python3
"""
Agent Bus — Codex Stop hook.

Drains the agent-bus delivery queue when Codex finishes a turn.
If pending messages exist, returns decision=block with the messages
as the reason, causing Codex to continue processing them immediately.

Install in ~/.codex/hooks.json:

{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/Developer/agent-bus/src/bridges/codex/stop_hook.py",
            "timeout": 5
          }
        ]
      }
    ]
  }
}

Requires [features] codex_hooks = true in config.toml.
"""

import json
import os
import sys
from pathlib import Path

BUS_ROOT = Path(os.path.expanduser("~/.agents/bus"))
IDENTITY_FILE = BUS_ROOT / "identity.json"


def read_identity() -> str | None:
    """Read the agent's bus identity."""
    try:
        data = json.loads(IDENTITY_FILE.read_text(encoding="utf-8"))
        return data.get("id")
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return None


def drain_delivery(agent_id: str) -> list[dict]:
    """Drain and return all pending delivery events."""
    delivery_dir = BUS_ROOT / "delivery" / agent_id
    if not delivery_dir.is_dir():
        return []

    events: list[dict] = []
    for file in sorted(delivery_dir.glob("*.json")):
        try:
            event = json.loads(file.read_text(encoding="utf-8"))
            events.append(event)
            file.unlink()
        except (json.JSONDecodeError, OSError):
            # Remove malformed files
            file.unlink(missing_ok=True)

    # Sort by timestamp if available
    def get_ts(e: dict) -> str:
        msg = e.get("message", {})
        return msg.get("timestamp", "") if isinstance(msg, dict) else ""

    events.sort(key=get_ts)
    return events


def format_event(event: dict) -> str:
    """Format a delivery event as human-readable text."""
    event_type = event.get("type", "")
    if event_type == "room_message":
        msg = event.get("message", {})
        return f"[{msg.get('room', '?')}] {msg.get('from', '?')}: {msg.get('content', '')}"
    elif event_type == "dm":
        msg = event.get("message", {})
        return f"DM from {msg.get('from', '?')}: {msg.get('content', '')}"
    elif event_type == "room_invite":
        return f"Invited to room {event.get('room', '?')} by {event.get('from', '?')}"
    elif event_type == "member_joined":
        return f"{event.get('agent', '?')} joined {event.get('room', '?')}"
    elif event_type == "member_left":
        return f"{event.get('agent', '?')} left {event.get('room', '?')}"
    return f"Unknown event: {event_type}"


def main() -> None:
    # Read the Codex hook input from stdin
    hook_input = json.load(sys.stdin)

    agent_id = read_identity()
    if agent_id is None:
        # Not registered — nothing to do
        sys.exit(0)

    events = drain_delivery(agent_id)
    if not events:
        # No pending messages — let Codex stop normally
        sys.exit(0)

    # Format messages and block Codex's stop
    lines = [format_event(e) for e in events]
    message = "📬 Agent Bus pending messages:\n" + "\n".join(f"- {line}" for line in lines)

    result = {
        "decision": "block",
        "reason": message,
    }
    json.dump(result, sys.stdout, indent=2)
    print()  # trailing newline


if __name__ == "__main__":
    main()
