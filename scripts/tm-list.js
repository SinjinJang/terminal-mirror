#!/usr/bin/env node

// tm-list.js — List active tm-wrapper sessions by scanning /tmp/tm-*.sock

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = os.tmpdir();
const entries = [];
const stale = [];

// Scan for socket files
let files;
try {
  files = fs.readdirSync(tmpDir).filter(f => f.startsWith('tm-') && f.endsWith('.sock'));
} catch {
  console.error('Cannot read tmp directory');
  process.exit(1);
}

if (files.length === 0) {
  console.log('No active tm-wrapper sessions.');
  process.exit(0);
}

// Probe each socket to get session info
let pending = files.length;

function done() {
  if (--pending > 0) return;

  // Clean stale sockets
  for (const s of stale) {
    try { fs.unlinkSync(s); } catch { /* already removed */ }
  }

  if (entries.length === 0) {
    console.log('No active tm-wrapper sessions.');
    if (stale.length > 0) {
      console.log(`Cleaned ${stale.length} stale socket(s).`);
    }
    return;
  }

  // Print table
  const pidW = 8;
  const cmdW = 30;
  const cwdW = 35;
  const startedW = 20;

  console.log(
    'PID'.padEnd(pidW) +
    'CMD'.padEnd(cmdW) +
    'CWD'.padEnd(cwdW) +
    'STARTED'
  );
  console.log('-'.repeat(pidW + cmdW + cwdW + startedW));

  for (const e of entries) {
    const pid = String(e.pid).padEnd(pidW);
    const cmd = (e.cmd || '').substring(0, cmdW - 2).padEnd(cmdW);
    const cwd = (e.cwd || '').substring(0, cwdW - 2).padEnd(cwdW);
    const started = e.startedAt ? new Date(e.startedAt).toLocaleString() : 'unknown';
    console.log(pid + cmd + cwd + started);
  }

  if (stale.length > 0) {
    console.log(`\nCleaned ${stale.length} stale socket(s).`);
  }
}

for (const file of files) {
  const sockPath = path.join(tmpDir, file);
  const pidStr = file.slice(3, -5);
  const pid = parseInt(pidStr, 10);

  // Check if process is alive
  if (isNaN(pid)) {
    stale.push(sockPath);
    done();
    continue;
  }

  try {
    process.kill(pid, 0);
  } catch {
    stale.push(sockPath);
    done();
    continue;
  }

  // Connect to get session info
  const client = net.createConnection(sockPath);
  let lineBuf = '';
  let resolved = false;
  const timeout = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      entries.push({ pid, cmd: '(no response)', cwd: '?', startedAt: null });
      try { client.end(); } catch { /* closing */ }
      done();
    }
  }, 2000);

  client.on('data', (chunk) => {
    if (resolved) return;
    lineBuf += chunk.toString();
    let idx;
    while ((idx = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.substring(0, idx);
      lineBuf = lineBuf.substring(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'hello') {
          resolved = true;
          clearTimeout(timeout);
          entries.push({
            pid: msg.pid || pid,
            cmd: msg.cmd || '',
            cwd: msg.cwd || '',
            startedAt: msg.startedAt || null,
          });
          try { client.end(); } catch { /* closing */ }
          done();
          return;
        }
      } catch { /* ignore */ }
    }
  });

  client.on('error', () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timeout);
      stale.push(sockPath);
      done();
    }
  });

  client.on('close', () => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timeout);
      done();
    }
  });
}
