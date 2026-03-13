window.TM = window.TM || {};
TM.shortcuts = (function() {
  const { loadShortcuts, saveShortcuts } = TM.settings;

  let ctx = null;
  let shortcuts = [];

  function init(context) {
    ctx = context;
    shortcuts = loadShortcuts();
    setupEventListeners();
  }

  function renderShortcutBar() {
    ctx.dom.shortcutBarInner.innerHTML = '';
    const visible = shortcuts.filter(s => !s.hidden);
    const customs = visible.filter(s => s.type === 'custom');
    const builtins = visible.filter(s => s.type === 'builtin');
    customs.concat(builtins).forEach(sc => {
      const btn = document.createElement('button');
      btn.className = 'shortcut-btn' + (sc.type === 'custom' ? ' custom' : '');
      btn.textContent = sc.label;
      btn.addEventListener('click', () => sendShortcut(sc));
      ctx.dom.shortcutBarInner.appendChild(btn);
    });
  }

  function sendShortcut(sc) {
    const ws = ctx.state.terminalWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input', data: sc.data }));
    if (sc.sendEnter) {
      setTimeout(() => {
        const ws2 = ctx.state.terminalWs;
        if (ws2 && ws2.readyState === WebSocket.OPEN) {
          ws2.send(JSON.stringify({ type: 'input', data: '\r' }));
        }
      }, 50);
    }
  }

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
        const xterm = ctx.state.xterm;
        if (xterm) xterm.focus();
      }
    });
  }

  function setupEventListeners() {
    document.getElementById('shortcutBar').addEventListener('mousedown', e => e.preventDefault());
    ctx.dom.shortcutEditBtn.addEventListener('click', openShortcutEditor);
  }

  return { init, renderShortcutBar };
})();
