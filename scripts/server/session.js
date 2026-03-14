const REPLAY_BUFFER_MAX = 512 * 1024; // 512 KB

let WebSocket = null;

function setWebSocket(ws) {
  WebSocket = ws;
}

function createSession(pid, ipcPath) {
  return {
    pid,
    sockPath: ipcPath,
    socket: null,
    connected: false,
    wrapperInfo: { cwd: process.cwd(), cols: 80, rows: 24, pid, cmd: '', startedAt: null, label: null },
    wrapperToken: null,
    lineBuf: '',
    reconnects: 0,
    terminalClients: new Set(),
    commentClients: new Set(),
    messageQueue: [],
    pollWaiters: [],
    replayChunks: [],
    replaySize: 0,
    termState: { altScreen: false, cursorHidden: false },
  };
}

function trackTerminalState(session, buf) {
  const str = buf.toString('latin1');

  const lastCursorHide = str.lastIndexOf('\x1b[?25l');
  const lastCursorShow = str.lastIndexOf('\x1b[?25h');
  if (lastCursorHide !== -1 || lastCursorShow !== -1) {
    session.termState.cursorHidden = lastCursorHide > lastCursorShow;
  }

  const lastAltEnter = str.lastIndexOf('\x1b[?1049h');
  const lastAltLeave = str.lastIndexOf('\x1b[?1049l');
  if (lastAltEnter !== -1 || lastAltLeave !== -1) {
    session.termState.altScreen = lastAltEnter > lastAltLeave;
  }
}

function getStateRestorationPrefix(session) {
  const replay = getReplayBuffer(session);
  let replayAltScreen = false;

  if (replay) {
    const str = replay.toString('latin1');
    const lastAltEnter = str.lastIndexOf('\x1b[?1049h');
    const lastAltLeave = str.lastIndexOf('\x1b[?1049l');
    replayAltScreen = lastAltEnter > lastAltLeave;
  }

  let prefix = '';
  if (session.termState.altScreen && !replayAltScreen) {
    prefix += '\x1b[?1049h';
  }
  return prefix ? Buffer.from(prefix) : null;
}

function getStateCorrectionSuffix(session) {
  return Buffer.from(session.termState.cursorHidden
    ? '\x1b[?25l\x1b[?12l'
    : '\x1b[?25h\x1b[?12h');
}

function appendReplayBuffer(session, buf) {
  session.replayChunks.push(buf);
  session.replaySize += buf.length;
  while (session.replaySize > REPLAY_BUFFER_MAX && session.replayChunks.length > 1) {
    session.replaySize -= session.replayChunks.shift().length;
  }
}

function getReplayBuffer(session) {
  if (session.replayChunks.length === 0) return null;
  if (session.replayChunks.length === 1) return session.replayChunks[0];
  const combined = Buffer.concat(session.replayChunks);
  session.replayChunks = [combined];
  session.replaySize = combined.length;
  return combined;
}

function resolveNextPoll(session) {
  while (session.pollWaiters.length > 0 && session.messageQueue.length > 0) {
    const { res, timer } = session.pollWaiters.shift();
    clearTimeout(timer);
    const msg = session.messageQueue.shift();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msg));
  }
}

function broadcast(clientSet, data) {
  const msg = typeof data === 'object' && !Buffer.isBuffer(data) ? JSON.stringify(data) : data;
  for (const ws of clientSet) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch { /* ws may be closing */ }
    }
  }
}

module.exports = {
  setWebSocket,
  createSession,
  trackTerminalState,
  getStateRestorationPrefix,
  getStateCorrectionSuffix,
  appendReplayBuffer,
  getReplayBuffer,
  resolveNextPoll,
  broadcast,
  REPLAY_BUFFER_MAX,
};
