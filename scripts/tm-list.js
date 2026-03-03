#!/usr/bin/env node

// tm-list.js — List active tm-wrapper sessions

const net = require('net');
const { discoverSessions } = require('./platform');

const found = discoverSessions(); // Map<pid, ipcPath>, stale already cleaned

if (found.size === 0) {
  console.log('No active tm-wrapper sessions.');
  process.exit(0);
}

// Probe each session to get info via hello message
const entries = [];
let pending = found.size;

function done() {
  if (--pending > 0) return;

  if (entries.length === 0) {
    console.log('No active tm-wrapper sessions.');
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
}

for (const [pid, ipcPath] of found) {
  const client = net.createConnection(ipcPath);
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
