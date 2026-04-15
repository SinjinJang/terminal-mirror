const net = require('net');
const fs = require('fs');
const { discoverSessions, getTokenPath, sessionMarkerExists } = require('../platform');
const {
  createSession, trackTerminalState, appendReplayBuffer, broadcast,
} = require('./session');
const { findLabel, removeLabel } = require('./session-labels');

const SOCKET_RECONNECT_MS = 3000;
const SOCKET_RECONNECT_MAX = 10;

let sessions = null;

function init(sessionsMap) {
  sessions = sessionsMap;
}

function connectToWrapper(session) {
  if (!session.wrapperToken) {
    try {
      session.wrapperToken = fs.readFileSync(getTokenPath(session.pid), 'utf-8').trim();
    } catch { /* token file may not exist yet */ }
  }

  process.stderr.write(`Connecting to wrapper PID ${session.pid}: ${session.sockPath}\n`);

  const sock = net.createConnection(session.sockPath);
  session.socket = sock;
  session.lineBuf = '';

  sock.on('connect', () => {
    session.connected = true;
    session.reconnects = 0;
    process.stderr.write(`Connected to wrapper PID ${session.pid}.\n`);
    broadcast(session.terminalClients, { type: 'wrapper_status', connected: true });
  });

  sock.on('data', (chunk) => {
    session.lineBuf += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = session.lineBuf.indexOf('\n')) !== -1) {
      const line = session.lineBuf.substring(0, newlineIdx);
      session.lineBuf = session.lineBuf.substring(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleWrapperMessage(session, msg);
      } catch { /* ignore malformed JSON */ }
    }
  });

  function scheduleReconnect() {
    session.connected = false;
    session.socket = null;
    if (session.reconnects < SOCKET_RECONNECT_MAX && sessionMarkerExists(session.pid)) {
      session.reconnects++;
      setTimeout(() => connectToWrapper(session), SOCKET_RECONNECT_MS);
    }
  }

  sock.on('close', () => {
    broadcast(session.terminalClients, { type: 'wrapper_status', connected: false });
    process.stderr.write(`Disconnected from wrapper PID ${session.pid}.\n`);
    scheduleReconnect();
  });

  sock.on('error', (err) => {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      scheduleReconnect();
    }
  });
}

function handleWrapperMessage(session, msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'hello': {
      const pid = msg.pid || session.pid;
      const startedAt = msg.startedAt || null;
      const persistedLabel = findLabel(pid, startedAt);
      session.wrapperInfo = {
        cwd: msg.cwd || process.cwd(),
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        pid,
        cmd: msg.cmd || '',
        startedAt,
        label: session.wrapperInfo.label || persistedLabel || msg.label || null,
      };
      if (msg.token && !session.wrapperToken) {
        session.wrapperToken = msg.token;
      }
      broadcast(session.terminalClients, { type: 'resize', cols: session.wrapperInfo.cols, rows: session.wrapperInfo.rows });
      break;
    }

    case 'scrollback':
    case 'output': {
      const buf = Buffer.from(msg.data, 'base64');
      trackTerminalState(session, buf);
      appendReplayBuffer(session, buf);
      broadcast(session.terminalClients, buf);
      break;
    }

    case 'resize':
      session.wrapperInfo.cols = msg.cols;
      session.wrapperInfo.rows = msg.rows;
      broadcast(session.terminalClients, { type: 'resize', cols: msg.cols, rows: msg.rows });
      break;

    case 'exit':
      broadcast(session.terminalClients, { type: 'wrapper_status', connected: false, exitCode: msg.exitCode });
      break;
  }
}

function sendToWrapper(session, obj) {
  if (session.socket && session.connected) {
    try {
      session.socket.write(JSON.stringify(obj) + '\n');
    } catch { /* socket may be closing */ }
  }
}

function discoverAndConnect() {
  const found = discoverSessions();

  for (const [pid, ipcPath] of found) {
    if (!sessions.has(pid)) {
      const session = createSession(pid, ipcPath);
      sessions.set(pid, session);
      connectToWrapper(session);
    }
  }

  for (const [pid, session] of sessions) {
    if (!found.has(pid) && !session.connected) {
      for (const ws of session.terminalClients) ws.close();
      for (const ws of session.commentClients) ws.close();
      for (const { res, timer } of session.pollWaiters) {
        clearTimeout(timer);
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session removed' }));
      }
      sessions.delete(pid);
      removeLabel(pid, session.wrapperInfo.startedAt);
      process.stderr.write(`Removed stale session PID ${pid}.\n`);
    }
  }
}

module.exports = { init, connectToWrapper, sendToWrapper, discoverAndConnect };
