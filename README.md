# terminal-mirror

Real-time web-based terminal mirroring with collaborative code review.

Wrap any command in a PTY, then view and interact with it from a web browser. Supports inline comments, line selection, and multi-client access.

## Architecture

```
Terminal (User Shell)
    ↓
tm-wrapper.js ── PTY + Unix Socket (/tmp/tm-<PID>.sock)
    ↕ (one per session)
mirror-server.js ── HTTP + WebSocket Server (multi-session)
    ↕
Web Browser ── xterm.js + Comment UI + Session Selector
```

**tm-wrapper** spawns the command in a PTY, captures output into a 1MB ring buffer, and exposes a Unix domain socket for mirror clients.

**mirror-server** auto-discovers all active wrapper sockets, connects to each one, and serves a unified web UI with session switching, live terminal streaming, inline comments, and a message submission API. A 64KB replay buffer per session ensures new clients see recent output immediately.

## Quick Start

```bash
# 1. Start one or more wrapped sessions
tm exec bash
tm exec claude --model sonnet   # in another terminal

# 2. Start the mirror server (auto-discovers all sessions)
tm start-server
# Opens http://localhost:3456?token=<TOKEN> in your browser
```

## CLI Usage

### `tm exec <command> [args...]`

Wraps any command in a PTY with mirror socket support.

```bash
tm exec bash
tm exec claude --model sonnet
tm exec vim file.txt
tm exec python script.py
```

Sets environment variables for the child process:
- `TM_SOCKET` — path to the Unix socket
- `TM_TOKEN` — authentication token
- `TERM=xterm-256color`

### `tm start-server [options]`

Starts the multi-session web mirror server. Auto-discovers all active `tm-wrapper` sessions and periodically scans for new ones. Can be attached/detached at any time without affecting the wrapped processes.

```bash
tm start-server                    # Auto-discover all sessions, open browser
tm start-server --no-open          # Don't open browser
tm start-server --remote           # Bind 0.0.0.0 for LAN access
```

| Option | Description |
|--------|-------------|
| `--no-open` | Don't auto-open browser |
| `--remote` | Bind on `0.0.0.0` and output LAN IP URL |

**Session discovery:** The server scans `/tmp/tm-*.sock` every 5 seconds, automatically connecting to new wrappers and removing stale sessions whose processes have exited.

### `tm list`

Lists all active tm-wrapper sessions.

```
PID      CMD                        CWD                            STARTED
1234     bash                       /home/user/project             2024-03-01 14:22:30
```

## Config File

Default options for `start-server` can be set in `~/.config/terminal-mirror/config.json`. CLI flags always override config file values.

```json
{
  "port": 8080,
  "remote": true,
  "open": true,
  "spawn": false,
  "username": "admin",
  "password": "secret"
}
```

| Key | Type | Description |
|-----|------|-------------|
| `port` | number | Server port (1-65535) |
| `remote` | boolean | Bind on `0.0.0.0` for LAN access |
| `open` | boolean | Auto-open browser on start |
| `spawn` | boolean | Enable spawning sessions from web UI |
| `spawnCommand` | string \| string[] | Command to run for new sessions (e.g. `"bash"`, `["claude", "--model", "sonnet"]`) |
| `username` | string | HTTP Basic Auth username |
| `password` | string | HTTP Basic Auth password |
| `noAuth` | boolean | Disable authentication |

## Remote Access

Use `--remote` to allow access from other devices on your LAN/VPN:

```bash
tm start-server --remote
# Terminal Mirror: http://192.168.1.100:3456
```

- Binds on `0.0.0.0` instead of `127.0.0.1`
- Outputs LAN IP in the URL
- Relaxes CORS/WebSocket origin checks
- Basic Auth required when `username`/`password` are configured

## Web UI Features

- **Live terminal** — xterm.js rendering with full scrollback history
- **Multi-session** — Session selector dropdown with manual refresh button; switch between sessions seamlessly
- **Auto-discovery** — New wrapper sessions are detected automatically every 5 seconds
- **Auto-cleanup** — Disconnected sessions are automatically removed from the list
- **Replay buffer** — 64KB per-session replay buffer sends recent output instantly on session switch
- **Inline comments** — Select text, click the float button, add comments (GitHub-style)
- **Line selection** — Click/drag the gutter to select line ranges
- **Settings** — Adjustable font size, line height, and scrollback buffer
- **Message bar** — Send messages to the running terminal session

## Authentication

1. Each wrapper generates a 32-byte random token at startup, written to `/tmp/tm-<PID>.token` (mode `0600`) for inter-process auth
2. Mirror server uses HTTP Basic Auth when `username` and `password` are set in `config.json`
3. Browser prompts for credentials automatically; credentials are sent on all HTTP and WebSocket requests
4. Credential comparison uses `crypto.timingSafeEqual()` to prevent timing attacks
5. Use `--no-auth` to disable authentication entirely

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all active sessions |
| `GET` | `/api/status?session=<PID>` | Wrapper status (cols, rows, pid, connected) |
| `POST` | `/api/submit?session=<PID>` | Submit comments and messages |
| `GET` | `/api/poll?session=<PID>` | Long-poll for submitted messages (120s timeout) |
| `GET` | `/api/messages?session=<PID>` | Get all pending messages (non-blocking) |
| `POST` | `/api/done` | Shutdown mirror server |
| `WS` | `/ws/terminal?session=<PID>` | Live terminal data (binary + JSON) |
| `WS` | `/ws/comments?session=<PID>` | Comment broadcast stream |

All endpoints require HTTP Basic Auth when credentials are configured. Session-specific endpoints require a `session=<PID>` query parameter to identify the target wrapper.

## Windows Support

Windows is fully supported using Named Pipes and ConPTY.

### Prerequisites

- Node.js >= 20
- `node-pty` native build tools:
  - **Option A:** Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload
  - **Option B:** `npm install -g windows-build-tools`

### Installation

```powershell
cd terminal-mirror
npm install

# (Optional) Global CLI access
npm link
```

### Usage

```powershell
# Wrap a command
tm exec cmd
tm exec powershell
tm exec claude --model sonnet

# Start mirror server
tm start-server

# List active sessions
tm list
```

Without `npm link`:

```powershell
node bin/tm.js exec cmd
node bin/tm.js start-server
```

### Platform Differences

| | Unix | Windows |
|---|---|---|
| IPC | Unix socket (`/tmp/tm-<PID>.sock`) | Named Pipe (`\\?\pipe\tm-<PID>`) |
| Session marker | Socket file itself | `%TEMP%\tm-<PID>.pipe` |
| Token file | `/tmp/tm-<PID>.token` | `%TEMP%\tm-<PID>.token` |
| Command spawn | Direct PTY spawn | Routed through `cmd.exe /c` |

## Dependencies

- **node-pty** — PTY management for child processes
- **ws** — WebSocket server

```bash
cd terminal-mirror && npm install
```

Requires Node.js >= 20.
