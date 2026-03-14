window.TM = window.TM || {};
TM.sessions = (function() {
  let spawnEnabled = false;
  let renamingTabPid = null;
  let lastSessionsKey = '';

  let ctx = null;

  function init(context) {
    ctx = context;

    // Refresh button
    document.getElementById('refreshSessionsBtn').addEventListener('click', async function () {
      const btn = this;
      btn.classList.add('spinning');
      await refreshSessions();
      setTimeout(() => btn.classList.remove('spinning'), 600);
    });

    // Spawn button
    document.getElementById('spawnSessionBtn').addEventListener('click', async function () {
      const btn = this;
      btn.disabled = true;
      try {
        const resp = await fetch('/api/spawn', { method: 'POST' });
        if (resp.ok) {
          const { pid } = await resp.json();
          setTimeout(async () => {
            await refreshSessions();
            if (pid) switchToSession(pid);
            btn.disabled = false;
          }, 800);
        } else {
          const data = await resp.json().catch(() => ({}));
          alert(data.error || 'Failed to spawn session');
          btn.disabled = false;
        }
      } catch {
        alert('Failed to spawn session');
        btn.disabled = false;
      }
    });
  }

  function getSessionFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const s = params.get('session');
    return s ? parseInt(s, 10) : null;
  }

  function updateUrlSession(pid) {
    const params = new URLSearchParams(window.location.search);
    if (pid) {
      params.set('session', String(pid));
    } else {
      params.delete('session');
    }
    const newUrl = window.location.pathname + '?' + params.toString();
    history.replaceState(null, '', newUrl);
  }

  async function fetchSessions() {
    try {
      const resp = await fetch('/api/sessions');
      if (!resp.ok) return [];
      const data = await resp.json();
      if (Array.isArray(data)) return data;
      spawnEnabled = !!data.spawnEnabled;
      updateSpawnButton();
      return data.sessions || [];
    } catch { return []; }
  }

  function formatSessionLabel(s) {
    if (s.label) return s.label;
    const cmd = (s.cmd || 'unknown').split('/').pop().split(' ')[0];
    const cwdName = s.cwd ? s.cwd.replace(/^.*\//, '') || '/' : '';
    const time = s.startedAt ? new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const parts = [cmd];
    if (cwdName) parts.push(cwdName);
    if (time) parts.push(time);
    return parts.join(' \u00b7 ');
  }

  function updateSessionTabs(sessionsList) {
    if (renamingTabPid !== null) return;
    const key = sessionsList.map(s => `${s.pid}:${s.connected}:${s.label || ''}`).join('|');
    if (key === lastSessionsKey) return;
    lastSessionsKey = key;
    ctx.dom.sessionTabsInner.innerHTML = '';

    if (sessionsList.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'session-no-tabs';
      empty.textContent = 'No sessions';
      ctx.dom.sessionTabsInner.appendChild(empty);
      return;
    }

    for (const s of sessionsList) {
      const tab = document.createElement('button');
      tab.className = 'session-tab';
      tab.dataset.pid = String(s.pid);
      if (ctx.state.currentSessionPid === s.pid) tab.classList.add('active');
      if (!s.connected) tab.classList.add('disconnected');

      const dot = document.createElement('span');
      dot.className = 'session-tab-dot';
      tab.appendChild(dot);

      const label = document.createElement('span');
      label.className = 'session-tab-label';
      label.textContent = formatSessionLabel(s);
      tab.appendChild(label);

      tab.addEventListener('click', () => {
        if (renamingTabPid === s.pid) return;
        const pid = parseInt(tab.dataset.pid, 10);
        if (!isNaN(pid)) switchToSession(pid);
      });

      tab.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startTabRename(tab, s);
      });

      tab.title = `${s.cmd || 'unknown'}\n${s.cwd || ''}\nDouble-click to rename`;

      ctx.dom.sessionTabsInner.appendChild(tab);
    }

    const activeTab = ctx.dom.sessionTabsInner.querySelector('.session-tab.active');
    if (activeTab) activeTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function startTabRename(tab, session) {
    if (renamingTabPid !== null) return;

    renamingTabPid = session.pid;

    const input = document.createElement('input');
    input.className = 'session-tab-label-input';
    input.value = session.label || '';
    input.placeholder = formatSessionLabel({ ...session, label: null });

    // Insert input as sibling of the button (not inside it) to avoid
    // Space key triggering native button activation and stealing focus.
    tab.style.display = 'none';
    tab.parentNode.insertBefore(input, tab.nextSibling);
    input.focus();
    input.select();

    function finish() {
      if (renamingTabPid !== session.pid) return;
      renamingTabPid = null;
      const newLabel = input.value.trim();
      input.remove();
      tab.style.display = '';

      const oldLabel = session.label || '';
      if (newLabel !== oldLabel) {
        fetch(`/api/sessions/label?session=${session.pid}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: newLabel || null }),
        }).then(() => refreshSessions()).catch(() => {});
      }
    }

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = session.label || ''; input.blur(); }
    });
  }

  async function refreshSessions() {
    const sessionsList = await fetchSessions();
    updateSessionTabs(sessionsList);

    if (!ctx.state.currentSessionPid && sessionsList.length > 0) {
      const urlSession = getSessionFromUrl();
      const target = urlSession && sessionsList.some(s => s.pid === urlSession)
        ? urlSession
        : sessionsList[0].pid;
      switchToSession(target);
    }

    return sessionsList;
  }

  function switchToSession(pid) {
    if (pid === ctx.state.currentSessionPid) return;

    TM.websocket.closeAll();

    const xterm = ctx.state.xterm;
    if (xterm) {
      xterm.reset();
      xterm.clear();
      xterm.write('\x1b[?25l');
    }
    ctx.state.serverCols = null;
    ctx.dom.textViewContainer.innerHTML = '';

    ctx.state.comments = [];
    ctx.state.submitted = [];
    ctx.state.knownBatchIds.clear();
    ctx.state.expandedCommentId = null;
    ctx.renderCommentOverlays();
    ctx.updateBadge();

    ctx.state.currentSessionPid = pid;
    updateUrlSession(pid);

    for (const tab of ctx.dom.sessionTabsInner.querySelectorAll('.session-tab')) {
      tab.classList.toggle('active', tab.dataset.pid === String(pid));
    }

    TM.websocket.resetCounters();
    ctx.dom.connectingOverlay.classList.remove('hidden');
    TM.websocket.connectTerminalWs();
    TM.websocket.connectCommentWs();

    if (ctx.state.textViewEnabled) ctx.dom.messageInput.focus();
    else if (ctx.state.xterm) ctx.state.xterm.focus();
  }

  function updateSpawnButton() {
    const btn = document.getElementById('spawnSessionBtn');
    if (btn) btn.style.display = spawnEnabled ? '' : 'none';
  }

  return { init, refreshSessions, switchToSession };
})();
