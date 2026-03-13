window.TM = window.TM || {};
TM.comments = (function() {
  const { MAX_SELECTED_TEXT, MAX_SELECTED_TEXT_DISPLAY, COMMENT_COLORS } = TM.constants;
  const { showToast } = TM.utils;

  let ctx = null;
  let gutterMarkersEl = null;
  let inlineCommentsEl = null;

  function init(context) {
    ctx = context;
    setupEventListeners();
  }

  // Called after initXterm creates the DOM elements
  function initRenderers(xtermContainer) {
    gutterMarkersEl = xtermContainer.querySelector('.gutter-markers');
    inlineCommentsEl = xtermContainer.querySelector('.inline-comments');
  }

  // ── Render functions ──
  function getCommentLayoutData() {
    const comments = ctx.state.comments;
    const submitted = ctx.state.submitted;
    const xterm = ctx.state.xterm;
    const allComments = [
      ...comments.map((c, i) => ({ ...c, _submitted: false, _ci: i })),
      ...submitted.map(c => ({ ...c, _submitted: true, _ci: 0 })),
    ];
    const withRows = allComments.filter(c => c.startRow != null);
    if (withRows.length === 0) return null;

    const viewportY = xterm.buffer.active.viewportY;
    const rows = xterm.rows;
    const xtermContainer = ctx.dom.xtermContainer;
    const screen = xtermContainer.querySelector('.xterm-screen');
    if (!screen) return null;
    const containerRect = xtermContainer.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const ch = screen.clientHeight / rows;

    return { allComments: withRows, viewportY, rows, containerRect, screenRect, ch };
  }

  function renderGutterMarkers() {
    if (ctx.state.isMobile) return;
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
        ctx.state.expandedCommentId = ctx.state.expandedCommentId === c.id ? null : c.id;
        renderInlineComments();
      });
      gutterMarkersEl.appendChild(dot);
    }
  }

  function buildInlineWidget(c, stackIndex) {
    const isExpanded = ctx.state.expandedCommentId === c.id;
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
        ctx.state.comments = ctx.state.comments.filter(x => x.id !== c.id);
        ctx.state.expandedCommentId = null;
        renderCommentOverlays();
        updateBadge();
      });
      actions.appendChild(deleteBtn);

      widget.appendChild(actions);
    }

    widget.addEventListener('click', () => {
      ctx.state.expandedCommentId = ctx.state.expandedCommentId === c.id ? null : c.id;
      renderInlineComments();
    });

    return widget;
  }

  function renderInlineComments() {
    if (ctx.state.isMobile) return;
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
  }

  function renderCommentOverlays() {
    renderGutterMarkers();
    renderInlineComments();
  }

  // ── Badge ──
  function updateBadge() {
    const pending = ctx.state.comments.length;
    const sent = ctx.state.submitted.length;
    const badge = ctx.dom.commentBadge;
    if (pending === 0 && sent === 0) {
      badge.textContent = '';
    } else if (pending > 0 && sent > 0) {
      badge.textContent = `${pending} pending / ${sent} submitted`;
    } else if (pending > 0) {
      badge.textContent = `${pending} pending`;
    } else {
      badge.textContent = `${sent} submitted`;
    }
  }

  // ── Comment popup ──
  function openEditPopup(c) {
    ctx.state.editingCommentId = c.id;
    ctx.dom.popupHeader.textContent = 'Edit Comment';
    ctx.dom.popupSelected.textContent = `"${c.selectedText.substring(0, MAX_SELECTED_TEXT_DISPLAY)}${c.selectedText.length > MAX_SELECTED_TEXT_DISPLAY ? '...' : ''}"`;
    ctx.dom.popupTextarea.value = c.comment;
    positionPopupAtTerminalCenter();
    const xterm = ctx.state.xterm;
    if (xterm) xterm.blur();
    setTimeout(() => ctx.dom.popupTextarea.focus(), 50);
  }

  function positionPopupAtTerminalCenter() {
    const screen = ctx.dom.xtermContainer.querySelector('.xterm-screen');
    const r = screen ? screen.getBoundingClientRect() : ctx.dom.terminalPanel.getBoundingClientRect();
    ctx.dom.commentPopup.style.display = 'block';
    if (ctx.state.isMobile) {
      ctx.dom.commentPopup.style.left = '12px';
      ctx.dom.commentPopup.style.top = `${Math.max(10, r.top + 20)}px`;
    } else {
      ctx.dom.commentPopup.style.left = `${Math.max(10, r.left + (r.width - 320) / 2)}px`;
      ctx.dom.commentPopup.style.top = `${Math.max(10, r.top + (r.height - 220) / 2)}px`;
    }
  }

  function showCommentPopup() {
    if (!ctx.state.pendingSelection) return;
    ctx.state.editingCommentId = null;
    ctx.dom.popupHeader.textContent = 'Add Comment';
    ctx.state.activeComment = { ...ctx.state.pendingSelection };
    ctx.dom.floatBtn.style.display = 'none';
    const ac = ctx.state.activeComment;
    ctx.dom.popupSelected.textContent = `"${ac.selectedText.substring(0, MAX_SELECTED_TEXT_DISPLAY)}${ac.selectedText.length > MAX_SELECTED_TEXT_DISPLAY ? '...' : ''}"`;
    ctx.dom.popupTextarea.value = '';
    positionPopupAtTerminalCenter();
    const xterm = ctx.state.xterm;
    if (xterm) xterm.blur();
    setTimeout(() => ctx.dom.popupTextarea.focus(), 50);
  }

  function hideCommentPopup() {
    ctx.dom.commentPopup.style.display = 'none';
    ctx.state.editingCommentId = null;
    ctx.state.activeComment = null;
    ctx.state.pendingSelection = null;
  }

  function saveComment() {
    const text = ctx.dom.popupTextarea.value.trim();
    if (!text) return;
    if (ctx.state.editingCommentId !== null) {
      const existing = ctx.state.comments.find(c => c.id === ctx.state.editingCommentId);
      if (existing) existing.comment = text;
    } else {
      if (!ctx.state.activeComment) return;
      ctx.state.comments.push({ ...ctx.state.activeComment, comment: text, id: ctx.state.nextCommentId++ });
    }
    hideCommentPopup();
    renderCommentOverlays();
    updateBadge();
    const xterm = ctx.state.xterm;
    if (xterm) xterm.clearSelection();
    ctx.dom.messageInput.focus();
  }

  // ── Submit ──
  function sendAll(withSubmit) {
    const messageInput = ctx.dom.messageInput;
    const message = messageInput.value.trim();
    const comments = ctx.state.comments;
    const hasComments = comments.length > 0;
    const hasMessage = message.length > 0;
    if (!hasComments && !hasMessage) return;
    const terminalWs = ctx.state.terminalWs;
    if (!terminalWs || terminalWs.readyState !== WebSocket.OPEN) {
      showToast('Terminal not connected');
      return;
    }

    const batchId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const knownBatchIds = ctx.state.knownBatchIds;
    knownBatchIds.add(batchId);
    if (knownBatchIds.size > 200) {
      const first = knownBatchIds.values().next().value;
      knownBatchIds.delete(first);
    }

    const parts = [];
    const xterm = ctx.state.xterm;
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

    const data = '\x1b[200~' + text + '\x1b[201~';
    terminalWs.send(JSON.stringify({ type: 'input', data }));

    if (withSubmit) {
      setTimeout(() => {
        const ws = ctx.state.terminalWs;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data: '\r' }));
        }
      }, 350);
    }

    const sessionQuery = ctx.state.currentSessionPid ? `?session=${ctx.state.currentSessionPid}` : '';
    fetch(`/api/submit${sessionQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comments: hasComments ? comments : [], message: message || undefined, batchId }),
    }).catch(() => {});

    const resultParts = [];
    if (hasComments) {
      resultParts.push(`${comments.length} comment(s)`);
      ctx.state.comments = [];
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

  // ── Outside click handler (called from app.js document mousedown) ──
  function handleOutsideClick(e) {
    if (ctx.dom.commentPopup.style.display === 'block' &&
        !ctx.dom.commentPopup.contains(e.target) &&
        e.target !== ctx.dom.floatBtn) {
      hideCommentPopup();
    }
    if (ctx.state.expandedCommentId !== null && !e.target.closest('.inline-comment')) {
      ctx.state.expandedCommentId = null;
      renderInlineComments();
    }
  }

  // ── Event listeners ──
  function setupEventListeners() {
    ctx.dom.floatBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showCommentPopup();
    });

    ctx.dom.popupCancel.addEventListener('click', hideCommentPopup);
    ctx.dom.popupSave.addEventListener('click', saveComment);

    ctx.dom.popupTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveComment();
      if (e.key === 'Escape') hideCommentPopup();
      e.stopPropagation();
    });

    ctx.dom.popupTextarea.addEventListener('click', () => {
      const xterm = ctx.state.xterm;
      if (xterm) xterm.blur();
      ctx.dom.popupTextarea.focus();
    });

    ctx.dom.doneBtn.addEventListener('click', async () => {
      if (!confirm('Close the mirror server?')) return;
      try { await fetch('/api/done', { method: 'POST' }); } catch {}
    });

    ctx.dom.sendSubmitBtn.addEventListener('click', () => sendAll(true));

    ctx.dom.messageInput.addEventListener('input', () => {
      ctx.dom.messageInput.style.height = 'auto';
      ctx.dom.messageInput.style.height = ctx.dom.messageInput.scrollHeight + 'px';
    });

    ctx.dom.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAll(true);
      }
      e.stopPropagation();
    });

    ctx.dom.messageInput.addEventListener('click', () => {
      const xterm = ctx.state.xterm;
      if (xterm) xterm.blur();
      ctx.dom.messageInput.focus();
    });
  }

  return { init, initRenderers, renderCommentOverlays, renderInlineComments, updateBadge, handleOutsideClick };
})();
