window.TM = window.TM || {};
TM.settings = (function() {
  const { SHORTCUTS_KEY, DEFAULT_SHORTCUTS, DEFAULT_SETTINGS } = TM.constants;

  function clampNum(val, min, max) { return Math.min(max, Math.max(min, val)); }

  function loadSettings() {
    return { ...DEFAULT_SETTINGS };
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

  return { clampNum, loadSettings, loadShortcuts, saveShortcuts };
})();
