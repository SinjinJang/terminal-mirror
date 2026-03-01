#!/usr/bin/env node

// mirror-server.js — Multi-session web mirror server.
// Connects to multiple tm-wrapper Unix sockets and serves a web UI
// with session switching for terminal mirroring.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn: spawnChild } = require('child_process');
const os = require('os');
const crypto = require('crypto');

// ── Constants ──
const START_PORT = 3456;
const MAX_PORT_SCAN = 100;
const POLL_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;
const MAX_SELECTED_TEXT = 80;
const MAX_MESSAGE_QUEUE = 100;
const SOCKET_RECONNECT_MS = 3000;
const SOCKET_RECONNECT_MAX = 10;
const SESSION_SCAN_INTERVAL_MS = 5000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

// ── Parse CLI args ──
const rawArgs = process.argv.slice(2);
let noOpen = false;
let remoteMode = false;

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--no-open') {
    noOpen = true;
  } else if (rawArgs[i] === '--remote') {
    remoteMode = true;
  }
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

// ── State ──
const sessions = new Map(); // keyed by wrapper PID
let serverPort = null;
const masterToken = crypto.randomBytes(24).toString('hex');
let scanTimer = null;

function createSession(pid, sockPath) {
  return {
    pid,
    sockPath,
    socket: null,
    connected: false,
    wrapperInfo: { cwd: process.cwd(), cols: 80, rows: 24, pid, cmd: '', startedAt: null },
    wrapperToken: null,
    lineBuf: '',
    reconnects: 0,
    terminalClients: new Set(),
    commentClients: new Set(),
    messageQueue: [],
    pollWaiters: [],
  };
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
function broadcastTerminalJSON(session, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of session.terminalClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ws may be closing */ }
    }
  }
}

function broadcastTerminalBinary(session, buf) {
  for (const ws of session.terminalClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(buf); } catch { /* ws may be closing */ }
    }
  }
}

function broadcastCommentJSON(session, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of session.commentClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ws may be closing */ }
    }
  }
}

// ── Socket discovery ──
function scanForWrappers() {
  const tmpDir = os.tmpdir();
  const found = new Map(); // pid -> sockPath
  try {
    for (const entry of fs.readdirSync(tmpDir)) {
      if (entry.startsWith('tm-') && entry.endsWith('.sock')) {
        const sockPath = path.join(tmpDir, entry);
        const pidStr = entry.slice(3, -5);
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) continue;

        try {
          process.kill(pid, 0); // Check if process exists
          found.set(pid, sockPath);
        } catch {
          // Process dead — stale socket, clean up
          try { fs.unlinkSync(sockPath); } catch { /* already removed */ }
        }
      }
    }
  } catch { /* tmpdir read error */ }
  return found;
}

function discoverAndConnect() {
  const found = scanForWrappers();

  // Connect to newly discovered wrappers
  for (const [pid, sockPath] of found) {
    if (!sessions.has(pid)) {
      const session = createSession(pid, sockPath);
      sessions.set(pid, session);
      connectToWrapper(session);
    }
  }

  // Mark disconnected sessions whose sockets are gone
  for (const [pid, session] of sessions) {
    if (!found.has(pid) && session.connected) {
      // Wrapper is gone, socket will close on its own
    }
  }
}

// ── Connect to wrapper Unix socket ──
function connectToWrapper(session) {
  // Try to read auth token from .token file
  if (!session.wrapperToken && session.sockPath) {
    const tokenFilePath = session.sockPath.replace(/\.sock$/, '.token');
    try {
      session.wrapperToken = fs.readFileSync(tokenFilePath, 'utf-8').trim();
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
    broadcastTerminalJSON(session, { type: 'wrapper_status', connected: true });
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

  sock.on('close', () => {
    session.connected = false;
    session.socket = null;
    broadcastTerminalJSON(session, { type: 'wrapper_status', connected: false });
    process.stderr.write(`Disconnected from wrapper PID ${session.pid}.\n`);

    // Attempt reconnect if socket file still exists
    if (session.reconnects < SOCKET_RECONNECT_MAX) {
      try {
        fs.accessSync(session.sockPath);
        session.reconnects++;
        setTimeout(() => connectToWrapper(session), SOCKET_RECONNECT_MS);
      } catch {
        // Socket file gone — wrapper exited, don't reconnect
      }
    }
  });

  sock.on('error', (err) => {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      session.connected = false;
      session.socket = null;
      if (session.reconnects < SOCKET_RECONNECT_MAX) {
        try {
          fs.accessSync(session.sockPath);
          session.reconnects++;
          setTimeout(() => connectToWrapper(session), SOCKET_RECONNECT_MS);
        } catch {
          // Socket file gone
        }
      }
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
      };
      if (msg.token && !session.wrapperToken) {
        session.wrapperToken = msg.token;
      }
      broadcastTerminalJSON(session, { type: 'resize', cols: session.wrapperInfo.cols, rows: session.wrapperInfo.rows });
      break;

    case 'scrollback': {
      const buf = Buffer.from(msg.data, 'base64');
      broadcastTerminalBinary(session, buf);
      break;
    }

    case 'output': {
      const buf = Buffer.from(msg.data, 'base64');
      broadcastTerminalBinary(session, buf);
      break;
    }

    case 'resize':
      session.wrapperInfo.cols = msg.cols;
      session.wrapperInfo.rows = msg.rows;
      broadcastTerminalJSON(session, { type: 'resize', cols: msg.cols, rows: msg.rows });
      break;

    case 'exit':
      broadcastTerminalJSON(session, { type: 'wrapper_status', connected: false, exitCode: msg.exitCode });
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

// ── Auth helpers ──
function isValidToken(candidate) {
  if (!candidate || candidate.length !== masterToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(masterToken));
}

function extractToken(req) {
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') || '';
}

function rejectUnauthorized(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
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

  // Token validation gate for /api/ routes
  if (pathname.startsWith('/api/')) {
    if (!isValidToken(extractToken(req))) {
      rejectUnauthorized(res);
      return;
    }
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
    res.end(JSON.stringify(list));
    return;
  }

  // Status endpoint (session-aware)
  if (req.method === 'GET' && pathname === '/api/status') {
    const session = getSessionFromQuery(url);
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid session parameter' }));
      return;
    }
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
    const session = getSessionFromQuery(url);
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid session parameter' }));
      return;
    }
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
          broadcastCommentJSON(session, { type: 'comments', comments: batch, batchId: batchId || null });
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
    const session = getSessionFromQuery(url);
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid session parameter' }));
      return;
    }
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
    const session = getSessionFromQuery(url);
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid session parameter' }));
      return;
    }
    const messages = session.messageQueue.splice(0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages }));
    return;
  }

  // Shutdown
  if (req.method === 'POST' && pathname === '/api/done') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    setTimeout(() => cleanup(0), 100);
    return;
  }

  // File viewer endpoint (session-aware)
  if (req.method === 'GET' && pathname === '/api/file') {
    const session = getSessionFromQuery(url);
    const cwd = session ? session.wrapperInfo.cwd : process.cwd();
    let filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }
    if (filePath.startsWith('~/')) {
      filePath = path.join(os.homedir(), filePath.slice(2));
    }
    const resolved = path.resolve(cwd, filePath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not a file' }));
        return;
      }
      if (stat.size > MAX_FILE_READ_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large (>2MB)' }));
        return;
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      const relativePath = path.relative(cwd, resolved);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: resolved, relativePath, content }));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
    }
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
  const wsToken = upgradeUrl.searchParams.get('token') || '';
  if (!isValidToken(wsToken)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
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

      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'input' && data.data) {
            sendToWrapper(session, { type: 'input', data: data.data });
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
  } else if (os.platform() === 'darwin') {
    spawnChild('open', [url], { stdio: 'ignore' });
  } else if (os.platform() === 'linux') {
    spawnChild('xdg-open', [url], { stdio: 'ignore' });
  }
}

// ── Cleanup ──
function cleanup(exitCode = 0) {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }

  const shutdownMsg = JSON.stringify({ type: 'shutdown' });

  for (const [, session] of sessions) {
    // Notify browser clients
    for (const ws of session.terminalClients) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(shutdownMsg); } catch { /* closing */ }
    }
    for (const ws of session.commentClients) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(shutdownMsg); } catch { /* closing */ }
    }
    for (const ws of session.terminalClients) {
      try { ws.close(1000, 'Mirror shutting down'); } catch { /* closed */ }
    }
    for (const ws of session.commentClients) {
      try { ws.close(1000, 'Mirror shutting down'); } catch { /* closed */ }
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

// ── Start ──
async function start() {
  const bindAddr = remoteMode ? '0.0.0.0' : '127.0.0.1';
  serverPort = await listenOnAvailablePort(httpServer, START_PORT, MAX_PORT_SCAN, bindAddr);
  const tokenQuery = `?token=${masterToken}`;
  const host = remoteMode ? getLocalIP() : 'localhost';
  const url = `http://${host}:${serverPort}${tokenQuery}`;
  process.stderr.write(`PORT=${serverPort}\n`);
  process.stderr.write(`TOKEN=${masterToken}\n`);
  process.stderr.write(`Terminal Mirror: ${url}\n`);

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
  if (!noOpen) {
    openBrowser(url);
  }
}

start().catch(err => { console.error(err); process.exit(1); });
