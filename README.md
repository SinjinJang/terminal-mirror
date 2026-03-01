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
tm bash
tm claude --model sonnet   # in another terminal

# 2. Start the mirror server (auto-discovers all sessions)
tm start-server
# Opens http://localhost:3456?token=<TOKEN> in your browser
```

## CLI Usage

### `tm <command> [args...]`

Wraps any command in a PTY with mirror socket support.

```bash
tm bash
tm claude --model sonnet
tm vim file.txt
tm python script.py
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

## Remote Access

Use `--remote` to allow access from other devices on your LAN/VPN:

```bash
tm start-server --remote
# Terminal Mirror: http://192.168.1.100:3456?token=abc123...
```

- Binds on `0.0.0.0` instead of `127.0.0.1`
- Outputs LAN IP in the URL
- Relaxes CORS/WebSocket origin checks
- Token authentication still required

## Web UI Features

- **Live terminal** — xterm.js rendering with full scrollback history
- **Multi-session** — Session selector dropdown with manual refresh button; switch between sessions seamlessly
- **Auto-discovery** — New wrapper sessions are detected automatically every 5 seconds
- **Auto-cleanup** — Disconnected sessions are automatically removed from the list
- **Replay buffer** — 64KB per-session replay buffer sends recent output instantly on session switch
- **Inline comments** — Select text, click the float button, add comments (GitHub-style)
- **Line selection** — Click/drag the gutter to select line ranges
- **File viewer** — Clickable file paths open a syntax-highlighted viewer
- **Settings** — Adjustable font size, line height, and scrollback buffer
- **Message bar** — Send messages to the running terminal session

## Authentication

1. Each wrapper generates a 32-byte random token at startup, written to `/tmp/tm-<PID>.token` (mode `0600`)
2. Mirror server generates its own master token for client authentication
3. Clients authenticate via `?token=<TOKEN>` query param or `Authorization: Bearer <TOKEN>` header
4. Token comparison uses `crypto.timingSafeEqual()` to prevent timing attacks

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all active sessions |
| `GET` | `/api/status?session=<PID>` | Wrapper status (cols, rows, pid, connected) |
| `POST` | `/api/submit?session=<PID>` | Submit comments and messages |
| `GET` | `/api/poll?session=<PID>` | Long-poll for submitted messages (120s timeout) |
| `GET` | `/api/messages?session=<PID>` | Get all pending messages (non-blocking) |
| `POST` | `/api/done` | Shutdown mirror server |
| `GET` | `/api/file?session=<PID>&path=<PATH>` | Read file content (max 2MB) |
| `WS` | `/ws/terminal?session=<PID>` | Live terminal data (binary + JSON) |
| `WS` | `/ws/comments?session=<PID>` | Comment broadcast stream |

All `/api/` and WebSocket endpoints require token authentication. Session-specific endpoints require a `session=<PID>` query parameter to identify the target wrapper.

## Dependencies

- **node-pty** — PTY management for child processes
- **ws** — WebSocket server

```bash
cd terminal-mirror && npm install
```

Requires Node.js >= 20.
