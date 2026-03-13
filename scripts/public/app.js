(function() {
  const {
    MAX_SELECTED_TEXT, MAX_SELECTED_TEXT_DISPLAY, MAX_RECONNECT,
    COMMENT_COLORS, SETTINGS_KEY, SHORTCUTS_KEY, DEFAULT_SHORTCUTS,
    SESSION_REFRESH_MS, MOBILE_BREAKPOINT, DEFAULT_SETTINGS, TEXT_VIEW_DEBOUNCE_MS,
  } = TM.constants;

  const urlParams = new URLSearchParams(window.location.search);
  let isMobile = window.innerWidth <= MOBILE_BREAKPOINT;

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

  const { clampNum, loadSettings, saveSettings, loadShortcuts, saveShortcuts } = TM.settings;
  const { showToast, copyToClipboard } = TM.utils;

  // ── Shortcuts ──
  let shortcuts = [];

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
  const connectingOverlay = document.getElementById('connectingOverlay');
  const doneBtn = document.getElementById('doneBtn');
  const floatBtn = document.getElementById('floatBtn');
  const commentPopup = document.getElementById('commentPopup');
  const popupSelected = document.getElementById('popupSelected');
  const popupTextarea = document.getElementById('popupTextarea');
  const popupCancel = document.getElementById('popupCancel');
  const popupSave = document.getElementById('popupSave');
  const popupHeader = document.querySelector('.comment-popup-header');
  const commentBadge = document.getElementById('commentBadge');
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
      const wasAtBottom = xterm.buffer.active.viewportY + xterm.rows >= xterm.buffer.active.length;
      const prevViewportY = xterm.buffer.active.viewportY;
      fitAddon.fit();
      const targetCols = serverCols !== null ? serverCols : xterm.cols;
      if (xterm.cols !== targetCols) {
        xterm.resize(targetCols, xterm.rows);
      }
      // Restore scroll position after all reflows complete
      if (wasAtBottom) {
        xterm.scrollToBottom();
      } else {
        xterm.scrollToLine(prevViewportY);
      }
    } else {
      const targetCols = serverCols !== null ? serverCols : xterm.cols;
      if (xterm.cols !== targetCols) {
        xterm.resize(targetCols, xterm.rows);
      }
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
    let resizeDebounce = null;
    new ResizeObserver(() => {
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(() => {
        fitTerminal();
        renderCommentOverlays();
      }, 50);
    }).observe(terminalPanel);

    // Ctrl+C with selection → clipboard copy (instead of SIGINT)
    // Cache selection text to handle Windows where getSelection() may return
    // empty during Ctrl key processing before the C keydown fires.
    let cachedSelectionText = '';
    let clearCacheTimer = null;

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
            xterm.focus();
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

    // Init comment renderers with DOM elements
    TM.comments.initRenderers(xtermContainer);
    renderGutterMarkers = TM.comments.renderGutterMarkers;
    renderInlineComments = TM.comments.renderInlineComments;
    renderCommentOverlays = TM.comments.renderCommentOverlays;

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

  document.addEventListener('mousedown', (e) => {
    TM.comments.handleOutsideClick(e);
    if (settingsPanel.classList.contains('open') &&
        !settingsPanel.contains(e.target) &&
        e.target !== settingsBtn) {
      settingsPanel.classList.remove('open');
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

  // ── Init modules ──
  TM.comments.init({
    state: {
      get comments() { return comments; },
      set comments(v) { comments = v; },
      get submitted() { return submitted; },
      get xterm() { return xterm; },
      get pendingSelection() { return pendingSelection; },
      set pendingSelection(v) { pendingSelection = v; },
      get activeComment() { return activeComment; },
      set activeComment(v) { activeComment = v; },
      get editingCommentId() { return editingCommentId; },
      set editingCommentId(v) { editingCommentId = v; },
      get expandedCommentId() { return expandedCommentId; },
      set expandedCommentId(v) { expandedCommentId = v; },
      get nextCommentId() { return nextCommentId; },
      set nextCommentId(v) { nextCommentId = v; },
      get knownBatchIds() { return knownBatchIds; },
      get terminalWs() { return terminalWs; },
      get currentSessionPid() { return currentSessionPid; },
      get isMobile() { return isMobile; },
    },
    dom: {
      xtermContainer, terminalPanel, commentPopup, popupSelected,
      popupTextarea, popupCancel, popupSave, popupHeader, commentBadge,
      floatBtn, messageInput, sendSubmitBtn, doneBtn,
    },
  });

  TM.websocket.init({
    state: {
      get xterm() { return xterm; },
      get terminalWs() { return terminalWs; },
      set terminalWs(v) { terminalWs = v; },
      get currentSessionPid() { return currentSessionPid; },
      get serverCols() { return serverCols; },
      set serverCols(v) { serverCols = v; },
      get knownBatchIds() { return knownBatchIds; },
      get submitted() { return submitted; },
    },
    fitTerminal,
    syncTerminalUI,
    updateWrapperStatus,
    showToast,
    refreshSessions: () => TM.sessions.refreshSessions(),
    switchToSession: (pid) => TM.sessions.switchToSession(pid),
    renderCommentOverlays: () => renderCommentOverlays(),
    updateBadge: () => TM.comments.updateBadge(),
    scheduleTextViewUpdate,
    clearSessionRefreshTimer() {
      if (sessionRefreshTimer) { clearInterval(sessionRefreshTimer); sessionRefreshTimer = null; }
    },
    dom: { wsStatus, connectingOverlay },
  });

  TM.sessions.init({
    state: {
      get currentSessionPid() { return currentSessionPid; },
      set currentSessionPid(v) { currentSessionPid = v; },
      get xterm() { return xterm; },
      get serverCols() { return serverCols; },
      set serverCols(v) { serverCols = v; },
      get comments() { return comments; },
      set comments(v) { comments = v; },
      get submitted() { return submitted; },
      set submitted(v) { submitted = v; },
      get knownBatchIds() { return knownBatchIds; },
      get expandedCommentId() { return expandedCommentId; },
      set expandedCommentId(v) { expandedCommentId = v; },
      get textViewEnabled() { return textViewEnabled; },
    },
    renderCommentOverlays: () => renderCommentOverlays(),
    updateBadge: () => TM.comments.updateBadge(),
    dom: { sessionTabsInner, connectingOverlay, messageInput, textViewContainer },
  });

  // ── Init ──
  loadingState.remove();
  initXterm();
  TM.comments.updateBadge();
  renderShortcutBar();

  // Fetch sessions and auto-connect
  TM.sessions.refreshSessions().then(() => {
    if (xterm) xterm.focus();
  });

  // Periodic session list refresh
  sessionRefreshTimer = setInterval(() => TM.sessions.refreshSessions(), SESSION_REFRESH_MS);
})();
