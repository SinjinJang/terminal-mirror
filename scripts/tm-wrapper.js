#!/usr/bin/env node

// tm-wrapper.js — Universal PTY wrapper with Unix domain socket for mirror attachment.
// Runs any command in a PTY, exposes output via /tmp/tm-<pid>.sock for mirror-server.js.

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ──
const RING_BUFFER_SIZE = 1 * 1024 * 1024; // 1 MB scrollback ring buffer
const CLEANUP_EXIT_DELAY_MS = 100;
const SIGINT_FORCE_CLEANUP_MS = 3000;

// ── Parse CLI args ──
const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0) {
  process.stderr.write('Usage: tm <command> [args...]\n');
  process.stderr.write('Examples:\n');
  process.stderr.write('  tm claude --model sonnet\n');
  process.stderr.write('  tm bash\n');
  process.stderr.write('  tm vim file.txt\n');
  process.exit(1);
}

// ── Dependency: node-pty ──
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  const pluginDir = path.resolve(__dirname, '..');
  process.stderr.write(`node-pty not installed. Run: cd ${pluginDir} && npm install\n`);
  process.exit(1);
}

// ── Determine command to run ──
const command = rawArgs[0];
const commandArgs = rawArgs.slice(1);

// ── Terminal dimensions ──
const cols = process.stdout.columns || 80;
const rows = process.stdout.rows || 24;

// ── Ring buffer for scrollback history ──
class RingBuffer {
  constructor(capacity) {
    this.buf = Buffer.alloc(capacity);
    this.capacity = capacity;
    this.writePos = 0;
    this.totalWritten = 0;
  }

  write(data) {
    const src = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
    if (src.length >= this.capacity) {
      // Data larger than buffer: keep only the tail
      src.copy(this.buf, 0, src.length - this.capacity);
      this.writePos = 0;
      this.totalWritten += src.length;
    } else if (this.writePos + src.length <= this.capacity) {
      src.copy(this.buf, this.writePos);
      this.writePos += src.length;
      this.totalWritten += src.length;
    } else {
      // Wrap around
      const firstPart = this.capacity - this.writePos;
      src.copy(this.buf, this.writePos, 0, firstPart);
      src.copy(this.buf, 0, firstPart);
      this.writePos = src.length - firstPart;
      this.totalWritten += src.length;
    }
  }

  getContents() {
    if (this.totalWritten <= this.capacity) {
      return this.buf.subarray(0, this.writePos);
    }
    // Buffer has wrapped: return from writePos to end, then start to writePos
    return Buffer.concat([
      this.buf.subarray(this.writePos),
      this.buf.subarray(0, this.writePos),
    ]);
  }
}

const ringBuffer = new RingBuffer(RING_BUFFER_SIZE);

// ── State ──
let ptyProcess = null;
let socketServer = null;
let socketPath = null;
const socketClients = new Set();
const startedAt = new Date().toISOString();

// ── PTY environment ──
const ptyEnv = { ...process.env, TERM: 'xterm-256color' };
// Remove Claude Code session vars to allow nested claude invocation
delete ptyEnv.CLAUDE_CODE;
delete ptyEnv.CLAUDECODE;
delete ptyEnv.CLAUDE_CODE_SESSION;
delete ptyEnv.CLAUDE_CODE_ENTRYPOINT;

// ── Send JSON message to a socket client (newline-delimited) ──
function sendToClient(client, obj) {
  try {
    client.write(JSON.stringify(obj) + '\n');
  } catch { /* client may be closing */ }
}

// ── Broadcast to all connected mirror clients ──
function broadcastToMirrors(obj) {
  const msg = JSON.stringify(obj) + '\n';
  for (const client of socketClients) {
    try { client.write(msg); } catch { /* client may be closing */ }
  }
}

// ── Spawn PTY ──
function spawnPty() {
  ptyProcess = pty.spawn(command, commandArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: ptyEnv,
  });

  // Set TM_SOCKET env var (available to child processes via /proc or conventions)
  // We'll set this after socket is created

  // PTY output → local terminal + ring buffer + mirror clients
  ptyProcess.onData((data) => {
    process.stdout.write(data);

    // Store in ring buffer
    ringBuffer.write(data);

    // Broadcast to connected mirror clients
    const b64 = Buffer.from(data, 'utf-8').toString('base64');
    broadcastToMirrors({ type: 'output', data: b64 });
  });

  // PTY exit → cleanup
  ptyProcess.onExit(({ exitCode }) => {
    broadcastToMirrors({ type: 'exit', exitCode });
    cleanup(exitCode);
  });
}

// ── Local stdin → PTY ──
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.on('data', (data) => {
  if (ptyProcess) ptyProcess.write(data.toString());
});

// ── Terminal resize → PTY + mirror clients ──
process.stdout.on('resize', () => {
  const newCols = process.stdout.columns;
  const newRows = process.stdout.rows;
  if (ptyProcess) ptyProcess.resize(newCols, newRows);
  broadcastToMirrors({ type: 'resize', cols: newCols, rows: newRows });
});

// ── Unix domain socket server ──
function startSocketServer() {
  socketPath = path.join(os.tmpdir(), `tm-${process.pid}.sock`);

  // Clean stale socket if exists
  try { fs.unlinkSync(socketPath); } catch { /* doesn't exist */ }

  socketServer = net.createServer((client) => {
    socketClients.add(client);

    // Send hello with session info
    sendToClient(client, {
      type: 'hello',
      cwd: process.cwd(),
      cols: ptyProcess ? ptyProcess.cols : cols,
      rows: ptyProcess ? ptyProcess.rows : rows,
      pid: process.pid,
      cmd: [command, ...commandArgs].join(' '),
      startedAt,
    });

    // Send scrollback history
    const scrollback = ringBuffer.getContents();
    if (scrollback.length > 0) {
      sendToClient(client, {
        type: 'scrollback',
        data: scrollback.toString('base64'),
      });
    }

    // Handle incoming data (newline-delimited JSON)
    let lineBuf = '';
    client.on('data', (chunk) => {
      lineBuf += chunk.toString();
      let newlineIdx;
      while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.substring(0, newlineIdx);
        lineBuf = lineBuf.substring(newlineIdx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          handleClientMessage(msg);
        } catch { /* ignore malformed JSON */ }
      }
    });

    client.on('close', () => { socketClients.delete(client); });
    client.on('error', () => { socketClients.delete(client); });
  });

  socketServer.listen(socketPath, () => {
    // Set environment variable for child discovery
    process.env.TM_SOCKET = socketPath;
    ptyEnv.TM_SOCKET = socketPath;

    process.stderr.write(`TM_SOCKET=${socketPath}\n`);
  });

  socketServer.on('error', (err) => {
    process.stderr.write(`Socket server error: ${err.message}\n`);
  });
}

function handleClientMessage(msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'input':
      if (msg.data && ptyProcess) {
        ptyProcess.write(msg.data);
      }
      break;
    case 'resize':
      // Mirror can request resize (optional, wrapper owns the real terminal size)
      break;
  }
}

// ── Cleanup ──
let cleaningUp = false;
function cleanup(exitCode = 0) {
  if (cleaningUp) return;
  cleaningUp = true;

  // Close all socket clients
  for (const client of socketClients) {
    try { client.end(); } catch { /* already closed */ }
  }

  // Close socket server
  if (socketServer) {
    try { socketServer.close(); } catch { /* already closed */ }
  }

  // Remove socket file
  if (socketPath) {
    try { fs.unlinkSync(socketPath); } catch { /* already removed */ }
  }

  // Restore terminal
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* stdin may be destroyed */ }
  }
  process.stdin.pause();

  setTimeout(() => process.exit(exitCode), CLEANUP_EXIT_DELAY_MS);
}

process.on('SIGINT', () => {
  if (ptyProcess) {
    ptyProcess.kill('SIGINT');
    setTimeout(() => {
      if (!cleaningUp) cleanup(130);
    }, SIGINT_FORCE_CLEANUP_MS);
  } else {
    cleanup(130);
  }
});

process.on('SIGTERM', () => { cleanup(); });

// ── Start ──
startSocketServer();
spawnPty();
