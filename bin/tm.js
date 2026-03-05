#!/usr/bin/env node

// tm.js — Cross-platform CLI entrypoint for terminal-mirror.
//
// Usage:
//   tm <command> [args...]    Wrap a command in a PTY with mirror socket
//   tm start-server [opts]    Start multi-session mirror web server
//   tm list                   List active tm-wrapper sessions

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const SCRIPTS_DIR = path.join(PLUGIN_DIR, 'scripts');

// ── Auto-install dependencies ──
function ensureDeps() {
  if (!fs.existsSync(path.join(PLUGIN_DIR, 'node_modules'))) {
    process.stderr.write('Installing dependencies...\n');
    const result = require('child_process').spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install'],
      { cwd: PLUGIN_DIR, stdio: 'inherit' }
    );
    if (result.status !== 0) {
      process.stderr.write('Failed to install dependencies.\n');
      process.exit(1);
    }
  }
}

// ── Subcommand routing ──
const args = process.argv.slice(2);
const subcommand = args[0] || '';

if (subcommand === '-h' || subcommand === '--help' || subcommand === '') {
  process.stdout.write(
    'Usage:\n' +
    '  tm <command> [args...]    Wrap a command in a PTY with mirror socket\n' +
    '  tm start-server [opts]    Start multi-session mirror web server\n' +
    '  tm list                   List active tm-wrapper sessions\n' +
    '\n' +
    'Examples:\n' +
    '  tm claude --model sonnet  Wrap Claude with terminal mirror support\n' +
    '  tm bash                   Wrap bash\n' +
    '  tm vim file.txt           Wrap vim\n' +
    '  tm start-server           Start mirror server (auto-discovers all sessions)\n' +
    '  tm start-server --remote  Start mirror server accessible on LAN\n' +
    '  tm start-server -p 8080   Start mirror server on a specific port\n'
  );
  process.exit(0);
}

let script;
let scriptArgs;

switch (subcommand) {
  case 'start-server':
    script = path.join(SCRIPTS_DIR, 'mirror-server.js');
    scriptArgs = args.slice(1);
    break;
  case 'list':
    script = path.join(SCRIPTS_DIR, 'tm-list.js');
    scriptArgs = args.slice(1);
    break;
  default:
    script = path.join(SCRIPTS_DIR, 'tm-wrapper.js');
    scriptArgs = args;
    break;
}

ensureDeps();

const child = spawn(process.execPath, [script, ...scriptArgs], {
  stdio: 'inherit',
});

// Forward signals to the child process
function forwardSignal(signal) {
  try { child.kill(signal); } catch { /* child may have exited */ }
}

if (process.platform !== 'win32') {
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
}

child.on('exit', (code, signal) => {
  if (signal) {
    // Re-raise the signal so the parent sees the correct exit reason
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
