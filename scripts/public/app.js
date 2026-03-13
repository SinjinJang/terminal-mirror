(function() {
  const urlParams = new URLSearchParams(window.location.search);

  // ── Constants ──
  const MAX_SELECTED_TEXT = 500;
  const MAX_SELECTED_TEXT_DISPLAY = 80;
  const MAX_RECONNECT = 5;
  const COMMENT_COLORS = ['#ff9e64', '#7aa2f7', '#9ece6a', '#bb9af7', '#7dcfff'];
  const SETTINGS_KEY = 'terminal-mirror-settings';
  const SHORTCUTS_KEY = 'terminal-mirror-shortcuts';
  const DEFAULT_SHORTCUTS = [
    { id: 'esc',       label: 'ESC',       data: '\x1b',   sendEnter: false, type: 'builtin', hidden: false },
    { id: 'ctrl-c',    label: 'Ctrl+C',    data: '\x03',   sendEnter: false, type: 'builtin', hidden: false },
    { id: 'ctrl-d',    label: 'Ctrl+D',    data: '\x04',   sendEnter: false, type: 'builtin', hidden: false },
    { id: 'ctrl-o',    label: 'Ctrl+O',    data: '\x0f',   sendEnter: false, type: 'builtin', hidden: false },
    { id: 'tab',       label: 'Tab',       data: '\t',     sendEnter: false, type: 'builtin', hidden: false },
    { id: 'shift-tab', label: 'Shift+Tab', data: '\x1b[Z', sendEnter: false, type: 'builtin', hidden: false },
    { id: 'arrow-up',  label: '\u2191',        data: '\x1b[A', sendEnter: false, type: 'builtin', hidden: false },
    { id: 'arrow-down',label: '\u2193',        data: '\x1b[B', sendEnter: false, type: 'builtin', hidden: false },
    { id: 'enter',     label: 'Enter',     data: '\r',     sendEnter: false, type: 'builtin', hidden: false },
  ];
  const SESSION_REFRESH_MS = 5000;
  const MOBILE_BREAKPOINT = 768;
  let isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
  const DEFAULT_SETTINGS = { fontSize: isMobile ? 14 : 13, lineHeight: 1.4, scrollback: 50000 };

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

  // ── Session state ──
  let currentSessionPid = null;
  let sessionRefreshTimer = null;

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

  // ── Shortcuts ──
  let shortcuts = [];

  function loadShortcuts() {
    let saved = [];
    try {
      const raw = localStorage.getItem(SHORTCUTS_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch {}
    // Merge: builtin items use defaults but keep saved hidden state
    const savedMap = {};
    saved.forEach(s => { savedMap[s.id] = s; });
    const result = DEFAULT_SHORTCUTS.map(d => ({
      ...d,
      hidden: savedMap[d.id] ? savedMap[d.id].hidden : d.hidden,
    }));
    // Append custom items
    saved.filter(s => s.type === 'custom').forEach(s => result.push(s));
    return result;
  }

  function saveShortcuts(sc) {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(sc));
  }

  function applySettings(s) {
    if (!xterm) return;
    xterm.options.fontSize = s.fontSize;
    xterm.options.lineHeight = s.lineHeight;
    xterm.options.scrollback = s.scrollback;
    if (textViewEnabled) {
      textViewContainer.style.fontSize = s.fontSize + 'px';
      textViewContainer.style.lineHeight = String(s.lineHeight);
    }
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
  const textViewContainer = document.getElementById('textViewContainer');
  const toggleViewBtn = document.getElementById('toggleViewBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const fontSizeRange = document.getElementById('fontSizeRange');
  const fontSizeValue = document.getElementById('fontSizeValue');
  const lineHeightRange = document.getElementById('lineHeightRange');
  const lineHeightValue = document.getElementById('lineHeightValue');
  const scrollbackInput = document.getElementById('scrollbackInput');
  const colsInput = document.getElementById('colsInput');
  const colsValue = document.getElementById('colsValue');
  const settingsReset = document.getElementById('settingsReset');
  const sessionTabsInner = document.getElementById('sessionTabsInner');
  const shortcutBarInner = document.getElementById('shortcutBarInner');
  const shortcutEditBtn = document.getElementById('shortcutEditBtn');

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
    if (!textViewEnabled) {
      fitAddon.fit();
    }
    const targetCols = serverCols !== null ? serverCols : xterm.cols;
    if (xterm.cols !== targetCols) {
      xterm.resize(targetCols, xterm.rows);
    }
    updateSizeDisplay();
  }

  function sendTerminalResize(cols) {
    if (!terminalWs || terminalWs.readyState !== WebSocket.OPEN) return;
    if (cols < 1) return;
    terminalWs.send(JSON.stringify({ type: 'resize', cols }));
  }

  function updateSizeDisplay() {
    if (!xterm) return;
    colsValue.textContent = xterm.cols;
  }

  // ── Text view mode (mobile) ──
  let textViewEnabled = false;
  let textViewUpdateTimer = null;
  const TEXT_VIEW_DEBOUNCE_MS = 80;

  function extractBufferText() {
    if (!xterm) return [];
    const buf = xterm.buffer.active;

    const logical = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) { logical.push(''); continue; }
      logical.push(line.translateToString(true));
    }

    // Trim trailing empty lines
    while (logical.length > 0 && logical[logical.length - 1] === '') {
      logical.pop();
    }

    // Collapse consecutive empty lines and deduplicate consecutive identical lines
    const result = [];
    let prevEmpty = false;
    let prevText = null;
    for (let i = 0; i < logical.length; i++) {
      const text = logical[i];
      const isEmpty = text === '';
      if (isEmpty && prevEmpty) continue;
      if (!isEmpty && text === prevText) continue;
      result.push(text);
      prevEmpty = isEmpty;
      prevText = text;
    }

    return result;
  }

  function scheduleTextViewUpdate() {
    if (!textViewEnabled) return;
    if (textViewUpdateTimer) return; // already scheduled
    textViewUpdateTimer = setTimeout(() => {
      textViewUpdateTimer = null;
      renderTextView();
    }, TEXT_VIEW_DEBOUNCE_MS);
  }

  function renderTextView() {
    if (!textViewEnabled || !xterm) return;
    const lines = extractBufferText();
    const wasAtBottom = textViewContainer.scrollHeight - textViewContainer.scrollTop - textViewContainer.clientHeight < 30;

    const fragment = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const div = document.createElement('div');
      if (lines[i] === '') {
        div.className = 'tv-line tv-empty';
      } else {
        div.className = 'tv-line';
        div.textContent = lines[i];
      }
      fragment.appendChild(div);
    }
    textViewContainer.innerHTML = '';
    textViewContainer.appendChild(fragment);

    if (wasAtBottom) {
      textViewContainer.scrollTop = textViewContainer.scrollHeight;
    }
  }

  function setTextViewMode(enabled) {
    textViewEnabled = enabled;
    toggleViewBtn.classList.toggle('active', enabled);
    if (enabled) {
      xtermContainer.style.display = 'none';
      textViewContainer.style.display = 'block';
      renderTextView();
    } else {
      textViewContainer.style.display = 'none';
      xtermContainer.style.display = 'block';
      fitTerminal();
    }
  }

  function initXterm() {
    xterm = new window.Terminal({
      theme: {
        background: '#0a0a0a',
        foreground: '#e4e4e4',
        cursor: '#e4e4e4',
        selectionBackground: 'rgba(122, 162, 247, 0.3)',
      },
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace",
      fontSize: currentSettings.fontSize,
      lineHeight: currentSettings.lineHeight,
      scrollback: currentSettings.scrollback,
      convertEol: false,
      disableStdin: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 1,
    });

    fitAddon = new window.FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);

    xtermContainer.style.display = 'block';
    xterm.open(xtermContainer);
    fitTerminal();

    // Toggle view button
    toggleViewBtn.addEventListener('click', () => {
      setTextViewMode(!textViewEnabled);
    });

    // Auto-enable text view on mobile
    if (isMobile) setTextViewMode(true);

    window.addEventListener('resize', () => {
      const wasMobile = isMobile;
      isMobile = window.innerWidth <= MOBILE_BREAKPOINT;
      if (isMobile && !wasMobile) setTextViewMode(true);
      fitTerminal();
      renderCommentOverlays();
    });
    new ResizeObserver(() => {
      fitTerminal();
      renderCommentOverlays();
    }).observe(terminalPanel);

    // Ctrl+C with selection → clipboard copy (instead of SIGINT)
    // Cache selection text to handle Windows where getSelection() may return
    // empty during Ctrl key processing before the C keydown fires.
    let cachedSelectionText = '';
    let clearCacheTimer = null;

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
    function updateSelectionCache(text) {
      if (clearCacheTimer) { clearTimeout(clearCacheTimer); clearCacheTimer = null; }
      if (text) {
        cachedSelectionText = text;
      } else {
        // Delay clearing so Ctrl+C handler can still use the cached value
        clearCacheTimer = setTimeout(() => { cachedSelectionText = ''; }, 300);
      }
    }
    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.ctrlKey && ev.type === 'keydown') {
        if (ev.key === 'c' || ev.key === 'C' || ev.code === 'KeyC') {
          const sel = xterm.getSelection() || cachedSelectionText;
          if (sel) {
            copyToClipboard(sel);
            xterm.clearSelection();
            cachedSelectionText = '';
            if (clearCacheTimer) { clearTimeout(clearCacheTimer); clearCacheTimer = null; }
            return false;
          }
        }
        if (ev.key === 'v' || ev.key === 'V' || ev.code === 'KeyV') {
          return false;
        }
      }
      return true;
    });

    // Keyboard input → WebSocket → PTY
    // Deduplicate rapid-fire IME events (mobile virtual keyboards can fire
    // both composition and input events for the same keystroke)
    let lastInputData = '';
    let lastInputTs = 0;
    xterm.onData((data) => {
      const now = performance.now();
      if (data === lastInputData && now - lastInputTs < 15) return;
      lastInputData = data;
      lastInputTs = now;
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
      updateSelectionCache(text);
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
      if (isMobile) return;
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
      if (isMobile) return;
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
      let isAtBottom;
      if (textViewEnabled) {
        isAtBottom = textViewContainer.scrollHeight - textViewContainer.scrollTop - textViewContainer.clientHeight < 30;
      } else {
        isAtBottom = xterm.buffer.active.viewportY + xterm.rows >= xterm.buffer.active.length;
      }
      if (isAtBottom) {
        scrollBottomBtn.classList.remove('visible');
      } else {
        scrollBottomBtn.classList.add('visible');
      }
    }

    scrollBottomBtn.addEventListener('click', () => {
      if (textViewEnabled) {
        textViewContainer.scrollTop = textViewContainer.scrollHeight;
      } else {
        xterm.scrollToBottom();
      }
    });

    textViewContainer.addEventListener('scroll', () => {
      updateScrollBottomBtn();
    });

    xtermContainer.addEventListener('wheel', () => {
      requestAnimationFrame(() => {
        if (!isMobile) renderCommentOverlays();
        updateScrollBottomBtn();
      });
    });

    xterm.onScroll(() => {
      if (!isMobile) renderCommentOverlays();
      updateScrollBottomBtn();
    });
    let gutterDebounce = null;
    xterm.onWriteParsed(() => {
      if (!isMobile) {
        clearTimeout(gutterDebounce);
        gutterDebounce = setTimeout(renderCommentOverlays, 100);
      }
      updateScrollBottomBtn();
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
    if (isMobile) {
      commentPopup.style.left = '12px';
      commentPopup.style.top = `${Math.max(10, r.top + 20)}px`;
    } else {
      commentPopup.style.left = `${Math.max(10, r.left + (r.width - 320) / 2)}px`;
      commentPopup.style.top = `${Math.max(10, r.top + (r.height - 220) / 2)}px`;
    }
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
    if (knownBatchIds.size > 200) {
      const first = knownBatchIds.values().next().value;
      knownBatchIds.delete(first);
    }

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
      }, 350);
    }

    const sessionQuery = currentSessionPid ? `?session=${currentSessionPid}` : '';
    fetch(`/api/submit${sessionQuery}`, {
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
    if (!confirm('Close the mirror server?')) return;
    try { await fetch('/api/done', { method: 'POST' }); } catch {}
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

  function syncTerminalUI() {
    if (!xterm) return;
    colsInput.value = xterm.cols;
    updateSizeDisplay();
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

  colsInput.addEventListener('change', () => {
    const v = clampNum(parseInt(colsInput.value, 10) || 80, 1, 400);
    colsInput.value = v;
    sendTerminalResize(v);
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

  // ── Session management ──
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

  let spawnEnabled = false;

  async function fetchSessions() {
    try {
      const resp = await fetch('/api/sessions');
      if (!resp.ok) return [];
      const data = await resp.json();
      if (Array.isArray(data)) return data; // backward compat
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

  let renamingTabPid = null;
  let lastSessionsKey = '';

  function updateSessionTabs(sessionsList) {
    if (renamingTabPid !== null) return;
    const key = sessionsList.map(s => `${s.pid}:${s.connected}:${s.label || ''}`).join('|');
    if (key === lastSessionsKey) return;
    lastSessionsKey = key;
    sessionTabsInner.innerHTML = '';

    if (sessionsList.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'session-no-tabs';
      empty.textContent = 'No sessions';
      sessionTabsInner.appendChild(empty);
      return;
    }

    for (const s of sessionsList) {
      const tab = document.createElement('button');
      tab.className = 'session-tab';
      tab.dataset.pid = String(s.pid);
      if (currentSessionPid === s.pid) tab.classList.add('active');
      if (!s.connected) tab.classList.add('disconnected');

      const dot = document.createElement('span');
      dot.className = 'session-tab-dot';
      tab.appendChild(dot);

      const label = document.createElement('span');
      label.className = 'session-tab-label';
      label.textContent = formatSessionLabel(s);
      tab.appendChild(label);

      tab.addEventListener('click', () => {
        const pid = parseInt(tab.dataset.pid, 10);
        if (!isNaN(pid)) switchToSession(pid);
        if (xterm) xterm.focus();
      });

      tab.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        startTabRename(tab, s);
      });

      tab.title = `${s.cmd || 'unknown'}\n${s.cwd || ''}\nDouble-click to rename`;

      sessionTabsInner.appendChild(tab);
    }

    // Scroll active tab into view
    const activeTab = sessionTabsInner.querySelector('.session-tab.active');
    if (activeTab) activeTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function startTabRename(tab, session) {
    const labelEl = tab.querySelector('.session-tab-label');
    if (!labelEl || tab.querySelector('.session-tab-label-input')) return;

    renamingTabPid = session.pid;

    const input = document.createElement('input');
    input.className = 'session-tab-label-input';
    input.value = session.label || '';
    input.placeholder = formatSessionLabel({ ...session, label: null });

    labelEl.style.display = 'none';
    tab.insertBefore(input, labelEl.nextSibling);
    input.focus();
    input.select();

    function finish() {
      if (renamingTabPid !== session.pid) return;
      renamingTabPid = null;
      const newLabel = input.value.trim();
      input.remove();
      labelEl.style.display = '';

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
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = session.label || ''; input.blur(); }
    });
  }

  async function refreshSessions() {
    const sessionsList = await fetchSessions();
    updateSessionTabs(sessionsList);

    // If we have no current session, auto-select
    if (!currentSessionPid && sessionsList.length > 0) {
      const urlSession = getSessionFromUrl();
      const target = urlSession && sessionsList.some(s => s.pid === urlSession)
        ? urlSession
        : sessionsList[0].pid;
      switchToSession(target);
    }

    return sessionsList;
  }

  function switchToSession(pid) {
    if (pid === currentSessionPid) return;

    // Close current WebSocket connections
    if (terminalWs) {
      terminalWs.onclose = null; // prevent reconnect
      terminalWs.close();
      terminalWs = null;
    }
    if (commentWs) {
      commentWs.onclose = null;
      commentWs.close();
      commentWs = null;
    }

    // Reset terminal state
    if (xterm) {
      xterm.reset();
      xterm.clear();
    }
    serverCols = null;
    textViewContainer.innerHTML = '';

    // Clear per-session state
    comments = [];
    submitted = [];
    knownBatchIds.clear();
    expandedCommentId = null;
    renderCommentOverlays();
    updateBadge();

    // Update state
    currentSessionPid = pid;
    updateUrlSession(pid);

    // Highlight active tab
    for (const tab of sessionTabsInner.querySelectorAll('.session-tab')) {
      tab.classList.toggle('active', tab.dataset.pid === String(pid));
    }

    // Reset reconnect counters
    terminalReconnects = 0;
    commentReconnects = 0;
    serverShutdown = false;

    // Connect to new session
    connectTerminalWs();
    connectCommentWs();
  }

  document.getElementById('refreshSessionsBtn').addEventListener('click', async function () {
    const btn = this;
    btn.classList.add('spinning');
    await refreshSessions();
    setTimeout(() => btn.classList.remove('spinning'), 600);
  });

  function updateSpawnButton() {
    const btn = document.getElementById('spawnSessionBtn');
    if (btn) btn.style.display = spawnEnabled ? '' : 'none';
  }

  document.getElementById('spawnSessionBtn').addEventListener('click', async function () {
    const btn = this;
    btn.disabled = true;
    try {
      const resp = await fetch('/api/spawn', { method: 'POST' });
      if (resp.ok) {
        const { pid } = await resp.json();
        // Wait for wrapper to initialize, then refresh and switch
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


  // ── WebSocket connections ──
  let commentWs = null;
  let terminalReconnects = 0;
  let commentReconnects = 0;
  let serverShutdown = false;

  function handleShutdown() {
    serverShutdown = true;
    if (sessionRefreshTimer) { clearInterval(sessionRefreshTimer); sessionRefreshTimer = null; }
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-size:1.2em;">Server stopped. You can close this tab.</div>';
  }

  // Batch binary writes per animation frame to avoid cursor flicker.
  // Kept outside connectTerminalWs so reconnects can cancel pending RAF.
  let writeBuf = [];
  let writeRaf = null;
  function flushWrites() {
    writeRaf = null;
    if (!xterm || writeBuf.length === 0) return;
    if (writeBuf.length === 1) {
      xterm.write(writeBuf[0]);
    } else {
      let len = 0;
      for (const c of writeBuf) len += c.length;
      const combined = new Uint8Array(len);
      let off = 0;
      for (const c of writeBuf) { combined.set(c, off); off += c.length; }
      xterm.write(combined);
    }
    writeBuf = [];
    scheduleTextViewUpdate();
  }
  function cancelPendingWrites() {
    if (writeRaf) { cancelAnimationFrame(writeRaf); writeRaf = null; }
    writeBuf = [];
  }

  function connectTerminalWs() {
    if (!currentSessionPid) return;
    if (terminalWs) {
      terminalWs.onclose = null;
      terminalWs.close();
      terminalWs = null;
    }
    cancelPendingWrites();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ session: String(currentSessionPid) });
    terminalWs = new WebSocket(`${proto}//${location.host}/ws/terminal?${params.toString()}`);
    terminalWs.binaryType = 'arraybuffer';

    terminalWs.onopen = () => {
      wsStatus.style.background = '#9ece6a';
      terminalReconnects = 0;
    };

    terminalWs.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        if (xterm) {
          // Skip batching when tab is hidden (RAF won't fire).
          // Flush pending buffer first to preserve data ordering.
          if (document.hidden) {
            if (writeBuf.length > 0) flushWrites();
            xterm.write(new Uint8Array(e.data));
            scheduleTextViewUpdate();
          } else {
            writeBuf.push(new Uint8Array(e.data));
            if (!writeRaf) writeRaf = requestAnimationFrame(flushWrites);
          }
        }
      } else {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'shutdown') { handleShutdown(); return; }
          if (msg.type === 'resize' && xterm) {
            serverCols = msg.cols;
            fitTerminal();
            syncTerminalUI();
          }
          if (msg.type === 'wrapper_status') {
            updateWrapperStatus(msg.connected);
            if (!msg.connected && msg.exitCode !== undefined) {
              showToast('Wrapper process exited (code ' + msg.exitCode + ')');
              if (xterm) { xterm.reset(); xterm.clear(); }
              // Auto-switch to another session after brief delay for server cleanup
              setTimeout(async () => {
                const sessions = await refreshSessions();
                const other = sessions.find(s => s.pid !== currentSessionPid);
                if (other) switchToSession(other.pid);
              }, 1000);
            }
          }
        } catch {}
      }
    };

    const sessionPidAtConnect = currentSessionPid;
    terminalWs.onclose = () => {
      flushWrites();
      wsStatus.style.background = '#555';
      if (serverShutdown) return;
      // Only reconnect if we're still on the same session
      if (currentSessionPid !== sessionPidAtConnect) return;
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
    if (!currentSessionPid) return;
    if (commentWs) {
      commentWs.onclose = null;
      commentWs.close();
      commentWs = null;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ session: String(currentSessionPid) });
    commentWs = new WebSocket(`${proto}//${location.host}/ws/comments?${params.toString()}`);

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

    const sessionPidAtConnect = currentSessionPid;
    commentWs.onclose = () => {
      if (currentSessionPid !== sessionPidAtConnect) return;
      commentReconnects++;
      if (commentReconnects <= MAX_RECONNECT) {
        const delay = Math.min(2000 * Math.pow(2, commentReconnects - 1), 30000);
        setTimeout(connectCommentWs, delay);
      }
    };
  }

  // ── Shortcut bar ──
  shortcuts = loadShortcuts();

  function renderShortcutBar() {
    shortcutBarInner.innerHTML = '';
    const visible = shortcuts.filter(s => !s.hidden);
    const customs = visible.filter(s => s.type === 'custom');
    const builtins = visible.filter(s => s.type === 'builtin');
    customs.concat(builtins).forEach(sc => {
      const btn = document.createElement('button');
      btn.className = 'shortcut-btn' + (sc.type === 'custom' ? ' custom' : '');
      btn.textContent = sc.label;
      btn.addEventListener('click', () => sendShortcut(sc));
      shortcutBarInner.appendChild(btn);
    });
  }

  function sendShortcut(sc) {
    if (!terminalWs || terminalWs.readyState !== WebSocket.OPEN) return;
    terminalWs.send(JSON.stringify({ type: 'input', data: sc.data }));
    if (sc.sendEnter) {
      setTimeout(() => {
        if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
          terminalWs.send(JSON.stringify({ type: 'input', data: '\r' }));
        }
      }, 50);
    }
  }

  // Prevent shortcut bar clicks from stealing xterm focus
  document.getElementById('shortcutBar').addEventListener('mousedown', e => e.preventDefault());

  function openShortcutEditor() {
    const overlay = document.createElement('div');
    overlay.className = 'shortcut-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'shortcut-modal';

    function render() {
      modal.innerHTML = '';
      const title = document.createElement('div');
      title.className = 'shortcut-modal-title';
      title.textContent = 'Edit Shortcuts';
      modal.appendChild(title);

      // Custom section
      const customs = shortcuts.filter(s => s.type === 'custom');
      if (customs.length > 0) {
        const customLabel = document.createElement('div');
        customLabel.className = 'shortcut-modal-section';
        customLabel.textContent = 'Custom';
        modal.appendChild(customLabel);

        customs.forEach(sc => {
          const item = document.createElement('div');
          item.className = 'shortcut-modal-item';
          const label = document.createElement('span');
          label.className = 'shortcut-modal-item-label';
          label.textContent = sc.label + (sc.sendEnter ? ' \u23ce' : '');
          const actions = document.createElement('div');
          actions.className = 'shortcut-modal-item-actions';

          const editBtn = document.createElement('button');
          editBtn.className = 'shortcut-modal-item-btn';
          editBtn.textContent = 'Edit';
          editBtn.addEventListener('click', () => {
            const newLabel = prompt('Label:', sc.label);
            if (newLabel === null) return;
            const newData = prompt('Command text:', sc.data);
            if (newData === null) return;
            sc.label = newLabel || sc.label;
            sc.data = newData || sc.data;
            saveShortcuts(shortcuts);
            renderShortcutBar();
            render();
          });

          const delBtn = document.createElement('button');
          delBtn.className = 'shortcut-modal-item-btn delete';
          delBtn.textContent = 'Del';
          delBtn.addEventListener('click', () => {
            shortcuts = shortcuts.filter(s => s.id !== sc.id);
            saveShortcuts(shortcuts);
            renderShortcutBar();
            render();
          });

          const toggle = createToggle(!sc.hidden, checked => {
            sc.hidden = !checked;
            saveShortcuts(shortcuts);
            renderShortcutBar();
          });

          actions.appendChild(editBtn);
          actions.appendChild(delBtn);
          actions.appendChild(toggle);
          item.appendChild(label);
          item.appendChild(actions);
          modal.appendChild(item);
        });
      }

      // Builtin section
      const builtinLabel = document.createElement('div');
      builtinLabel.className = 'shortcut-modal-section';
      builtinLabel.textContent = 'Built-in';
      modal.appendChild(builtinLabel);

      shortcuts.filter(s => s.type === 'builtin').forEach(sc => {
        const item = document.createElement('div');
        item.className = 'shortcut-modal-item';
        const label = document.createElement('span');
        label.className = 'shortcut-modal-item-label';
        label.textContent = sc.label;
        const actions = document.createElement('div');
        actions.className = 'shortcut-modal-item-actions';
        const toggle = createToggle(!sc.hidden, checked => {
          sc.hidden = !checked;
          saveShortcuts(shortcuts);
          renderShortcutBar();
        });
        actions.appendChild(toggle);
        item.appendChild(label);
        item.appendChild(actions);
        modal.appendChild(item);
      });

      // Add form
      const form = document.createElement('div');
      form.className = 'shortcut-add-form';
      form.innerHTML =
        '<input type="text" placeholder="Label (e.g. ls)" id="scAddLabel">' +
        '<input type="text" placeholder="Command text (e.g. ls -la)" id="scAddData">' +
        '<div class="shortcut-add-form-row">' +
          '<label><input type="checkbox" id="scAddEnter" checked> Send Enter</label>' +
          '<button class="popup-btn save" id="scAddBtn">Add</button>' +
        '</div>';
      modal.appendChild(form);

      modal.querySelector('#scAddBtn').addEventListener('click', () => {
        const labelVal = modal.querySelector('#scAddLabel').value.trim();
        const dataVal = modal.querySelector('#scAddData').value;
        if (!labelVal || !dataVal) return;
        const enterVal = modal.querySelector('#scAddEnter').checked;
        shortcuts.push({
          id: 'custom-' + Date.now(),
          label: labelVal,
          data: dataVal,
          sendEnter: enterVal,
          type: 'custom',
          hidden: false,
        });
        saveShortcuts(shortcuts);
        renderShortcutBar();
        render();
      });
    }

    function createToggle(checked, onChange) {
      const wrapper = document.createElement('label');
      wrapper.className = 'shortcut-toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      const slider = document.createElement('span');
      slider.className = 'shortcut-toggle-slider';
      wrapper.appendChild(input);
      wrapper.appendChild(slider);
      return wrapper;
    }

    render();
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        overlay.remove();
        if (xterm) xterm.focus();
      }
    });
  }

  shortcutEditBtn.addEventListener('click', openShortcutEditor);

  // ── Init ──
  loadingState.remove();
  initXterm();
  updateBadge();
  renderShortcutBar();

  // Fetch sessions and auto-connect
  refreshSessions().then(() => {
    if (xterm) xterm.focus();
  });

  // Periodic session list refresh
  sessionRefreshTimer = setInterval(refreshSessions, SESSION_REFRESH_MS);
})();
