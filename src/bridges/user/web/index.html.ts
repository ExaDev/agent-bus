/**
 * Frontend HTML — single-page chat UI served as a string constant.
 *
 * Vanilla JS + CSS, no build step, no framework. Communicates via
 * REST API + WebSocket.
 */

export const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Comms</title>
<style>
  :root {
    --bg: #1a1a2e;
    --surface: #16213e;
    --border: #0f3460;
    --text: #e4e4e4;
    --dim: #888;
    --accent: #00b4d8;
    --green: #06d6a0;
    --red: #ef476f;
    --yellow: #ffd166;
    --purple: #b5838d;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: flex;
  }
  #sidebar {
    width: 260px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #sidebar h2 {
    padding: 12px 16px;
    font-size: 14px;
    color: var(--accent);
    border-bottom: 1px solid var(--border);
  }
  .sidebar-section {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }
  .sidebar-section h3 {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--dim);
    padding: 8px 8px 4px;
  }
  .room-item, .agent-item {
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .room-item:hover, .agent-item:hover { background: rgba(255,255,255,0.05); }
  .room-item.active { background: var(--border); }
  .status-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
  }
  .status-dot.active { background: var(--green); }
  .status-dot.idle { background: var(--yellow); }
  .status-dot.busy { background: var(--red); }
  .status-dot.offline { background: var(--dim); }
  #main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #header {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
    font-size: 15px;
    font-weight: 600;
    background: var(--surface);
  }
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .msg {
    font-size: 13px;
    line-height: 1.5;
  }
  .msg .sender { font-weight: 600; color: var(--accent); }
  .msg .time { color: var(--dim); font-size: 11px; margin-left: 8px; }
  .msg.system { color: var(--dim); font-style: italic; }
  .msg.status { color: var(--yellow); font-size: 12px; }
  .msg.dm { color: var(--purple); }
  .msg .dm-badge {
    background: var(--purple);
    color: #fff;
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    font-weight: 600;
  }
  #input-bar {
    display: flex;
    padding: 12px 20px;
    gap: 8px;
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  #input {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text);
    font-size: 13px;
    outline: none;
  }
  #input:focus { border-color: var(--accent); }
  #send-btn {
    background: var(--accent);
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }
  #send-btn:hover { opacity: 0.9; }
  #empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--dim);
    font-size: 14px;
  }
</style>
</head>
<body>

<div id="sidebar">
  <h2>Agent Comms</h2>
  <div class="sidebar-section">
    <h3>Rooms</h3>
    <div id="room-list"></div>
    <h3>Agents</h3>
    <div id="agent-list"></div>
  </div>
</div>

<div id="main">
  <div id="header">Select a room</div>
  <div id="messages"></div>
  <div id="input-bar">
    <input id="input" type="text" placeholder="Type a message or /command..." autocomplete="off" />
    <button id="send-btn">Send</button>
  </div>
</div>

<script>
const $ = (s) => document.querySelector(s);
const messagesEl = $('#messages');
const inputEl = $('#input');
const headerEl = $('#header');
const roomListEl = $('#room-list');
const agentListEl = $('#agent-list');

let currentRoom = null;
let ws = null;

// Connect WebSocket
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);

  ws.onopen = () => { addSystem('Connected to mesh'); };
  ws.onclose = () => { addSystem('Disconnected — reconnecting...'); setTimeout(connect, 3000); };
  ws.onerror = () => {};

  ws.onmessage = (e) => {
    const frame = JSON.parse(e.data);
    if (frame.type === 'delivery') handleDelivery(frame.event);
    if (frame.type === 'result') addSystem(frame.result.content);
    if (frame.type === 'error') addSystem('Error: ' + frame.message);
    if (frame.type === 'state') {
      renderAgents(frame.agents);
      renderRooms(frame.rooms);
    }
  };
}

function sendAction(params) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(params));
  }
}

// Delivery event handling
function handleDelivery(event) {
  switch (event.type) {
    case 'room_message':
      if (!currentRoom || event.message.room !== currentRoom) return;
      addMessage(event.message.from, event.message.content, event.message.timestamp);
      break;
    case 'dm':
      addDm(event.message.from, event.message.content, event.message.timestamp);
      break;
    case 'member_joined':
      addSystem(event.agent + ' joined ' + event.room);
      refreshState();
      break;
    case 'member_left':
      addSystem(event.agent + ' left ' + event.room);
      refreshState();
      break;
    case 'member_status':
      addStatus(event.agent + ' is now ' + event.status + ' in ' + event.room);
      refreshState();
      break;
    case 'delivery_status':
      addStatus('Message ' + event.messageId + ' ' + event.status + ' by ' + event.agent);
      break;
    case 'room_members':
      if (currentRoom === event.room) {
        addSystem('Members: ' + event.members.map(m => m.name + ' (' + m.status + ')').join(', '));
      }
      break;
    case 'room_invite': {
      const desc = event.roomDescription ? ' — ' + event.roomDescription : '';
      addSystem(event.fromName + ' invited you to "' + event.room + '"' + desc);
      break;
    }
    case 'invite_declined':
      addSystem(event.agentName + ' declined invite to ' + event.room + ': "' + event.reason + '"');
      break;
  }
}

// UI rendering
function addMessage(sender, content, timestamp) {
  const time = (timestamp || new Date().toISOString()).slice(11, 19);
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = '<span class="sender">' + esc(sender) + '</span><span class="time">' + time + '</span>: ' + esc(content);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addDm(sender, content, timestamp) {
  const time = (timestamp || new Date().toISOString()).slice(11, 19);
  const div = document.createElement('div');
  div.className = 'msg dm';
  div.innerHTML = '<span class="dm-badge">DM</span> <span class="sender">' + esc(sender) + '</span><span class="time">' + time + '</span>: ' + esc(content);
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystem(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addStatus(text) {
  const div = document.createElement('div');
  div.className = 'msg status';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function clearMessages() {
  messagesEl.innerHTML = '';
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// State refresh
async function refreshState() {
  const [agentsRes, roomsRes] = await Promise.all([
    fetch('/api/agents'), fetch('/api/rooms')
  ]);
  renderAgents(await agentsRes.json());
  renderRooms(await roomsRes.json());
}

function renderAgents(agents) {
  agentListEl.innerHTML = '';
  for (const a of agents) {
    const div = document.createElement('div');
    div.className = 'agent-item';
    const dot = a.status || 'offline';
    div.innerHTML = '<span class="status-dot ' + dot + '"></span> ' + esc(a.name);
    agentListEl.appendChild(div);
  }
}

function renderRooms(rooms) {
  roomListEl.innerHTML = '';
  for (const r of rooms) {
    const div = document.createElement('div');
    div.className = 'room-item' + (currentRoom === r.id ? ' active' : '');
    const joined = r.members.length;
    div.innerHTML = r.type.charAt(0).toUpperCase() + ' ' + esc(r.name) + ' <span style="color:var(--dim)">(' + joined + ')</span>';
    div.onclick = () => joinRoom(r.id);
    roomListEl.appendChild(div);
  }
}

async function joinRoom(roomId) {
  currentRoom = roomId;
  headerEl.textContent = roomId;
  clearMessages();

  // Highlight in sidebar
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('active'));
  sendAction({ action: 'join_room', room: roomId });

  // Load history
  const res = await fetch('/api/rooms/' + encodeURIComponent(roomId) + '/messages');
  const messages = await res.json();
  for (const m of messages) {
    addMessage(m.from, m.content, m.timestamp);
  }
  addSystem('Joined ' + roomId);
  inputEl.focus();
}

// Input handling
function handleInput() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';

  if (text.startsWith('/')) {
    const parts = text.slice(1).split(/\\s+/);
    const cmd = parts[0].toLowerCase();
    switch (cmd) {
      case 'join': sendAction({ action: 'join_room', room: parts[1] }); break;
      case 'leave': sendAction({ action: 'leave_room', room: parts[1] || currentRoom }); break;
      case 'rooms': refreshState(); break;
      case 'agents': refreshState(); break;
      case 'dm': sendAction({ action: 'dm', target: parts[1], content: parts.slice(2).join(' ') }); break;
      case 'create': sendAction({ action: 'create_room', name: parts[1], type: 'public' }); break;
      case 'destroy': sendAction({ action: 'destroy_room', room: parts[1] }); break;
      case 'help':
        addSystem('Commands: /join, /leave, /rooms, /agents, /dm, /create, /destroy, /help');
        break;
      default:
        addSystem('Unknown command: /' + cmd);
    }
  } else if (currentRoom) {
    sendAction({ action: 'send', target: currentRoom, content: text });
  } else {
    addSystem('Join a room first (click one in the sidebar)');
  }
}

$('#send-btn').onclick = handleInput;
inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleInput(); });

// Boot
connect();
refreshState();
inputEl.focus();
</script>
</body>
</html>`;
