#!/usr/bin/env node

// mirror-server.js — Detachable web mirror server.
// Connects to a tm-wrapper Unix socket and serves a web UI for terminal mirroring.
// Can be attached/detached at any time without affecting the wrapped program.

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn: spawnChild } = require('child_process');
const os = require('os');

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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

// ── Parse CLI args ──
const rawArgs = process.argv.slice(2);
let explicitSocket = null;
let noOpen = false;

for (let i = 0; i < rawArgs.length; i++) {
  if ((rawArgs[i] === '-s' || rawArgs[i] === '--socket') && rawArgs[i + 1]) {
    explicitSocket = rawArgs[++i];
  } else if (rawArgs[i] === '--no-open') {
    noOpen = true;
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
let wrapperSocket = null;
let wrapperConnected = false;
let wrapperInfo = { cwd: process.cwd(), cols: 80, rows: 24, pid: null, cmd: '' };
let serverPort = null;
let socketReconnects = 0;
const terminalClients = new Set();
const commentClients = new Set();
const messageQueue = [];
const pollWaiters = [];

function resolveNextPoll() {
  while (pollWaiters.length > 0 && messageQueue.length > 0) {
    const { res, timer } = pollWaiters.shift();
    clearTimeout(timer);
    const msg = messageQueue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  }
}

// ── Helpers: broadcast ──
function broadcastTerminalJSON(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of terminalClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ws may be closing */ }
    }
  }
}

function broadcastTerminalBinary(buf) {
  for (const ws of terminalClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(buf); } catch { /* ws may be closing */ }
    }
  }
}

function broadcastCommentJSON(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of commentClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ws may be closing */ }
    }
  }
}

// ── Socket discovery ──
function findSocketPath() {
  // 1. Explicit socket path from CLI
  if (explicitSocket) return explicitSocket;

  // 2. TM_SOCKET environment variable
  if (process.env.TM_SOCKET) return process.env.TM_SOCKET;

  // 3. Scan /tmp/tm-*.sock for active sockets
  const tmpDir = os.tmpdir();
  const candidates = [];
  try {
    for (const entry of fs.readdirSync(tmpDir)) {
      if (entry.startsWith('tm-') && entry.endsWith('.sock')) {
        const sockPath = path.join(tmpDir, entry);
        // Extract PID and check if process is alive
        const pidStr = entry.slice(3, -5);
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) continue;

        try {
          process.kill(pid, 0); // Check if process exists
          candidates.push({ path: sockPath, pid, mtime: fs.statSync(sockPath).mtimeMs });
        } catch {
          // Process dead — stale socket, clean up
          try { fs.unlinkSync(sockPath); } catch { /* already removed */ }
        }
      }
    }
  } catch { /* tmpdir read error */ }

  if (candidates.length === 0) return null;

  // Return the most recently modified socket
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

// ── Connect to wrapper Unix socket ──
function connectToWrapper() {
  const sockPath = findSocketPath();
  if (!sockPath) {
    process.stderr.write('No active tm-wrapper session found.\n');
    process.stderr.write('Start one with: tm <command>\n');
    if (socketReconnects < SOCKET_RECONNECT_MAX) {
      socketReconnects++;
      process.stderr.write(`Retrying in ${SOCKET_RECONNECT_MS / 1000}s... (${socketReconnects}/${SOCKET_RECONNECT_MAX})\n`);
      setTimeout(connectToWrapper, SOCKET_RECONNECT_MS);
    } else {
      process.stderr.write('Max reconnect attempts reached. Exiting.\n');
      process.exit(1);
    }
    return;
  }

  process.stderr.write(`Connecting to wrapper: ${sockPath}\n`);

  wrapperSocket = net.createConnection(sockPath);
  let lineBuf = '';

  wrapperSocket.on('connect', () => {
    wrapperConnected = true;
    socketReconnects = 0;
    process.stderr.write('Connected to wrapper.\n');
    broadcastTerminalJSON({ type: 'wrapper_status', connected: true });
  });

  wrapperSocket.on('data', (chunk) => {
    lineBuf += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.substring(0, newlineIdx);
      lineBuf = lineBuf.substring(newlineIdx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleWrapperMessage(msg);
      } catch { /* ignore malformed JSON */ }
    }
  });

  wrapperSocket.on('close', () => {
    wrapperConnected = false;
    wrapperSocket = null;
    broadcastTerminalJSON({ type: 'wrapper_status', connected: false });
    process.stderr.write('Disconnected from wrapper.\n');

    // Attempt reconnect
    if (socketReconnects < SOCKET_RECONNECT_MAX) {
      socketReconnects++;
      setTimeout(connectToWrapper, SOCKET_RECONNECT_MS);
    }
  });

  wrapperSocket.on('error', (err) => {
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
      // Socket doesn't exist or wrapper is gone
      wrapperConnected = false;
      wrapperSocket = null;
      if (socketReconnects < SOCKET_RECONNECT_MAX) {
        socketReconnects++;
        setTimeout(connectToWrapper, SOCKET_RECONNECT_MS);
      }
    }
  });
}

function handleWrapperMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'hello':
      wrapperInfo = {
        cwd: msg.cwd || process.cwd(),
        cols: msg.cols || 80,
        rows: msg.rows || 24,
        pid: msg.pid || null,
        cmd: msg.cmd || '',
        startedAt: msg.startedAt || null,
      };
      // Send resize to browser clients
      broadcastTerminalJSON({ type: 'resize', cols: wrapperInfo.cols, rows: wrapperInfo.rows });
      break;

    case 'scrollback': {
      // Decode base64 and send as binary to terminal clients
      const buf = Buffer.from(msg.data, 'base64');
      broadcastTerminalBinary(buf);
      break;
    }

    case 'output': {
      // Decode base64 and send as binary to terminal clients
      const buf = Buffer.from(msg.data, 'base64');
      broadcastTerminalBinary(buf);
      break;
    }

    case 'resize':
      wrapperInfo.cols = msg.cols;
      wrapperInfo.rows = msg.rows;
      broadcastTerminalJSON({ type: 'resize', cols: msg.cols, rows: msg.rows });
      break;

    case 'exit':
      broadcastTerminalJSON({ type: 'wrapper_status', connected: false, exitCode: msg.exitCode });
      break;
  }
}

// ── Send input to wrapper via socket ──
function sendToWrapper(obj) {
  if (wrapperSocket && wrapperConnected) {
    try {
      wrapperSocket.write(JSON.stringify(obj) + '\n');
    } catch { /* socket may be closing */ }
  }
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

const httpServer = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  const allowedOrigin = `http://localhost:${serverPort}`;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Status endpoint
  if (req.method === 'GET' && pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cols: wrapperInfo.cols,
      rows: wrapperInfo.rows,
      pid: wrapperInfo.pid,
      wrapperConnected,
      cmd: wrapperInfo.cmd,
    }));
    return;
  }

  // Submit comments + message → inject to PTY via wrapper + queue for poll
  if (req.method === 'POST' && pathname === '/api/submit') {
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
        if (messageQueue.length >= MAX_MESSAGE_QUEUE) messageQueue.shift();
        messageQueue.push(entry);
        resolveNextPoll();

        if (comments.length > 0) {
          const batch = comments.map(c => ({ ...c, submittedAt: entry.at }));
          broadcastCommentJSON({ type: 'comments', comments: batch, batchId: batchId || null });
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

  // Long-poll: wait for next message
  if (req.method === 'GET' && pathname === '/api/poll') {
    if (messageQueue.length > 0) {
      const msg = messageQueue.shift();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(msg));
      return;
    }

    const timer = setTimeout(() => {
      const idx = pollWaiters.findIndex(w => w.res === res);
      if (idx !== -1) pollWaiters.splice(idx, 1);
      res.writeHead(204);
      res.end();
    }, POLL_TIMEOUT_MS);

    pollWaiters.push({ res, timer });
    req.on('close', () => {
      clearTimeout(timer);
      const idx = pollWaiters.findIndex(w => w.res === res);
      if (idx !== -1) pollWaiters.splice(idx, 1);
    });
    return;
  }

  // Get all pending messages (non-blocking)
  if (req.method === 'GET' && pathname === '/api/messages') {
    const messages = messageQueue.splice(0);
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

  // File viewer endpoint
  if (req.method === 'GET' && pathname === '/api/file') {
    const url = new URL(req.url, 'http://localhost');
    let filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing path parameter' }));
      return;
    }
    if (filePath.startsWith('~/')) {
      filePath = path.join(os.homedir(), filePath.slice(2));
    }
    // Resolve relative to wrapper's CWD
    const resolved = path.resolve(wrapperInfo.cwd, filePath);
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
      const relativePath = path.relative(wrapperInfo.cwd, resolved);
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
  if (origin && origin !== `http://localhost:${serverPort}`) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const pathname = new URL(request.url, 'http://localhost').pathname;

  if (pathname === '/ws/terminal') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      terminalClients.add(ws);

      // Send current resize info
      ws.send(JSON.stringify({
        type: 'resize',
        cols: wrapperInfo.cols,
        rows: wrapperInfo.rows,
      }));

      // Send wrapper connection status
      ws.send(JSON.stringify({
        type: 'wrapper_status',
        connected: wrapperConnected,
      }));

      ws.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.type === 'input' && data.data) {
            // Forward input to wrapper via Unix socket
            sendToWrapper({ type: 'input', data: data.data });
          }
        } catch { /* ignore malformed WebSocket message */ }
      });

      ws.on('close', () => { terminalClients.delete(ws); });
      ws.on('error', () => { terminalClients.delete(ws); });
    });
  } else if (pathname === '/ws/comments') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      commentClients.add(ws);
      ws.on('close', () => { commentClients.delete(ws); });
      ws.on('error', () => { commentClients.delete(ws); });
    });
  } else {
    socket.destroy();
  }
});

// ── Port detection + start ──
function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function listenOnAvailablePort(server, startPort, maxAttempts = MAX_PORT_SCAN) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await tryListen(server, startPort + i);
      return startPort + i;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('No available port found');
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
  // Notify browser clients
  const shutdownMsg = JSON.stringify({ type: 'shutdown' });
  for (const ws of terminalClients) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(shutdownMsg); } catch { /* closing */ }
  }
  for (const ws of commentClients) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(shutdownMsg); } catch { /* closing */ }
  }
  for (const ws of terminalClients) {
    try { ws.close(1000, 'Mirror shutting down'); } catch { /* closed */ }
  }
  for (const ws of commentClients) {
    try { ws.close(1000, 'Mirror shutting down'); } catch { /* closed */ }
  }

  // Flush waiting polls
  while (pollWaiters.length > 0) {
    const { res, timer } = pollWaiters.shift();
    clearTimeout(timer);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ done: true }));
  }

  // Close wrapper socket
  if (wrapperSocket) {
    try { wrapperSocket.end(); } catch { /* closing */ }
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
  serverPort = await listenOnAvailablePort(httpServer, START_PORT);
  const url = `http://localhost:${serverPort}`;
  process.stderr.write(`PORT=${serverPort}\n`);
  process.stderr.write(`Terminal Mirror: ${url}\n`);

  // Connect to wrapper
  connectToWrapper();

  // Open browser
  if (!noOpen) {
    openBrowser(url);
  }
}

start().catch(err => { console.error(err); process.exit(1); });
