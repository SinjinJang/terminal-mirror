const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_DIR = path.join(os.homedir(), '.config', 'terminal-mirror');
const STORE_PATH = path.join(STORE_DIR, 'sessions.json');
const TMP_SUFFIX = '.tmp';

function loadLabels() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.labels)) return data.labels;
  } catch { /* missing or unreadable */ }
  return [];
}

function saveLabels(entries) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmpPath = STORE_PATH + TMP_SUFFIX;
    fs.writeFileSync(tmpPath, JSON.stringify({ labels: entries }, null, 2));
    fs.renameSync(tmpPath, STORE_PATH);
  } catch (err) {
    process.stderr.write(`Warning: failed to persist session labels: ${err.message}\n`);
  }
}

function matches(entry, pid, startedAt) {
  return entry.pid === pid && entry.startedAt === startedAt;
}

function findLabel(pid, startedAt) {
  if (!startedAt) return null;
  const entry = loadLabels().find(e => matches(e, pid, startedAt));
  return entry ? entry.label : null;
}

function setLabel(pid, startedAt, cmd, label) {
  if (!startedAt) return;
  const entries = loadLabels().filter(e => !matches(e, pid, startedAt));
  entries.push({ pid, startedAt, cmd: cmd || '', label });
  saveLabels(entries);
}

function removeLabel(pid, startedAt) {
  if (!startedAt) return;
  const entries = loadLabels();
  const filtered = entries.filter(e => !matches(e, pid, startedAt));
  if (filtered.length !== entries.length) saveLabels(filtered);
}

module.exports = { loadLabels, saveLabels, findLabel, setLabel, removeLabel };
