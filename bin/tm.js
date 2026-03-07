#!/usr/bin/env node

// tm.js — Cross-platform CLI entrypoint for terminal-mirror.
//
// Usage:
//   tm exec <command> [args...]  Wrap a command in a PTY with mirror socket
//   tm start-server [opts]       Start multi-session mirror web server
//   tm list                      List active tm-wrapper sessions

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
    '  tm exec <command> [args...]  Wrap a command in a PTY with mirror socket\n' +
    '  tm start-server [opts]       Start multi-session mirror web server\n' +
    '  tm list                      List active tm-wrapper sessions\n' +
    '\n' +
    'Examples:\n' +
    '  tm exec claude --model sonnet  Wrap Claude with terminal mirror support\n' +
    '  tm exec bash                   Wrap bash\n' +
    '  tm exec vim file.txt           Wrap vim\n' +
    '  tm start-server               Start mirror server (auto-discovers all sessions)\n' +
    '  tm start-server --spawn       Enable spawning new terminal sessions from web UI\n' +
    '  tm start-server --remote      Start mirror server accessible on LAN\n' +
    '  tm start-server -p 8080       Start mirror server on a specific port\n' +
    '  tm start-server --no-auth     Disable token authentication (auth is auto for --remote)\n' +
    '  tm start-server --open        Open browser automatically on server start\n' +
    '\n' +
    'Config file: ~/.config/terminal-mirror/config.json\n' +
    '  Set default options for start-server (CLI flags override config).\n' +
    '  Keys: port, remote, open, spawn, noAuth\n'
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
  case 'exec':
    if (args.length < 2) {
      process.stderr.write('Usage: tm exec <command> [args...]\n');
      process.exit(1);
    }
    script = path.join(SCRIPTS_DIR, 'tm-wrapper.js');
    scriptArgs = args.slice(1);
    break;
  default:
    process.stderr.write(`Unknown command: ${subcommand}\n`);
    process.stderr.write("Run 'tm --help' for usage.\n");
    process.exit(1);
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
