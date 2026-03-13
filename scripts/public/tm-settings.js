window.TM = window.TM || {};
TM.settings = (function() {
  const { SETTINGS_KEY, SHORTCUTS_KEY, DEFAULT_SHORTCUTS, DEFAULT_SETTINGS } = TM.constants;

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

  return { clampNum, loadSettings, saveSettings, loadShortcuts, saveShortcuts };
})();
