// platform.js — Cross-platform IPC abstraction for tm-wrapper, mirror-server, tm-list.
// Unix: /tmp/tm-PID.sock (socket file doubles as session marker)
// Windows: \\?\pipe\tm-PID (named pipe) + tmpdir/tm-PID.pipe (marker file for discovery)

const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';

/**
 * Returns the IPC path for a given PID.
 * Unix: tmpdir/tm-PID.sock
 * Windows: \\?\pipe\tm-PID
 */
function getIpcPath(pid) {
  if (IS_WIN) {
    return `\\\\?\\pipe\\tm-${pid}`;
  }
  return path.join(os.tmpdir(), `tm-${pid}.sock`);
}

/**
 * Returns the auth token file path (same on both platforms).
 */
function getTokenPath(pid) {
  return path.join(os.tmpdir(), `tm-${pid}.token`);
}

/**
 * Returns the marker path used for session discovery.
 * Unix: same as IPC path (socket file itself)
 * Windows: tmpdir/tm-PID.pipe (regular file acting as discovery marker)
 */
function getMarkerPath(pid) {
  if (IS_WIN) {
    return path.join(os.tmpdir(), `tm-${pid}.pipe`);
  }
  return getIpcPath(pid);
}

/**
 * Writes a marker file for session discovery (Windows only).
 * On Unix the socket file itself serves as the marker.
 */
function writeMarkerFile(pid) {
  if (!IS_WIN) return;
  try {
    fs.writeFileSync(getMarkerPath(pid), String(pid));
  } catch { /* best effort */ }
}

/**
 * Checks whether a session marker exists for the given PID.
 */
function sessionMarkerExists(pid) {
  try {
    fs.accessSync(getMarkerPath(pid));
    return true;
  } catch {
    return false;
  }
}

/**
 * Scans tmpdir for active tm-wrapper sessions.
 * Returns Map<pid, ipcPath>. Cleans up stale entries.
 */
function discoverSessions() {
  const tmpDir = os.tmpdir();
  const found = new Map();
  const pattern = IS_WIN ? /^tm-(\d+)\.pipe$/ : /^tm-(\d+)\.sock$/;

  try {
    for (const entry of fs.readdirSync(tmpDir)) {
      const m = entry.match(pattern);
      if (!m) continue;

      const pid = parseInt(m[1], 10);
      if (isNaN(pid)) continue;

      try {
        process.kill(pid, 0); // check if process is alive
        found.set(pid, getIpcPath(pid));
      } catch {
        // Process dead — clean up stale files
        cleanupSessionFiles(pid);
      }
    }
  } catch { /* tmpdir read error */ }

  return found;
}

/**
 * Removes marker + token files for a given PID.
 */
function cleanupSessionFiles(pid) {
  const files = [getTokenPath(pid)];
  if (IS_WIN) {
    files.push(getMarkerPath(pid));
  } else {
    // On Unix, remove the socket file
    files.push(getIpcPath(pid));
  }
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* already removed */ }
  }
}

module.exports = {
  IS_WIN,
  getIpcPath,
  getTokenPath,
  getMarkerPath,
  discoverSessions,
  cleanupSessionFiles,
  writeMarkerFile,
  sessionMarkerExists,
};
