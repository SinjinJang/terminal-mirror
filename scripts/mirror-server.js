#!/usr/bin/env node

// mirror-server.js — Multi-session web mirror server.
// Connects to multiple tm-wrapper Unix sockets and serves a web UI
// with session switching for terminal mirroring.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const qrTerminal = require('qrcode-terminal');
const { spawn: spawnChild } = require('child_process');

const { setWebSocket } = require('./server/session');
const { createAuth } = require('./server/auth');
const wrapperConnection = require('./server/wrapper-connection');
const { setupRoutes } = require('./server/routes');

// ── Constants ──
const START_PORT = 19000;
const MAX_PORT_SCAN = 100;
const SESSION_SCAN_INTERVAL_MS = 5000;

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
let spawnDetached = false;
let noAuth = false;

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--open') {
    openBrowserFlag = true;
  } else if (rawArgs[i] === '--remote') {
    remoteMode = true;
  } else if (rawArgs[i] === '--spawn') {
    spawnSession = true;
  } else if (rawArgs[i] === '--spawn-detached') {
    spawnDetached = true;
  } else if (rawArgs[i] === '--no-auth') {
    noAuth = true;
  } else if ((rawArgs[i] === '--port' || rawArgs[i] === '-p') && rawArgs[i + 1]) {
    customPort = parseInt(rawArgs[++i], 10);
    if (isNaN(customPort) || customPort < 1 || customPort > 65535) {
      process.stderr.write('Invalid port number. Must be 1-65535.\n');
      process.exit(1);
    }
  } else if (rawArgs[i] === '--spawn-default-cols' && rawArgs[i + 1]) {
    const v = parseInt(rawArgs[++i], 10);
    if (isNaN(v) || v < 1 || v > 400) {
      process.stderr.write('Invalid --spawn-default-cols. Must be 1-400.\n');
      process.exit(1);
    }
    config.spawnDefaultCols = v;
  } else if (rawArgs[i] === '--spawn-default-rows' && rawArgs[i + 1]) {
    const v = parseInt(rawArgs[++i], 10);
    if (isNaN(v) || v < 1 || v > 200) {
      process.stderr.write('Invalid --spawn-default-rows. Must be 1-200.\n');
      process.exit(1);
    }
    config.spawnDefaultRows = v;
  } else if (rawArgs[i] === '--font-size' && rawArgs[i + 1]) {
    const v = parseInt(rawArgs[++i], 10);
    if (isNaN(v) || v < 10 || v > 24) {
      process.stderr.write('Invalid --font-size. Must be 10-24.\n');
      process.exit(1);
    }
    config.fontSize = v;
  } else if (rawArgs[i] === '--line-height' && rawArgs[i + 1]) {
    const v = parseFloat(rawArgs[++i]);
    if (isNaN(v) || v < 1.0 || v > 2.0) {
      process.stderr.write('Invalid --line-height. Must be 1.0-2.0.\n');
      process.exit(1);
    }
    config.lineHeight = v;
  } else if (rawArgs[i] === '--scrollback' && rawArgs[i + 1]) {
    const v = parseInt(rawArgs[++i], 10);
    if (isNaN(v) || v < 1000 || v > 100000) {
      process.stderr.write('Invalid --scrollback. Must be 1000-100000.\n');
      process.exit(1);
    }
    config.scrollback = v;
  }
}

// Apply config file defaults for flags not set via CLI
if (!openBrowserFlag && config.open) openBrowserFlag = true;
if (!remoteMode && config.remote) remoteMode = true;
if (!spawnSession && config.spawn) spawnSession = true;
if (!spawnDetached && config.spawnDetached) spawnDetached = true;
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

// ── Auth ──
const auth = createAuth(config, noAuth);

if (!noAuth && !auth.authEnabled) {
  process.stderr.write('Error: Authentication required but no credentials configured.\n');
  process.stderr.write('Set "username" and "password" in ~/.config/terminal-mirror/config.json,\n');
  process.stderr.write('or use --no-auth to disable authentication.\n');
  process.exit(1);
}

// ── State ──
const sessions = new Map();
const spawnedChildren = new Map();
let serverPort = null;
let scanTimer = null;

// ── Initialize modules ──
setWebSocket(WebSocket);
wrapperConnection.init(sessions);

// ── HTTP + WebSocket server ──
const httpServer = http.createServer();
const wss = new WebSocket.WebSocketServer({ noServer: true });

setupRoutes(httpServer, {
  sessions,
  config,
  spawnSession,
  spawnDetached,
  spawnedChildren,
  auth,
  remoteMode,
  getServerPort: () => serverPort,
  cleanup,
  WebSocket,
  wss,
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

  for (const [pid] of spawnedChildren) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  spawnedChildren.clear();

  const shutdownMsg = JSON.stringify({ type: 'shutdown' });

  for (const [, session] of sessions) {
    for (const ws of [...session.terminalClients, ...session.commentClients]) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(shutdownMsg);
        ws.close(1000, 'Mirror shutting down');
      } catch { /* closing */ }
    }

    while (session.pollWaiters.length > 0) {
      const { res, timer } = session.pollWaiters.shift();
      clearTimeout(timer);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ done: true }));
    }

    if (session.socket) {
      try { session.socket.end(); } catch { /* closing */ }
    }
  }

  if (httpServer) {
    try { httpServer.close(); } catch { /* not listening */ }
  }

  setTimeout(() => process.exit(exitCode), 100);
}

let sigintReceived = false;
process.on('SIGINT', () => {
  if (sigintReceived) {
    cleanup(130);
    return;
  }
  sigintReceived = true;
  const rl = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  process.stdout.write('\n');
  rl.question('서버를 종료하시겠습니까? (y/N) ', (answer) => {
    rl.close();
    if (answer.toLowerCase() === 'y') {
      cleanup(130);
    } else {
      sigintReceived = false;
      process.stdout.write('서버를 계속 실행합니다.\n');
    }
  });
});
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
  if (!auth.authEnabled) {
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
  wrapperConnection.discoverAndConnect();

  // Periodic re-scan for new wrappers
  scanTimer = setInterval(() => wrapperConnection.discoverAndConnect(), SESSION_SCAN_INTERVAL_MS);

  if (sessions.size === 0) {
    process.stderr.write('No active tm-wrapper sessions found. Waiting for sessions...\n');
  } else {
    process.stderr.write(`Found ${sessions.size} active session(s).\n`);
  }

  if (openBrowserFlag) {
    openBrowser(url);
  }
}

start().catch(err => { console.error(err); process.exit(1); });
