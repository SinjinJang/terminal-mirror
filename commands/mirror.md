---
name: mirror
description: 웹 브라우저에서 현재 터미널 세션 미러링 시작
allowed-tools:
  - Bash
---

Start the terminal mirror web server to mirror the current terminal session in a web browser.

## Steps

1. Check if TM_SOCKET environment variable is set (indicates we're inside a tm-wrapper session).

2. Check dependencies are installed:
```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ ! -d "$PLUGIN_ROOT/node_modules" ]; then
  cd "$PLUGIN_ROOT" && npm install
fi
```

3. Start the mirror server in the background. IMPORTANT: You MUST use `run_in_background: true`.
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mirror-server.js" --no-open
```

4. Wait 2 seconds, then read the TaskOutput to get the PORT number from stderr output.

5. Report the URL to the user: `http://localhost:<PORT>`

6. Start a long-poll loop in the background with `run_in_background: true`:
```bash
curl -s http://localhost:<PORT>/api/poll
```

7. When a poll response arrives (JSON with `text` field), present it to the user and loop back to step 6.

## Important Notes

- The mirror server and poll requests MUST use `run_in_background: true`
- If TM_SOCKET is not set, inform the user they need to start the session with `tm <command>` first
- The mirror will auto-discover the wrapper session via /tmp/tm-*.sock scanning
