window.TM = window.TM || {};
TM.constants = {
  MAX_SELECTED_TEXT: 500,
  MAX_SELECTED_TEXT_DISPLAY: 80,
  MAX_RECONNECT: 5,
  COMMENT_COLORS: ['#ff9e64', '#7aa2f7', '#9ece6a', '#bb9af7', '#7dcfff'],
  SHORTCUTS_KEY: 'terminal-mirror-shortcuts',
  DEFAULT_SHORTCUTS: [
    { id: 'esc',       label: 'ESC',       data: '\x1b',   sendEnter: false, type: 'builtin', hidden: false },
    { id: 'ctrl-c',    label: 'Ctrl+C',    data: '\x03',   sendEnter: false, type: 'builtin', hidden: false },
    { id: 'ctrl-d',    label: 'Ctrl+D',    data: '\x04',   sendEnter: false, type: 'builtin', hidden: false },
    { id: 'ctrl-o',    label: 'Ctrl+O',    data: '\x0f',   sendEnter: false, type: 'builtin', hidden: false },
    { id: 'tab',       label: 'Tab',       data: '\t',     sendEnter: false, type: 'builtin', hidden: false },
    { id: 'shift-tab', label: 'Shift+Tab', data: '\x1b[Z', sendEnter: false, type: 'builtin', hidden: false },
    { id: 'arrow-up',  label: '\u2191',        data: '\x1b[A', sendEnter: false, type: 'builtin', hidden: false },
    { id: 'arrow-down',label: '\u2193',        data: '\x1b[B', sendEnter: false, type: 'builtin', hidden: false },
    { id: 'enter',     label: 'Enter',     data: '\r',     sendEnter: false, type: 'builtin', hidden: false },
  ],
  SESSION_REFRESH_MS: 5000,
  MOBILE_BREAKPOINT: 768,
  DEFAULT_SETTINGS: (function() {
    const s = window.TM_SERVER_SETTINGS || {};
    return {
      fontSize: s.fontSize ?? 14,
      lineHeight: s.lineHeight ?? 1.4,
      scrollback: s.scrollback ?? 50000,
    };
  })(),
  TEXT_VIEW_DEBOUNCE_MS: 80,
};
