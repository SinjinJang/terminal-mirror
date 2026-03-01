# terminal-mirror

Real-time web-based terminal mirroring with collaborative code review.

Wrap any command in a PTY, then view and interact with it from a web browser. Supports inline comments, line selection, and multi-client access.

## Architecture

```
Terminal (User Shell)
    ↓
tm-wrapper.js ── PTY + Unix Socket (/tmp/tm-<PID>.sock)
    ↕
mirror-server.js ── HTTP + WebSocket Server
    ↕
Web Browser ── xterm.js + Comment UI
```

**tm-wrapper** spawns the command in a PTY, captures output into a 1MB ring buffer, and exposes a Unix domain socket for mirror clients.

**mirror-server** connects to the wrapper socket and serves a web UI with live terminal streaming, inline comments, and a message submission API.

## Quick Start

```bash
# 1. Start a wrapped session
tm bash

# 2. In another terminal, start the mirror
tm mirror
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

### `tm mirror [options]`

Starts the web mirror server. Can be attached/detached at any time without affecting the wrapped process.

```bash
tm mirror                          # Auto-discover wrapper, open browser
tm mirror --no-open                # Don't open browser
tm mirror --remote                 # Bind 0.0.0.0 for LAN access
tm mirror -s /tmp/tm-1234.sock     # Connect to specific wrapper
```

| Option | Description |
|--------|-------------|
| `-s, --socket <path>` | Connect to a specific wrapper socket |
| `--no-open` | Don't auto-open browser |
| `--remote` | Bind on `0.0.0.0` and output LAN IP URL |

**Socket discovery order:**
1. Explicit `--socket` flag
2. `TM_SOCKET` environment variable
3. Scan `/tmp/tm-*.sock` (most recently modified)

### `tm list`

Lists all active tm-wrapper sessions.

```
PID      CMD                        CWD                            STARTED
1234     bash                       /home/user/project             2024-03-01 14:22:30
```

## Remote Access

Use `--remote` to allow access from other devices on your LAN/VPN:

```bash
tm mirror --remote
# Terminal Mirror: http://192.168.1.100:3456?token=abc123...
```

- Binds on `0.0.0.0` instead of `127.0.0.1`
- Outputs LAN IP in the URL
- Relaxes CORS/WebSocket origin checks
- Token authentication still required

## Web UI Features

- **Live terminal** — xterm.js rendering with full scrollback history
- **Multi-session** — Session selector dropdown with manual refresh button
- **Auto-cleanup** — Disconnected sessions are automatically removed from the list
- **Inline comments** — Select text, click the float button, add comments (GitHub-style)
- **Line selection** — Click/drag the gutter to select line ranges
- **File viewer** — Clickable file paths open a syntax-highlighted viewer
- **Settings** — Adjustable font size, line height, and scrollback buffer
- **Message bar** — Send messages to the running terminal session

## Authentication

1. Wrapper generates a 32-byte random token at startup
2. Token is written to `/tmp/tm-<PID>.token` (mode `0600`)
3. Mirror server discovers the token from the matching socket path
4. Clients authenticate via `?token=<TOKEN>` query param or `Authorization: Bearer <TOKEN>` header
5. Token comparison uses `crypto.timingSafeEqual()` to prevent timing attacks

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all active sessions |
| `GET` | `/api/status` | Wrapper status (cols, rows, pid, connected) |
| `POST` | `/api/submit` | Submit comments and messages |
| `GET` | `/api/poll` | Long-poll for submitted messages (120s timeout) |
| `GET` | `/api/messages` | Get all pending messages (non-blocking) |
| `POST` | `/api/done` | Shutdown mirror server |
| `GET` | `/api/file?path=<PATH>` | Read file content (max 2MB) |
| `WS` | `/ws/terminal` | Live terminal data (binary + JSON) |
| `WS` | `/ws/comments` | Comment broadcast stream |

All `/api/` and WebSocket endpoints require token authentication.

## Dependencies

- **node-pty** — PTY management for child processes
- **ws** — WebSocket server

```bash
cd terminal-mirror && npm install
```

Requires Node.js >= 20.
