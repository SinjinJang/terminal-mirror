#!/usr/bin/env node

// mirror-server.js — Multi-session web mirror server.
// Connects to multiple tm-wrapper Unix sockets and serves a web UI
// with session switching for terminal mirroring.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const qrTerminal = require('qrcode-terminal');
const { spawn: spawnChild } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { discoverSessions, getTokenPath, sessionMarkerExists } = require('./platform');

// ── Constants ──
const START_PORT = 3456;
const MAX_PORT_SCAN = 100;
const POLL_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_SELECTED_TEXT = 80;
const MAX_MESSAGE_QUEUE = 100;
const SOCKET_RECONNECT_MS = 3000;
const SOCKET_RECONNECT_MAX = 10;
const SESSION_SCAN_INTERVAL_MS = 5000;
const MAX_LABEL_LENGTH = 50;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

// ── Load config file ──
function loadConfigFile() {
  const configPath = path.join(os.homedir(), '.config', 'terminal-mirror', 'config.json');
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    process.stderr.write(`CONFIG=${configPath}\n`);
    return data;
  } catch (err) {
    process.stderr.write(`Warning: config not loaded (${configPath}): ${err.code || err.message}\n`);
    return {};
  }
}

const config = loadConfigFile();

// ── Parse CLI args (overrides config file) ──
const rawArgs = process.argv.slice(2);
let openBrowserFlag = false;
let remoteMode = false;
let customPort = null;
let spawnSession = false;
let noAuth = false;

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--open') {
    openBrowserFlag = true;
  } else if (rawArgs[i] === '--remote') {
    remoteMode = true;
  } else if (rawArgs[i] === '--spawn') {
    spawnSession = true;
  } else if (rawArgs[i] === '--no-auth') {
    noAuth = true;
  } else if ((rawArgs[i] === '--port' || rawArgs[i] === '-p') && rawArgs[i + 1]) {
    customPort = parseInt(rawArgs[++i], 10);
    if (isNaN(customPort) || customPort < 1 || customPort > 65535) {
      process.stderr.write('Invalid port number. Must be 1-65535.\n');
      process.exit(1);
    }
  }
}

// Apply config file defaults for flags not set via CLI
if (!openBrowserFlag && config.open) openBrowserFlag = true;
if (!remoteMode && config.remote) remoteMode = true;
if (!spawnSession && config.spawn) spawnSession = true;
if (customPort == null && config.port != null) {
  customPort = parseInt(config.port, 10);
  if (isNaN(customPort) || customPort < 1 || customPort > 65535) {
    process.stderr.write('Invalid port in config file. Must be 1-65535.\n');
    process.exit(1);
  }
}
if (config.noAuth != null && !noAuth) {
  noAuth = !!config.noAuth;
}

// ── Dependency: ws ──
let WebSocket;
try {
  WebSocket = require('ws');
} catch (e) {
  const pluginDir = path.resolve(__dirname, '..');
  console.error(`ws not installed. Run: cd ${pluginDir} && npm install`);
  process.exit(1);
}

// ── Basic Auth credentials from config ──
const authUsername = config.username || null;
const authPassword = config.password || null;
const authEnabled = !noAuth && authUsername && authPassword;

if (!noAuth && !authEnabled) {
  process.stderr.write('Error: Authentication required but no credentials configured.\n');
  process.stderr.write('Set "username" and "password" in ~/.config/terminal-mirror/config.json,\n');
  process.stderr.write('or use --no-auth to disable authentication.\n');
  process.exit(1);
}

// ── State ──
const sessions = new Map(); // keyed by wrapper PID
const spawnedChildren = new Map(); // PID → child process (spawned via --spawn)
let serverPort = null;
let scanTimer = null;

function createSession(pid, ipcPath) {
  return {
    pid,
    sockPath: ipcPath,
    socket: null,
    connected: false,
    wrapperInfo: { cwd: process.cwd(), cols: 80, rows: 24, pid, cmd: '', startedAt: null, label: null },
    wrapperToken: null,
    lineBuf: '',
    reconnects: 0,
    terminalClients: new Set(),
    commentClients: new Set(),
    messageQueue: [],
    pollWaiters: [],
    replayChunks: [], // recent output chunks for new clients
    replaySize: 0,
    termState: { altScreen: false, cursorHidden: false },
  };
}

const REPLAY_BUFFER_MAX = 512 * 1024; // 512 KB

// Track DEC private mode sequences to maintain terminal state.
// This lets us restore state (alt screen, cursor visibility) for new clients
// when the original escape sequences have been pushed out of the replay buffer.
function trackTerminalState(session, buf) {
  const str = buf.toString('latin1');

  // Cursor visibility: \e[?25l (hide) / \e[?25h (show)
  const lastCursorHide = str.lastIndexOf('\x1b[?25l');
  const lastCursorShow = str.lastIndexOf('\x1b[?25h');
  if (lastCursorHide !== -1 || lastCursorShow !== -1) {
    session.termState.cursorHidden = lastCursorHide > lastCursorShow;
  }

  // Alternate screen buffer: \e[?1049h (enter) / \e[?1049l (leave)
  const lastAltEnter = str.lastIndexOf('\x1b[?1049h');
  const lastAltLeave = str.lastIndexOf('\x1b[?1049l');
  if (lastAltEnter !== -1 || lastAltLeave !== -1) {
    session.termState.altScreen = lastAltEnter > lastAltLeave;
  }
}

// Build a prefix of escape sequences that restores terminal state
// not already established by the replay buffer itself.
function getStateRestorationPrefix(session) {
  const replay = getReplayBuffer(session);
  let replayAltScreen = false;
  let replayCursorHidden = false;

  if (replay) {
    const str = replay.toString('latin1');
    const lastAltEnter = str.lastIndexOf('\x1b[?1049h');
    const lastAltLeave = str.lastIndexOf('\x1b[?1049l');
    replayAltScreen = lastAltEnter > lastAltLeave;

    const lastCursorHide = str.lastIndexOf('\x1b[?25l');
    const lastCursorShow = str.lastIndexOf('\x1b[?25h');
    replayCursorHidden = lastCursorHide > lastCursorShow;
  }

  let prefix = '';
  if (session.termState.altScreen && !replayAltScreen) {
    prefix += '\x1b[?1049h';
  }
  if (session.termState.cursorHidden && !replayCursorHidden) {
    prefix += '\x1b[?25l';
  }
  return prefix ? Buffer.from(prefix) : null;
}

function appendReplayBuffer(session, buf) {
  session.replayChunks.push(buf);
  session.replaySize += buf.length;
  while (session.replaySize > REPLAY_BUFFER_MAX && session.replayChunks.length > 1) {
    session.replaySize -= session.replayChunks.shift().length;
  }
}

function getReplayBuffer(session) {
  if (session.replayChunks.length === 0) return null;
  if (session.replayChunks.length === 1) return session.replayChunks[0];
  const combined = Buffer.concat(session.replayChunks);
  session.replayChunks = [combined];
  session.replaySize = combined.length;
  return combined;
}

function resolveNextPoll(session) {
  while (session.pollWaiters.length > 0 && session.messageQueue.length > 0) {
    const { res, timer } = session.pollWaiters.shift();
    clearTimeout(timer);
    const msg = session.messageQueue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  }
}

// ── Helpers: broadcast (per-session) ──
function broadcast(clientSet, data) {
  const msg = typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data;
  for (const ws of clientSet) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ws may be closing */ }
    }
  }
}

// ── Socket discovery ──
function discoverAndConnect() {
  const found = discoverSessions();

  // Connect to newly discovered wrappers
  for (const [pid, ipcPath] of found) {
    if (!sessions.has(pid)) {
      const session = createSession(pid, ipcPath);
      sessions.set(pid, session);
      connectToWrapper(session);
    }
  }

  // Remove disconnected sessions whose wrappers are gone
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
      process.stderr.write(`Removed stale session PID ${pid}.\n`);
    }
  }
}

// ── Connect to wrapper Unix socket ──
function connectToWrapper(session) {
  // Try to read auth token from .token file
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
    broadcast(session.terminalClients,{ type: 'wrapper_status', connected: true });
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
    broadcast(session.terminalClients,{ type: 'wrapper_status', connected: false });
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
    case 'hello':
      session.wrapperInfo = {
        cwd: msg.cwd || process.cwd(),
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        pid: msg.pid || session.pid,
        cmd: msg.cmd || '',
        startedAt: msg.startedAt || null,
        label: session.wrapperInfo.label || msg.label || null,
      };
      if (msg.token && !session.wrapperToken) {
        session.wrapperToken = msg.token;
      }
      broadcast(session.terminalClients,{ type: 'resize', cols: session.wrapperInfo.cols, rows: session.wrapperInfo.rows });
      break;

    case 'scrollback':
    case 'output': {
      const buf = Buffer.from(msg.data, 'base64');
      trackTerminalState(session, buf);
      appendReplayBuffer(session, buf);
      broadcast(session.terminalClients,buf);
      break;
    }

    case 'resize':
      session.wrapperInfo.cols = msg.cols;
      session.wrapperInfo.rows = msg.rows;
      broadcast(session.terminalClients,{ type: 'resize', cols: msg.cols, rows: msg.rows });
      break;

    case 'exit':
      broadcast(session.terminalClients,{ type: 'wrapper_status', connected: false, exitCode: msg.exitCode });
      break;
  }
}

// ── Send input to wrapper via socket ──
function sendToWrapper(session, obj) {
  if (session.socket && session.connected) {
    try {
      session.socket.write(JSON.stringify(obj) + '\n');
    } catch { /* socket may be closing */ }
  }
}

// ── Session lookup helper ──
function getSessionFromQuery(url) {
  const pidStr = url.searchParams.get('session');
  if (!pidStr) return null;
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) return null;
  return sessions.get(pid) || null;
}

function requireSession(url, res) {
  const session = getSessionFromQuery(url);
  if (!session) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid session parameter' }));
  }
  return session;
}

// ── HTTP server ──
const publicDir = path.join(__dirname, 'public');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      totalBytes += c.length;
      if (totalBytes > MAX_BODY_BYTES) {
        settled = true;
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// ── Auth helpers (HTTP Basic Auth) ──
function checkBasicAuth(req) {
  if (!authEnabled) return true;
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Basic ')) return false;
  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const user = decoded.substring(0, sep);
  const pass = decoded.substring(sep + 1);
  const userMatch = user.length === authUsername.length &&
    crypto.timingSafeEqual(Buffer.from(user), Buffer.from(authUsername));
  const passMatch = pass.length === authPassword.length &&
    crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(authPassword));
  return userMatch && passMatch;
}

function rejectUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Basic realm="Terminal Mirror"',
  });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  const requestOrigin = req.headers.origin || '';
  const allowedOrigin = remoteMode
    ? (requestOrigin || '*')
    : `http://localhost:${serverPort}`;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth gate: Basic Auth for all /api/ routes and static files
  if (authEnabled && !checkBasicAuth(req)) {
    rejectUnauthorized(res);
    return;
  }

  // Sessions list endpoint
  if (req.method === 'GET' && pathname === '/api/sessions') {
    const list = [];
    for (const [pid, session] of sessions) {
      list.push({
        pid,
        cmd: session.wrapperInfo.cmd,
        cwd: session.wrapperInfo.cwd,
        startedAt: session.wrapperInfo.startedAt,
        connected: session.connected,
        label: session.wrapperInfo.label || null,
      });
    }
    // Sort by startedAt descending (most recent first)
    list.sort((a, b) => {
      if (!a.startedAt && !b.startedAt) return 0;
      if (!a.startedAt) return 1;
      if (!b.startedAt) return -1;
      return new Date(b.startedAt) - new Date(a.startedAt);
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: list, spawnEnabled: spawnSession }));
    return;
  }

  // Rename session label
  if (req.method === 'POST' && pathname === '/api/sessions/label') {
    const session = requireSession(url, res);
    if (!session) return;
    try {
      const body = await readBody(req);
      const { label } = JSON.parse(body);
      const trimmed = typeof label === 'string' ? label.trim() : '';
      session.wrapperInfo.label = trimmed ? trimmed.substring(0, MAX_LABEL_LENGTH) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, label: session.wrapperInfo.label }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
    return;
  }

  // Status endpoint (session-aware)
  if (req.method === 'GET' && pathname === '/api/status') {
    const session = requireSession(url, res);
    if (!session) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cols: session.wrapperInfo.cols,
      rows: session.wrapperInfo.rows,
      pid: session.wrapperInfo.pid,
      wrapperConnected: session.connected,
      cmd: session.wrapperInfo.cmd,
    }));
    return;
  }

  // Submit comments + message (session-aware)
  if (req.method === 'POST' && pathname === '/api/submit') {
    const session = requireSession(url, res);
    if (!session) return;
    try {
      const body = await readBody(req);
      const { comments = [], message, batchId } = JSON.parse(body);

      const parts = [];
      for (const c of comments) {
        const ref = c.selectedText ? `[Re: "${c.selectedText.substring(0, MAX_SELECTED_TEXT)}"] ` : '';
        parts.push(`${ref}${c.comment}`);
      }
      if (message) parts.push(message);
      const text = parts.join('\n\n');

      if (text) {
        const entry = { text, at: new Date().toISOString() };
        if (session.messageQueue.length >= MAX_MESSAGE_QUEUE) session.messageQueue.shift();
        session.messageQueue.push(entry);
        resolveNextPoll(session);

        if (comments.length > 0) {
          const batch = comments.map(c => ({ ...c, submittedAt: entry.at }));
          broadcast(session.commentClients,{ type: 'comments', comments: batch, batchId: batchId || null });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid request' }));
    }
    return;
  }

  // Long-poll: wait for next message (session-aware)
  if (req.method === 'GET' && pathname === '/api/poll') {
    const session = requireSession(url, res);
    if (!session) return;
    if (session.messageQueue.length > 0) {
      const msg = session.messageQueue.shift();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(msg));
      return;
    }

    const timer = setTimeout(() => {
      const idx = session.pollWaiters.findIndex(w => w.res === res);
      if (idx !== -1) session.pollWaiters.splice(idx, 1);
      res.writeHead(204);
      res.end();
    }, POLL_TIMEOUT_MS);

    session.pollWaiters.push({ res, timer });
    req.on('close', () => {
      clearTimeout(timer);
      const idx = session.pollWaiters.findIndex(w => w.res === res);
      if (idx !== -1) session.pollWaiters.splice(idx, 1);
    });
    return;
  }

  // Get all pending messages (session-aware)
  if (req.method === 'GET' && pathname === '/api/messages') {
    const session = requireSession(url, res);
    if (!session) return;
    const messages = session.messageQueue.splice(0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages }));
    return;
  }

  // Spawn new terminal session
  if (req.method === 'POST' && pathname === '/api/spawn') {
    if (!spawnSession) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Spawn not enabled. Start server with --spawn option.' }));
      return;
    }
    const spawnCommand = config.spawnCommand;
    if (!spawnCommand) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'spawnCommand not configured. Set "spawnCommand" in ~/.config/terminal-mirror/config.json' }));
      return;
    }
    const spawnArgs = Array.isArray(spawnCommand) ? spawnCommand : spawnCommand.split(/\s+/);
    const wrapperScript = path.join(__dirname, 'tm-wrapper.js');
    const colsArgs = config.spawnDefaultCols ? ['--cols', String(config.spawnDefaultCols)] : [];
    const child = spawnChild(process.execPath, [wrapperScript, ...colsArgs, ...spawnArgs], {
      cwd: os.homedir(),
      stdio: 'ignore',
    });
    spawnedChildren.set(child.pid, child);
    child.on('exit', () => spawnedChildren.delete(child.pid));
    process.stderr.write(`Spawned terminal session (PID ${child.pid}): ${spawnArgs.join(' ')} in ${os.homedir()}\n`);
    // Wait briefly for wrapper to create its socket, then discover it
    setTimeout(() => discoverAndConnect(), 500);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, pid: child.pid }));
    return;
  }

  // Shutdown
  if (req.method === 'POST' && pathname === '/api/done') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    setTimeout(() => cleanup(0), 100);
    return;
  }

  // Serve static files from public directory
  if (req.method === 'GET') {
    const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.resolve(publicDir, requestedFile);

    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }

    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

// ── WebSocket server (noServer mode) ──
const wss = new WebSocket.WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin || '';
  if (!remoteMode && origin && origin !== `http://localhost:${serverPort}`) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const upgradeUrl = new URL(request.url, 'http://localhost');
  if (authEnabled && !checkBasicAuth(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Terminal Mirror"\r\n\r\n');
    socket.destroy();
    return;
  }

  const pathname = upgradeUrl.pathname;
  const pidStr = upgradeUrl.searchParams.get('session');
  const pid = pidStr ? parseInt(pidStr, 10) : null;
  const session = pid !== null ? sessions.get(pid) : null;

  if (!session) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  if (pathname === '/ws/terminal') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      session.terminalClients.add(ws);

      // Send current resize info
      ws.send(JSON.stringify({
        type: 'resize',
        cols: session.wrapperInfo.cols,
        rows: session.wrapperInfo.rows,
      }));

      // Send wrapper connection status
      ws.send(JSON.stringify({
        type: 'wrapper_status',
        connected: session.connected,
      }));

      // Restore terminal state (alt screen, cursor visibility) that may have
      // been pushed out of the replay buffer, then replay recent output.
      const statePrefix = getStateRestorationPrefix(session);
      if (statePrefix) ws.send(statePrefix);
      const replay = getReplayBuffer(session);
      if (replay) ws.send(replay);

      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'input' && data.data) {
            sendToWrapper(session, { type: 'input', data: data.data });
          } else if (data.type === 'resize' && data.cols > 0) {
            sendToWrapper(session, { type: 'resize', cols: data.cols, rows: session.wrapperInfo.rows });
          }
        } catch { /* ignore malformed WebSocket message */ }
      });

      ws.on('close', () => { session.terminalClients.delete(ws); });
      ws.on('error', () => { session.terminalClients.delete(ws); });
    });
  } else if (pathname === '/ws/comments') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      session.commentClients.add(ws);
      ws.on('close', () => { session.commentClients.delete(ws); });
      ws.on('error', () => { session.commentClients.delete(ws); });
    });
  } else {
    socket.destroy();
  }
});

// ── Port detection + start ──
function tryListen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function listenOnAvailablePort(server, startPort, maxAttempts = MAX_PORT_SCAN, host = '127.0.0.1') {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await tryListen(server, startPort + i, host);
      return startPort + i;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('No available port found');
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function openBrowser(url) {
  const isWSL = process.env.WSL_DISTRO_NAME || (os.release && os.release().includes('microsoft'));
  if (isWSL) {
    spawnChild('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    spawnChild('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    spawnChild('open', [url], { stdio: 'ignore' });
  } else if (process.platform === 'linux') {
    spawnChild('xdg-open', [url], { stdio: 'ignore' });
  }
}

// ── Cleanup ──
function cleanup(exitCode = 0) {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }

  // Terminate spawned child processes
  for (const [pid, child] of spawnedChildren) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  spawnedChildren.clear();

  const shutdownMsg = JSON.stringify({ type: 'shutdown' });

  for (const [, session] of sessions) {
    // Notify and close browser clients
    for (const ws of [...session.terminalClients, ...session.commentClients]) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(shutdownMsg);
        ws.close(1000, 'Mirror shutting down');
      } catch { /* closing */ }
    }

    // Flush waiting polls
    while (session.pollWaiters.length > 0) {
      const { res, timer } = session.pollWaiters.shift();
      clearTimeout(timer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ done: true }));
    }

    // Close wrapper socket
    if (session.socket) {
      try { session.socket.end(); } catch { /* closing */ }
    }
  }

  if (httpServer) {
    try { httpServer.close(); } catch { /* not listening */ }
  }

  setTimeout(() => process.exit(exitCode), 100);
}

process.on('SIGINT', () => { cleanup(130); });
process.on('SIGTERM', () => { cleanup(); });
if (process.platform === 'win32') {
  process.on('exit', () => { cleanup(); });
}

// ── Start ──
async function start() {
  const bindAddr = remoteMode ? '0.0.0.0' : '127.0.0.1';
  if (customPort) {
    await tryListen(httpServer, customPort, bindAddr);
    serverPort = customPort;
  } else {
    serverPort = await listenOnAvailablePort(httpServer, START_PORT, MAX_PORT_SCAN, bindAddr);
  }
  const host = remoteMode ? getLocalIP() : 'localhost';
  const url = `http://${host}:${serverPort}`;
  process.stderr.write(`PORT=${serverPort}\n`);
  if (!authEnabled) {
    process.stderr.write('\n\x1b[1;31m⚠ WARNING: Authentication is disabled.\n  Set "username" and "password" in ~/.config/terminal-mirror/config.json to enable.\x1b[0m\n\n');
  }
  if (remoteMode) {
    process.stderr.write('\n\x1b[1;33m⚠ WARNING: Remote mode enabled (--remote).\n  Server is bound to 0.0.0.0 — accessible from any device on the network.\x1b[0m\n\n');
  }
  process.stderr.write(`Terminal Mirror: ${url}\n`);
  await new Promise((resolve) => {
    qrTerminal.generate(url, { small: true }, (qr) => {
      process.stderr.write(qr + '\n');
      resolve();
    });
  });

  // Initial scan + connect to all active wrappers
  discoverAndConnect();

  // Periodic re-scan for new wrappers
  scanTimer = setInterval(discoverAndConnect, SESSION_SCAN_INTERVAL_MS);

  if (sessions.size === 0) {
    process.stderr.write('No active tm-wrapper sessions found. Waiting for sessions...\n');
  } else {
    process.stderr.write(`Found ${sessions.size} active session(s).\n`);
  }

  // Open browser
  if (openBrowserFlag) {
    openBrowser(url);
  }
}

start().catch(err => { console.error(err); process.exit(1); });
