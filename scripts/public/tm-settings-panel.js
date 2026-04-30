window.TM = window.TM || {};
TM.settingsPanel = (function() {
  const { DEFAULT_SETTINGS } = TM.constants;
  const { clampNum, loadSettings, saveSettings } = TM.settings;
  const { showToast } = TM.utils;

  let ctx = null;
  let currentSettings = loadSettings();

  // DOM elements (queried once in init)
  let settingsBtn, settingsPanel, fontSizeRange, fontSizeValue;
  let lineHeightRange, lineHeightValue, scrollbackInput;
  let colsInput, colsValue, rowsInput, rowsValue, settingsReset;

  function init(context) {
    ctx = context;

    settingsBtn = document.getElementById('settingsBtn');
    settingsPanel = document.getElementById('settingsPanel');
    fontSizeRange = document.getElementById('fontSizeRange');
    fontSizeValue = document.getElementById('fontSizeValue');
    lineHeightRange = document.getElementById('lineHeightRange');
    lineHeightValue = document.getElementById('lineHeightValue');
    scrollbackInput = document.getElementById('scrollbackInput');
    colsInput = document.getElementById('colsInput');
    colsValue = document.getElementById('colsValue');
    rowsInput = document.getElementById('rowsInput');
    rowsValue = document.getElementById('rowsValue');
    settingsReset = document.getElementById('settingsReset');

    syncSettingsUI(currentSettings);
    setupEventListeners();
  }

  function getCurrentSettings() {
    return currentSettings;
  }

  function applySettings(s) {
    const xterm = ctx.state.xterm;
    if (!xterm) return;
    xterm.options.fontSize = s.fontSize;
    xterm.options.lineHeight = s.lineHeight;
    xterm.options.scrollback = s.scrollback;
    if (ctx.state.textViewEnabled) {
      ctx.dom.textViewContainer.style.fontSize = s.fontSize + 'px';
      ctx.dom.textViewContainer.style.lineHeight = String(s.lineHeight);
    }
    ctx.fitTerminal();
    ctx.renderCommentOverlays();
  }

  function syncSettingsUI(s) {
    fontSizeRange.value = s.fontSize;
    fontSizeValue.textContent = s.fontSize;
    lineHeightRange.value = s.lineHeight;
    lineHeightValue.textContent = s.lineHeight;
    scrollbackInput.value = s.scrollback;
  }

  function syncTerminalUI() {
    const xterm = ctx.state.xterm;
    if (!xterm) return;
    colsInput.value = xterm.cols;
    rowsInput.value = xterm.rows;
    updateSizeDisplay();
  }

  function updateSizeDisplay() {
    const xterm = ctx.state.xterm;
    if (!xterm) return;
    colsValue.textContent = xterm.cols;
    rowsValue.textContent = xterm.rows;
  }

  function sendTerminalResize(cols, rows) {
    if (cols < 1 || rows < 1) return;
    fetch('/api/resize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    }).catch(() => {});
  }

  function handleOutsideClick(e) {
    if (settingsPanel.classList.contains('open') &&
        !settingsPanel.contains(e.target) &&
        e.target !== settingsBtn) {
      settingsPanel.classList.remove('open');
    }
  }

  function setupEventListeners() {
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
      currentSettings.cols = v;
      saveSettings(currentSettings);
      sendTerminalResize(v, parseInt(rowsInput.value, 10) || 24);
    });

    rowsInput.addEventListener('change', () => {
      const v = clampNum(parseInt(rowsInput.value, 10) || 24, 1, 200);
      rowsInput.value = v;
      currentSettings.rows = v;
      saveSettings(currentSettings);
      sendTerminalResize(parseInt(colsInput.value, 10) || 80, v);
    });

    settingsReset.addEventListener('click', () => {
      currentSettings = { ...DEFAULT_SETTINGS };
      syncSettingsUI(currentSettings);
      applySettings(currentSettings);
      saveSettings(currentSettings);
      showToast('Settings reset to defaults');
    });
  }

  return { init, getCurrentSettings, syncTerminalUI, updateSizeDisplay, handleOutsideClick };
})();
