const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn: spawnChild } = require('child_process');
const { resolveNextPoll, broadcast, getReplayBuffer, getStateRestorationPrefix, getStateCorrectionSuffix } = require('./session');
const { sendToWrapper, discoverAndConnect } = require('./wrapper-connection');
const { setLabel, removeLabel } = require('./session-labels');

const POLL_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1 * 1024 * 1024;
const MAX_SELECTED_TEXT = 80;
const MAX_MESSAGE_QUEUE = 100;
const MAX_LABEL_LENGTH = 50;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

const publicDir = path.join(__dirname, '..', 'public');

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

function getSessionFromQuery(url, sessions) {
  const pidStr = url.searchParams.get('session');
  if (!pidStr) return null;
  const pid = parseInt(pidStr, 10);
  if (isNaN(pid)) return null;
  return sessions.get(pid) || null;
}

function requireSession(url, res, sessions) {
  const session = getSessionFromQuery(url, sessions);
  if (!session) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid session parameter' }));
  }
  return session;
}

function setupRoutes(httpServer, { sessions, config, spawnSession, spawnDetached, spawnedChildren, auth, remoteMode, getServerPort, cleanup, WebSocket, wss }) {
  httpServer.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    const requestOrigin = req.headers.origin || '';
    const serverPort = getServerPort();
    const allowedOrigin = remoteMode
      ? (requestOrigin || '*')
      : `http://localhost:${serverPort}`;
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (auth.authEnabled && !auth.checkBasicAuth(req)) {
      auth.rejectUnauthorized(res);
      return;
    }

    // Sessions list
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
      const session = requireSession(url, res, sessions);
      if (!session) return;
      try {
        const body = await readBody(req);
        const { label } = JSON.parse(body);
        const trimmed = typeof label === 'string' ? label.trim() : '';
        session.wrapperInfo.label = trimmed ? trimmed.substring(0, MAX_LABEL_LENGTH) : null;
        const { pid, startedAt, cmd } = session.wrapperInfo;
        if (session.wrapperInfo.label) {
          setLabel(pid, startedAt, cmd, session.wrapperInfo.label);
        } else {
          removeLabel(pid, startedAt);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, label: session.wrapperInfo.label }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
      return;
    }

    // Status
    if (req.method === 'GET' && pathname === '/api/status') {
      const session = requireSession(url, res, sessions);
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

    // Submit comments + message
    if (req.method === 'POST' && pathname === '/api/submit') {
      const session = requireSession(url, res, sessions);
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
            broadcast(session.commentClients, { type: 'comments', comments: batch, batchId: batchId || null });
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

    // Long-poll
    if (req.method === 'GET' && pathname === '/api/poll') {
      const session = requireSession(url, res, sessions);
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

    // Get all pending messages
    if (req.method === 'GET' && pathname === '/api/messages') {
      const session = requireSession(url, res, sessions);
      if (!session) return;
      const messages = session.messageQueue.splice(0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
      return;
    }

    // Spawn new session
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
      const wrapperScript = path.join(__dirname, '..', 'tm-wrapper.js');
      const colsArgs = config.spawnDefaultCols ? ['--cols', String(config.spawnDefaultCols)] : [];
      const child = spawnChild(process.execPath, [wrapperScript, ...colsArgs, ...spawnArgs], {
        cwd: os.homedir(),
        stdio: 'ignore',
        detached: spawnDetached,
      });
      if (spawnDetached) {
        child.unref();
      } else {
        spawnedChildren.set(child.pid, child);
        child.on('exit', () => spawnedChildren.delete(child.pid));
      }
      process.stderr.write(`Spawned terminal session (PID ${child.pid}): ${spawnArgs.join(' ')} in ${os.homedir()}\n`);
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

    // Static files
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

  // WebSocket upgrade
  httpServer.on('upgrade', (request, socket, head) => {
    const origin = request.headers.origin || '';
    const serverPort = getServerPort();
    if (!remoteMode && origin && origin !== `http://localhost:${serverPort}`) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const upgradeUrl = new URL(request.url, 'http://localhost');
    if (auth.authEnabled && !auth.checkBasicAuth(request)) {
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

        ws.send(JSON.stringify({
          type: 'resize',
          cols: session.wrapperInfo.cols,
          rows: session.wrapperInfo.rows,
        }));

        ws.send(JSON.stringify({
          type: 'wrapper_status',
          connected: session.connected,
        }));

        const statePrefix = getStateRestorationPrefix(session);
        if (statePrefix) ws.send(statePrefix);
        const replay = getReplayBuffer(session);
        if (replay) ws.send(replay);
        ws.send(getStateCorrectionSuffix(session));

        ws.on('message', (msg) => {
          try {
            const data = JSON.parse(msg.toString());
            if (data.type === 'input' && data.data) {
              sendToWrapper(session, { type: 'input', data: data.data });
            } else if (data.type === 'resize' && data.cols > 0 && data.rows > 0) {
              sendToWrapper(session, { type: 'resize', cols: data.cols, rows: data.rows });
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
}

module.exports = { setupRoutes };
