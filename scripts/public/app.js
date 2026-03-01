(function() {
  // ── Auth token from URL ──
  const urlParams = new URLSearchParams(window.location.search);
  const authToken = urlParams.get('token') || '';

  function authFetch(url, opts = {}) {
    const h = { ...(opts.headers || {}) };
    if (authToken) h['Authorization'] = 'Bearer ' + authToken;
    return fetch(url, { ...opts, headers: h });
  }

  // ── Constants ──
  const MAX_SELECTED_TEXT = 500;
  const MAX_SELECTED_TEXT_DISPLAY = 80;
  const MAX_RECONNECT = 5;
  const DISCONNECT_CLOSE_MS = 10000;
  const COMMENT_COLORS = ['#ff9e64', '#7aa2f7', '#9ece6a', '#bb9af7', '#7dcfff'];
  const SETTINGS_KEY = 'terminal-mirror-settings';
  const DEFAULT_SETTINGS = { fontSize: 13, lineHeight: 1.4, scrollback: 50000 };

  // ── State ──
  let comments = [];       // pending (not yet submitted)
  let submitted = [];      // already submitted to server
  let nextCommentId = 0;
  let pendingSelection = null;
  let activeComment = null;
  let editingCommentId = null;
  let xterm = null;
  let fitAddon = null;
  let serverCols = null;
  const knownBatchIds = new Set();

  // ── Settings ──
  function clampNum(val, min, max) { return Math.min(max, Math.max(min, val)); }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return {
        fontSize: clampNum(parsed.fontSize ?? DEFAULT_SETTINGS.fontSize, 10, 24),
        lineHeight: clampNum(parsed.lineHeight ?? DEFAULT_SETTINGS.lineHeight, 1.0, 2.0),
        scrollback: clampNum(parsed.scrollback ?? DEFAULT_SETTINGS.scrollback, 1000, 100000),
      };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function applySettings(s) {
    if (!xterm) return;
    xterm.options.fontSize = s.fontSize;
    xterm.options.lineHeight = s.lineHeight;
    xterm.options.scrollback = s.scrollback;
    fitTerminal();
    renderCommentOverlays();
  }

  let currentSettings = loadSettings();

  // ── DOM refs ──
  const terminalPanel = document.getElementById('terminalPanel');
  const xtermContainer = document.getElementById('xtermContainer');
  const loadingState = document.getElementById('loadingState');
  const doneBtn = document.getElementById('doneBtn');
  const floatBtn = document.getElementById('floatBtn');
  const commentPopup = document.getElementById('commentPopup');
  const popupSelected = document.getElementById('popupSelected');
  const popupTextarea = document.getElementById('popupTextarea');
  const popupCancel = document.getElementById('popupCancel');
  const popupSave = document.getElementById('popupSave');
  const popupHeader = document.querySelector('.comment-popup-header');
  const commentBadge = document.getElementById('commentBadge');
  const toast = document.getElementById('toast');
  const messageInput = document.getElementById('messageInput');
  const sendSubmitBtn = document.getElementById('sendSubmitBtn');
  const wsStatus = document.getElementById('wsStatus');
  const wrapperStatusEl = document.getElementById('wrapperStatus');
  const scrollBottomBtn = document.getElementById('scrollBottomBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const fontSizeRange = document.getElementById('fontSizeRange');
  const fontSizeValue = document.getElementById('fontSizeValue');
  const lineHeightRange = document.getElementById('lineHeightRange');
  const lineHeightValue = document.getElementById('lineHeightValue');
  const scrollbackInput = document.getElementById('scrollbackInput');
  const settingsReset = document.getElementById('settingsReset');

  // ── xterm.js setup ──
  let lastMousePos = { x: 0, y: 0 };
  let terminalWs = null;
  let renderGutterMarkers = () => {};
  let renderInlineComments = () => {};
  let renderCommentOverlays = () => {};
  let expandedCommentId = null;
  let gutterDragging = false;
  let gutterAnchorRow = null;

  // Fit terminal to container but constrain cols to server PTY width
  function fitTerminal() {
    if (!fitAddon || !xterm) return;
    fitAddon.fit();
    if (serverCols !== null && xterm.cols !== serverCols) {
      xterm.resize(serverCols, xterm.rows);
    }
  }

  function initXterm() {
    xterm = new window.Terminal({
      theme: {
        background: '#0a0a0a',
        foreground: '#e4e4e4',
        cursor: 'rgba(0,0,0,0)',
        selectionBackground: 'rgba(122, 162, 247, 0.3)',
      },
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      fontSize: currentSettings.fontSize,
      lineHeight: currentSettings.lineHeight,
      scrollback: currentSettings.scrollback,
      convertEol: false,
      disableStdin: false,
      cursorBlink: false,
    });

    fitAddon = new window.FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);

    xtermContainer.style.display = 'block';
    xterm.open(xtermContainer);
    fitTerminal();

    window.addEventListener('resize', () => {
      fitTerminal();
      renderCommentOverlays();
    });
    new ResizeObserver(() => {
      fitTerminal();
      renderCommentOverlays();
    }).observe(terminalPanel);

    // Ctrl+C with selection → clipboard copy (instead of SIGINT)
    function copyToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => copyFallback(text));
      } else {
        copyFallback(text);
      }
    }
    function copyFallback(text) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.ctrlKey && ev.type === 'keydown') {
        if (ev.key === 'c') {
          const sel = xterm.getSelection();
          if (sel) {
            copyToClipboard(sel);
            return false;
          }
        }
        if (ev.key === 'v') {
          ev.preventDefault();
          navigator.clipboard.readText().then((text) => {
            if (text && terminalWs && terminalWs.readyState === WebSocket.OPEN) {
              terminalWs.send(JSON.stringify({ type: 'input', data: text }));
            }
          }).catch(() => {});
          return false;
        }
      }
      return true;
    });

    // Keyboard input → WebSocket → PTY
    xterm.onData((data) => {
      if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
        terminalWs.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // ── Create gutter + highlight overlays ──
    const lineGutter = document.createElement('div');
    lineGutter.className = 'line-gutter';
    xtermContainer.appendChild(lineGutter);

    const gutterPlus = document.createElement('div');
    gutterPlus.className = 'line-gutter-plus';
    gutterPlus.textContent = '+';
    lineGutter.appendChild(gutterPlus);

    const lineHighlight = document.createElement('div');
    lineHighlight.className = 'line-select-hint';
    xtermContainer.appendChild(lineHighlight);

    const gutterMarkersEl = document.createElement('div');
    gutterMarkersEl.className = 'gutter-markers';
    xtermContainer.appendChild(gutterMarkersEl);

    const inlineCommentsEl = document.createElement('div');
    inlineCommentsEl.className = 'inline-comments';
    xtermContainer.appendChild(inlineCommentsEl);

    // Track mouse position for floating button placement
    xtermContainer.addEventListener('mousemove', (e) => {
      lastMousePos = { x: e.clientX, y: e.clientY };
    });

    // Selection handling (skip during gutter drag)
    xterm.onSelectionChange(() => {
      if (gutterDragging) return;
      if (commentPopup.style.display === 'block') return;

      const text = xterm.getSelection().trim();
      if (!text) {
        floatBtn.style.display = 'none';
        lineHighlight.style.display = 'none';
        pendingSelection = null;
        return;
      }

      floatBtn.style.display = 'block';
      floatBtn.style.left = `${lastMousePos.x - 50}px`;
      floatBtn.style.top = `${lastMousePos.y + 10}px`;

      const pos = xterm.getSelectionPosition();
      const selStartRow = pos ? Math.min(pos.start.y, pos.end.y) : null;
      const selEndRow = pos ? Math.max(pos.start.y, pos.end.y) : null;
      pendingSelection = { selectedText: text.substring(0, MAX_SELECTED_TEXT), startRow: selStartRow, endRow: selEndRow };
    });

    // ── GitHub-style line gutter helpers ──
    function getCellHeight() {
      const screen = xtermContainer.querySelector('.xterm-screen');
      return screen ? screen.clientHeight / xterm.rows : 0;
    }

    function viewportRowFromY(clientY) {
      const screen = xtermContainer.querySelector('.xterm-screen');
      if (!screen) return -1;
      const rect = screen.getBoundingClientRect();
      const ch = getCellHeight();
      if (clientY < rect.top) return 0;
      if (clientY >= rect.bottom) return xterm.rows - 1;
      const row = Math.floor((clientY - rect.top) / ch);
      return Math.max(0, Math.min(row, xterm.rows - 1));
    }

    // Position gutter to match xterm-screen
    function updateGutterPosition() {
      const screen = xtermContainer.querySelector('.xterm-screen');
      if (!screen) return;
      const containerRect = xtermContainer.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      lineGutter.style.top = `${screenRect.top - containerRect.top}px`;
      lineGutter.style.height = `${screenRect.height}px`;
    }

    new ResizeObserver(updateGutterPosition).observe(xtermContainer);
    setTimeout(updateGutterPosition, 100);

    function selectSingleLine(bufferRow) {
      const line = xterm.buffer.active.getLine(bufferRow);
      if (!line) return;
      const lineText = line.translateToString(true);
      if (!lineText.trim()) return;
      xterm.select(0, bufferRow, xterm.cols);
      pendingSelection = { selectedText: lineText.trim().substring(0, MAX_SELECTED_TEXT), startRow: bufferRow, endRow: bufferRow };
    }

    function selectLineRange(fromRow, toRow) {
      const startRow = Math.min(fromRow, toRow);
      const endRow = Math.max(fromRow, toRow);
      const lines = [];
      for (let r = startRow; r <= endRow; r++) {
        const line = xterm.buffer.active.getLine(r);
        if (line) lines.push(line.translateToString(true));
      }
      const fullText = lines.join('\n').trim();
      if (!fullText) return;
      xterm.select(0, startRow, (endRow - startRow + 1) * xterm.cols);
      pendingSelection = { selectedText: fullText.substring(0, MAX_SELECTED_TEXT), startRow, endRow };
    }

    function updateHighlight(startVRow, endVRow) {
      const s = Math.min(startVRow, endVRow);
      const e = Math.max(startVRow, endVRow);
      const ch = getCellHeight();
      const screen = xtermContainer.querySelector('.xterm-screen');
      if (!screen) return;
      const containerRect = xtermContainer.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      lineHighlight.style.display = 'block';
      lineHighlight.style.top = `${screenRect.top - containerRect.top + s * ch}px`;
      lineHighlight.style.height = `${(e - s + 1) * ch}px`;
      lineHighlight.style.width = `${Math.min(screenRect.width + 28, containerRect.width)}px`;
    }

    // Gutter hover: show "+" and highlight (non-drag only)
    lineGutter.addEventListener('mousemove', (e) => {
      if (gutterDragging) return;
      const vRow = viewportRowFromY(e.clientY);
      if (vRow < 0) { gutterPlus.style.display = 'none'; return; }
      const ch = getCellHeight();
      gutterPlus.style.display = 'flex';
      gutterPlus.style.top = `${vRow * ch + (ch - 20) / 2}px`;
      updateHighlight(vRow, vRow);
    });

    lineGutter.addEventListener('mouseleave', () => {
      if (!gutterDragging) {
        gutterPlus.style.display = 'none';
        lineHighlight.style.display = 'none';
      }
    });

    // Mousedown on gutter: start drag
    lineGutter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const vRow = viewportRowFromY(e.clientY);
      if (vRow < 0) return;

      const bufferRow = vRow + xterm.buffer.active.viewportY;
      gutterAnchorRow = bufferRow;
      gutterDragging = true;
      selectSingleLine(bufferRow);
      updateHighlight(vRow, vRow);
      lastMousePos = { x: e.clientX, y: e.clientY };
    });

    // Drag: window capture phase
    window.addEventListener('mousemove', (e) => {
      if (!gutterDragging || gutterAnchorRow === null) return;
      e.preventDefault();
      e.stopPropagation();
      const vRow = viewportRowFromY(e.clientY);
      if (vRow < 0) return;
      const bufferRow = vRow + xterm.buffer.active.viewportY;
      const anchorVRow = gutterAnchorRow - xterm.buffer.active.viewportY;
      selectLineRange(gutterAnchorRow, bufferRow);
      updateHighlight(anchorVRow, vRow);
      lastMousePos = { x: e.clientX, y: e.clientY };
      const ch = getCellHeight();
      gutterPlus.style.display = 'flex';
      gutterPlus.style.top = `${vRow * ch + (ch - 20) / 2}px`;
    }, true);

    // End drag: window capture phase
    window.addEventListener('mouseup', (e) => {
      if (!gutterDragging) return;
      e.stopPropagation();
      gutterDragging = false;
      gutterPlus.style.display = 'none';
      if (pendingSelection) {
        floatBtn.style.display = 'block';
        floatBtn.style.left = `${lastMousePos.x + 10}px`;
        floatBtn.style.top = `${lastMousePos.y + 10}px`;
      }
    }, true);

    // ── Gutter comment markers rendering ──
    function getCommentLayoutData() {
      const allComments = [
        ...comments.map((c, i) => ({ ...c, _submitted: false, _ci: i })),
        ...submitted.map(c => ({ ...c, _submitted: true, _ci: 0 })),
      ];
      const withRows = allComments.filter(c => c.startRow != null);
      if (withRows.length === 0) return null;

      const viewportY = xterm.buffer.active.viewportY;
      const rows = xterm.rows;
      const screen = xtermContainer.querySelector('.xterm-screen');
      if (!screen) return null;
      const containerRect = xtermContainer.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const ch = screen.clientHeight / rows;

      return { allComments: withRows, viewportY, rows, containerRect, screenRect, ch };
    }

    renderGutterMarkers = function() {
      gutterMarkersEl.textContent = '';
      const layout = getCommentLayoutData();
      if (!layout) return;
      const { allComments: withRows, viewportY, rows, containerRect, screenRect, ch } = layout;

      for (const c of withRows) {
        const vRow = c.startRow - viewportY;
        if (vRow < 0 || vRow >= rows) continue;
        const dot = document.createElement('div');
        dot.className = 'gutter-marker' + (c._submitted ? ' submitted' : '');
        if (!c._submitted) {
          dot.style.background = COMMENT_COLORS[c._ci % COMMENT_COLORS.length];
        }
        dot.style.top = `${screenRect.top - containerRect.top + vRow * ch + (ch - 8) / 2}px`;
        dot.addEventListener('click', () => {
          expandedCommentId = expandedCommentId === c.id ? null : c.id;
          renderInlineComments();
        });
        gutterMarkersEl.appendChild(dot);
      }
    };

    // ── Inline comment widgets ──
    function buildInlineWidget(c, stackIndex) {
      const isExpanded = expandedCommentId === c.id;
      const widget = document.createElement('div');
      widget.className = 'inline-comment' + (isExpanded ? ' expanded' : '') + (c._submitted ? ' submitted' : '');
      widget.dataset.commentId = c.id;

      const dot = document.createElement('span');
      dot.className = 'inline-comment-dot';
      dot.style.background = c._submitted ? '#555' : COMMENT_COLORS[c._ci % COMMENT_COLORS.length];
      widget.appendChild(dot);

      const preview = document.createElement('span');
      preview.className = 'inline-comment-preview';
      preview.textContent = c.comment.length > 30 ? c.comment.substring(0, 30) + '...' : c.comment;
      widget.appendChild(preview);

      const ref = document.createElement('div');
      ref.className = 'inline-comment-ref';
      const refText = c.selectedText || '';
      ref.textContent = '"' + (refText.length > 60 ? refText.substring(0, 60) + '...' : refText) + '"';
      widget.appendChild(ref);

      const body = document.createElement('div');
      body.className = 'inline-comment-body';
      body.textContent = c.comment;
      widget.appendChild(body);

      if (!c._submitted) {
        const actions = document.createElement('div');
        actions.className = 'inline-comment-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'inline-comment-btn edit';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openEditPopup(c);
        });
        actions.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'inline-comment-btn delete';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          comments = comments.filter(x => x.id !== c.id);
          expandedCommentId = null;
          renderCommentOverlays();
          updateBadge();
        });
        actions.appendChild(deleteBtn);

        widget.appendChild(actions);
      }

      widget.addEventListener('click', () => {
        expandedCommentId = expandedCommentId === c.id ? null : c.id;
        renderInlineComments();
      });

      return widget;
    }

    renderInlineComments = function() {
      inlineCommentsEl.textContent = '';
      const layout = getCommentLayoutData();
      if (!layout) return;
      const { allComments: withRows, viewportY, rows, containerRect, screenRect, ch } = layout;

      const byRow = {};
      for (const c of withRows) {
        const vRow = c.startRow - viewportY;
        if (vRow < 0 || vRow >= rows) continue;
        if (!byRow[vRow]) byRow[vRow] = [];
        byRow[vRow].push(c);
      }

      for (const vRowStr of Object.keys(byRow)) {
        const vRow = parseInt(vRowStr, 10);
        const group = byRow[vRow];
        const leftOffset = screenRect.right - containerRect.left + 8;
        group.forEach((c, stackIndex) => {
          const widget = buildInlineWidget(c, stackIndex);
          const topOffset = screenRect.top - containerRect.top + vRow * ch + stackIndex * (ch + 2);
          widget.style.top = `${topOffset}px`;
          widget.style.left = `${leftOffset}px`;
          inlineCommentsEl.appendChild(widget);
        });
      }
    };

    renderCommentOverlays = function() {
      renderGutterMarkers();
      renderInlineComments();
    };

    // ── Scroll-to-bottom button logic ──
    function updateScrollBottomBtn() {
      const isAtBottom = xterm.buffer.active.viewportY + xterm.rows >= xterm.buffer.active.length;
      if (isAtBottom) {
        scrollBottomBtn.classList.remove('visible');
      } else {
        scrollBottomBtn.classList.add('visible');
      }
    }

    scrollBottomBtn.addEventListener('click', () => {
      xterm.scrollToBottom();
    });

    xtermContainer.addEventListener('wheel', () => {
      requestAnimationFrame(() => {
        renderCommentOverlays();
        updateScrollBottomBtn();
      });
    });

    xterm.onScroll(() => { renderCommentOverlays(); updateScrollBottomBtn(); });
    let gutterDebounce = null;
    xterm.onWriteParsed(() => {
      clearTimeout(gutterDebounce);
      gutterDebounce = setTimeout(renderCommentOverlays, 100);
      updateScrollBottomBtn();
    });

    // ── File path link provider ──
    var DIR_PATH_RE = /((?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)+[\w@.+-]+\.[\w]{1,10})(?::(\d+))?(?::(\d+))?/g;
    var KNOWN_EXTS = 'ts|tsx|js|jsx|mjs|cjs|py|rb|rs|go|java|json|yaml|yml|toml|md|sh|css|scss|html|xml|vue|svelte|sql|c|h|cpp|hpp';
    var STANDALONE_RE = new RegExp('(?:^|[\\s\'"(,:`])([\\w@.-]+\\.(?:' + KNOWN_EXTS + '))(?::(\\d+))?(?::(\\d+))?', 'gi');

    function openFileLink(fp, ln) {
      var params = new URLSearchParams({ path: fp });
      if (ln > 0) params.set('line', String(ln));
      if (authToken) params.set('token', authToken);
      window.open('/viewer.html?' + params.toString(), '_blank');
    }

    xterm.registerLinkProvider({
      provideLinks: function(y, callback) {
        var line = xterm.buffer.active.getLine(y - 1);
        if (!line) { callback(undefined); return; }
        var text = line.translateToString(true);
        var links = [];
        var taken = [];
        var m;

        DIR_PATH_RE.lastIndex = 0;
        while ((m = DIR_PATH_RE.exec(text)) !== null) {
          var fp = m[1], ln = m[2] ? parseInt(m[2], 10) : 0;
          var prefStart = Math.max(0, m.index - 10);
          if (/\w+:\/?$/.test(text.substring(prefStart, m.index))) continue;
          if (fp.length < 3) continue;
          taken.push([m.index, m.index + m[0].length]);
          links.push({
            range: { start: { x: m.index + 1, y: y }, end: { x: m.index + m[0].length, y: y } },
            text: m[0],
            decorations: { pointerCursor: true, underline: true },
            activate: (function(f, l) { return function() { openFileLink(f, l); }; })(fp, ln),
          });
        }

        STANDALONE_RE.lastIndex = 0;
        while ((m = STANDALONE_RE.exec(text)) !== null) {
          var pathIdx = m.index + m[0].indexOf(m[1]);
          var fullLen = m[0].length - m[0].indexOf(m[1]);
          var overlap = taken.some(function(r) { return pathIdx < r[1] && (pathIdx + fullLen) > r[0]; });
          if (overlap) continue;
          var fp2 = m[1], ln2 = m[2] ? parseInt(m[2], 10) : 0;
          links.push({
            range: { start: { x: pathIdx + 1, y: y }, end: { x: pathIdx + fullLen, y: y } },
            text: m[1],
            decorations: { pointerCursor: true, underline: true },
            activate: (function(f, l) { return function() { openFileLink(f, l); }; })(fp2, ln2),
          });
        }

        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  // ── Badge + inline comment updates ──
  function updateBadge() {
    const pending = comments.length;
    const sent = submitted.length;
    if (pending === 0 && sent === 0) {
      commentBadge.textContent = '';
    } else if (pending > 0 && sent > 0) {
      commentBadge.textContent = `${pending} pending / ${sent} submitted`;
    } else if (pending > 0) {
      commentBadge.textContent = `${pending} pending`;
    } else {
      commentBadge.textContent = `${sent} submitted`;
    }
  }

  // ── Comment popup ──
  function openEditPopup(c) {
    editingCommentId = c.id;
    popupHeader.textContent = 'Edit Comment';

    popupSelected.textContent = `"${c.selectedText.substring(0, MAX_SELECTED_TEXT_DISPLAY)}${c.selectedText.length > MAX_SELECTED_TEXT_DISPLAY ? '...' : ''}"`;
    popupTextarea.value = c.comment;

    positionPopupAtTerminalCenter();

    if (xterm) xterm.blur();
    setTimeout(() => popupTextarea.focus(), 50);
  }

  function positionPopupAtTerminalCenter() {
    const screen = xtermContainer.querySelector('.xterm-screen');
    const r = screen ? screen.getBoundingClientRect() : terminalPanel.getBoundingClientRect();
    commentPopup.style.display = 'block';
    commentPopup.style.left = `${Math.max(10, r.left + (r.width - 320) / 2)}px`;
    commentPopup.style.top = `${Math.max(10, r.top + (r.height - 220) / 2)}px`;
  }

  function showCommentPopup() {
    if (!pendingSelection) return;
    editingCommentId = null;
    popupHeader.textContent = 'Add Comment';
    activeComment = { ...pendingSelection };
    floatBtn.style.display = 'none';

    popupSelected.textContent = `"${activeComment.selectedText.substring(0, MAX_SELECTED_TEXT_DISPLAY)}${activeComment.selectedText.length > MAX_SELECTED_TEXT_DISPLAY ? '...' : ''}"`;
    popupTextarea.value = '';

    positionPopupAtTerminalCenter();

    if (xterm) xterm.blur();
    setTimeout(() => popupTextarea.focus(), 50);
  }

  function hideCommentPopup() {
    commentPopup.style.display = 'none';
    editingCommentId = null;
    activeComment = null;
    pendingSelection = null;
  }

  function saveComment() {
    const text = popupTextarea.value.trim();
    if (!text) return;

    if (editingCommentId !== null) {
      const existing = comments.find(c => c.id === editingCommentId);
      if (existing) existing.comment = text;
    } else {
      if (!activeComment) return;
      comments.push({ ...activeComment, comment: text, id: nextCommentId++ });
    }
    hideCommentPopup();
    renderCommentOverlays();
    updateBadge();
    if (xterm) xterm.clearSelection();
    messageInput.focus();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2000);
  }

  function sendAll(withSubmit) {
    const message = messageInput.value.trim();
    const hasComments = comments.length > 0;
    const hasMessage = message.length > 0;
    if (!hasComments && !hasMessage) return;
    if (!terminalWs || terminalWs.readyState !== WebSocket.OPEN) {
      showToast('Terminal not connected');
      return;
    }

    const batchId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    knownBatchIds.add(batchId);

    const parts = [];
    for (const c of comments) {
      const lines = c.selectedText ? c.selectedText.split('\n').filter(l => l.trim()) : [];
      let firstLine = '';
      if (c.startRow != null && xterm) {
        const bufLine = xterm.buffer.active.getLine(c.startRow);
        if (bufLine) {
          const fullLine = bufLine.translateToString(true).trim();
          const selFirst = lines.length > 0 ? lines[0].trim() : '';
          const idx = selFirst ? fullLine.indexOf(selFirst) : -1;
          if (idx >= 0 && selFirst !== fullLine) {
            const before = fullLine.substring(0, idx);
            const after = lines.length > 1 ? '' : fullLine.substring(idx + selFirst.length);
            const closeTag = lines.length > 1 ? '' : '</QUOTE>';
            firstLine = (before + '<QUOTE>' + selFirst + closeTag + after).substring(0, MAX_SELECTED_TEXT_DISPLAY + 30);
          } else {
            firstLine = fullLine.substring(0, MAX_SELECTED_TEXT_DISPLAY);
          }
        }
      }
      if (!firstLine && lines.length > 0) {
        firstLine = lines[0].trimEnd().substring(0, MAX_SELECTED_TEXT_DISPLAY);
      }
      const more = lines.length > 1 ? ` +${lines.length - 1} lines` : '';
      const ref = firstLine ? `[Re: "${firstLine}"${more}] ` : '';
      parts.push(`${ref}${c.comment}`);
    }
    if (message) parts.push(message);
    const text = parts.join('\n\n');

    // Inject into PTY via WebSocket (bracketed paste mode)
    const data = '\x1b[200~' + text + '\x1b[201~';
    terminalWs.send(JSON.stringify({ type: 'input', data }));

    if (withSubmit) {
      setTimeout(() => {
        if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
          terminalWs.send(JSON.stringify({ type: 'input', data: '\r' }));
        }
      }, 300);
    }

    authFetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments: hasComments ? comments : [], message: message || undefined, batchId }),
    }).catch(() => {});

    const resultParts = [];
    if (hasComments) {
      resultParts.push(`${comments.length} comment(s)`);
      comments = [];
    }
    if (hasMessage) {
      messageInput.value = '';
      messageInput.style.height = '';
      resultParts.push('message');
    }
    renderCommentOverlays();
    updateBadge();
    showToast(`Submitted: ${resultParts.join(' + ')}`);
  }

  async function done() {
    try { await authFetch('/api/done', { method: 'POST' }); } catch {}
    window.close();
  }

  // ── Event listeners ──
  floatBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showCommentPopup();
  });

  popupCancel.addEventListener('click', hideCommentPopup);
  popupSave.addEventListener('click', saveComment);

  popupTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
    if (e.key === 'Escape') hideCommentPopup();
    e.stopPropagation();
  });

  popupTextarea.addEventListener('click', () => {
    if (xterm) xterm.blur();
    popupTextarea.focus();
  });

  doneBtn.addEventListener('click', done);
  sendSubmitBtn.addEventListener('click', () => sendAll(true));

  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAll(true);
    }
    e.stopPropagation();
  });

  messageInput.addEventListener('click', () => {
    if (xterm) xterm.blur();
    messageInput.focus();
  });

  document.addEventListener('mousedown', (e) => {
    if (commentPopup.style.display === 'block' &&
        !commentPopup.contains(e.target) &&
        e.target !== floatBtn) {
      hideCommentPopup();
    }
    if (settingsPanel.classList.contains('open') &&
        !settingsPanel.contains(e.target) &&
        e.target !== settingsBtn) {
      settingsPanel.classList.remove('open');
    }
    if (expandedCommentId !== null && !e.target.closest('.inline-comment')) {
      expandedCommentId = null;
      renderInlineComments();
    }
  });

  // ── Settings panel ──
  function syncSettingsUI(s) {
    fontSizeRange.value = s.fontSize;
    fontSizeValue.textContent = s.fontSize;
    lineHeightRange.value = s.lineHeight;
    lineHeightValue.textContent = s.lineHeight;
    scrollbackInput.value = s.scrollback;
  }

  syncSettingsUI(currentSettings);

  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
  });

  settingsPanel.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });

  fontSizeRange.addEventListener('input', () => {
    const v = parseInt(fontSizeRange.value, 10);
    currentSettings.fontSize = v;
    fontSizeValue.textContent = v;
    applySettings(currentSettings);
    saveSettings(currentSettings);
  });

  lineHeightRange.addEventListener('input', () => {
    const v = parseFloat(lineHeightRange.value);
    currentSettings.lineHeight = Math.round(v * 10) / 10;
    lineHeightValue.textContent = currentSettings.lineHeight;
    applySettings(currentSettings);
    saveSettings(currentSettings);
  });

  scrollbackInput.addEventListener('input', () => {
    const v = clampNum(parseInt(scrollbackInput.value, 10) || DEFAULT_SETTINGS.scrollback, 1000, 100000);
    currentSettings.scrollback = v;
    applySettings(currentSettings);
    saveSettings(currentSettings);
  });

  settingsReset.addEventListener('click', () => {
    currentSettings = { ...DEFAULT_SETTINGS };
    syncSettingsUI(currentSettings);
    applySettings(currentSettings);
    saveSettings(currentSettings);
    showToast('Settings reset to defaults');
  });

  // ── Wrapper status indicator ──
  function updateWrapperStatus(connected) {
    if (wrapperStatusEl) {
      wrapperStatusEl.style.background = connected ? '#9ece6a' : '#f7768e';
      wrapperStatusEl.title = connected ? 'Wrapper: connected' : 'Wrapper: disconnected';
    }
  }

  // ── WebSocket connections ──
  let commentWs = null;
  let terminalReconnects = 0;
  let commentReconnects = 0;
  let disconnectTimer = null;
  let serverShutdown = false;

  function startDisconnectTimer() {
    if (disconnectTimer || serverShutdown) return;
    disconnectTimer = setTimeout(() => {
      document.title = 'Disconnected \u2014 closing...';
      window.close();
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-size:1.2em;">Session ended. You can close this tab.</div>';
    }, DISCONNECT_CLOSE_MS);
  }

  function clearDisconnectTimer() {
    if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null; }
  }

  function handleShutdown() {
    serverShutdown = true;
    clearDisconnectTimer();
    window.close();
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-size:1.2em;">Session ended. You can close this tab.</div>';
  }

  function connectTerminalWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsTokenQuery = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
    terminalWs = new WebSocket(`${proto}//${location.host}/ws/terminal${wsTokenQuery}`);
    terminalWs.binaryType = 'arraybuffer';

    terminalWs.onopen = () => {
      wsStatus.style.background = '#9ece6a';
      terminalReconnects = 0;
      clearDisconnectTimer();
    };

    terminalWs.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        if (xterm) xterm.write(new Uint8Array(e.data));
      } else {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'shutdown') { handleShutdown(); return; }
          if (msg.type === 'resize' && xterm) {
            serverCols = msg.cols;
            xterm.resize(msg.cols, msg.rows);
          }
          if (msg.type === 'wrapper_status') {
            updateWrapperStatus(msg.connected);
            if (!msg.connected && msg.exitCode !== undefined) {
              showToast('Wrapper process exited (code ' + msg.exitCode + ')');
            }
          }
        } catch {}
      }
    };

    terminalWs.onclose = () => {
      wsStatus.style.background = '#555';
      if (serverShutdown) return;
      startDisconnectTimer();
      terminalReconnects++;
      if (terminalReconnects <= MAX_RECONNECT) {
        const delay = Math.min(2000 * Math.pow(2, terminalReconnects - 1), 30000);
        setTimeout(connectTerminalWs, delay);
      }
    };

    terminalWs.onerror = () => {
      wsStatus.style.background = '#f7768e';
    };
  }

  function connectCommentWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsTokenQuery = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
    commentWs = new WebSocket(`${proto}//${location.host}/ws/comments${wsTokenQuery}`);

    commentWs.onopen = () => {
      commentReconnects = 0;
    };

    commentWs.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'shutdown') { handleShutdown(); return; }
        if (msg.type === 'comments' && msg.comments) {
          if (msg.batchId && knownBatchIds.has(msg.batchId)) return;
          submitted.push(...msg.comments);
          renderCommentOverlays();
          updateBadge();
        }
      } catch {}
    };

    commentWs.onclose = () => {
      commentReconnects++;
      if (commentReconnects <= MAX_RECONNECT) {
        const delay = Math.min(2000 * Math.pow(2, commentReconnects - 1), 30000);
        setTimeout(connectCommentWs, delay);
      }
    };
  }

  // ── Init ──
  loadingState.remove();
  initXterm();
  connectTerminalWs();
  connectCommentWs();
  updateBadge();
  if (xterm) xterm.focus();
})();
