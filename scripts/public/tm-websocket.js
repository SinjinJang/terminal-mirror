window.TM = window.TM || {};
TM.websocket = (function() {
  const { MAX_RECONNECT } = TM.constants;

  let commentWs = null;
  let terminalReconnects = 0;
  let commentReconnects = 0;
  let serverShutdown = false;
  let writeBuf = [];
  let writeRaf = null;

  let ctx = null;

  function init(context) {
    ctx = context;
  }

  // Strip sequences that should not reach the mirror terminal.
  // - DA responses  (ESC [ >? digits ; digits c)
  // - ED3 / clear-scrollback (ESC [ 3 J) — sent by programs like
  //   Claude Code on every redraw; wiping the scrollback destroys
  //   the history the viewer is reading.
  function stripTerminalNoise(buf) {
    const ranges = [];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] !== 0x1b || buf[i + 1] !== 0x5b) continue;
      let j = i + 2;

      // ── DA response: ESC [ (>|=)? digits (;digits)* c ──
      let k = j;
      if (k < buf.length && (buf[k] === 0x3e || buf[k] === 0x3d)) k++;
      while (k < buf.length && ((buf[k] >= 0x30 && buf[k] <= 0x39) || buf[k] === 0x3b)) k++;
      if (k < buf.length && buf[k] === 0x63) {
        ranges.push(i, k + 1);
        i = k;
        continue;
      }

      // ── ED3 clear-scrollback: ESC [ 3 J ──
      if (j + 1 < buf.length && buf[j] === 0x33 && buf[j + 1] === 0x4a) {
        ranges.push(i, j + 2);
        i = j + 1;
        continue;
      }
    }
    if (ranges.length === 0) return buf;
    let removed = 0;
    for (let k = 0; k < ranges.length; k += 2) removed += ranges[k + 1] - ranges[k];
    const out = new Uint8Array(buf.length - removed);
    let src = 0, dst = 0;
    for (let k = 0; k < ranges.length; k += 2) {
      const copyLen = ranges[k] - src;
      if (copyLen > 0) { out.set(buf.subarray(src, ranges[k]), dst); dst += copyLen; }
      src = ranges[k + 1];
    }
    if (src < buf.length) out.set(buf.subarray(src), dst);
    return out;
  }

  function flushWrites() {
    writeRaf = null;
    const xterm = ctx.state.xterm;
    if (!xterm || writeBuf.length === 0) return;
    let buf;
    if (writeBuf.length === 1) {
      buf = writeBuf[0];
    } else {
      let len = 0;
      for (const c of writeBuf) len += c.length;
      buf = new Uint8Array(len);
      let off = 0;
      for (const c of writeBuf) { buf.set(c, off); off += c.length; }
    }
    buf = stripTerminalNoise(buf);
    if (buf.length > 0) xterm.write(buf);
    writeBuf = [];
    ctx.scheduleTextViewUpdate();
  }

  function cancelPendingWrites() {
    if (writeRaf) { cancelAnimationFrame(writeRaf); writeRaf = null; }
    writeBuf = [];
  }

  function handleShutdown() {
    serverShutdown = true;
    ctx.clearSessionRefreshTimer();
    document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888;font-size:1.2em;">Server stopped. You can close this tab.</div>';
  }

  function connectTerminalWs() {
    const currentSessionPid = ctx.state.currentSessionPid;
    if (!currentSessionPid) return;
    const terminalWs = ctx.state.terminalWs;
    if (terminalWs) {
      terminalWs.onclose = null;
      terminalWs.close();
    }
    cancelPendingWrites();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ session: String(currentSessionPid) });
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?${params.toString()}`);
    ws.binaryType = 'arraybuffer';
    ctx.state.terminalWs = ws;

    ws.onopen = () => {
      ctx.dom.wsStatus.style.background = '#9ece6a';
      terminalReconnects = 0;
      ctx.dom.connectingOverlay.classList.add('hidden');
    };

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        const xterm = ctx.state.xterm;
        if (xterm) {
          if (document.hidden) {
            if (writeBuf.length > 0) flushWrites();
            const cleaned = stripTerminalNoise(new Uint8Array(e.data));
            if (cleaned.length > 0) xterm.write(cleaned);
            ctx.scheduleTextViewUpdate();
          } else {
            writeBuf.push(new Uint8Array(e.data));
            if (!writeRaf) writeRaf = requestAnimationFrame(flushWrites);
          }
        }
      } else {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'shutdown') { handleShutdown(); return; }
          if (msg.type === 'resize' && ctx.state.xterm) {
            // Flush pending terminal writes so fitTerminal() sees the latest
            // buffer state when saving/restoring scroll position.
            if (writeBuf.length > 0) flushWrites();
            ctx.state.serverCols = msg.cols;
            ctx.state.serverRows = msg.rows;
            ctx.fitTerminal();
            ctx.syncTerminalUI();
          }
          if (msg.type === 'wrapper_status') {
            ctx.updateWrapperStatus(msg.connected);
            if (!msg.connected && msg.exitCode !== undefined) {
              ctx.showToast('Wrapper process exited (code ' + msg.exitCode + ')');
              const xterm = ctx.state.xterm;
              if (xterm) { xterm.reset(); xterm.clear(); }
              setTimeout(async () => {
                const sessions = await ctx.refreshSessions();
                const other = sessions.find(s => s.pid !== ctx.state.currentSessionPid);
                if (other) ctx.switchToSession(other.pid);
              }, 1000);
            }
          }
        } catch {}
      }
    };

    const sessionPidAtConnect = currentSessionPid;
    ws.onclose = () => {
      flushWrites();
      ctx.dom.wsStatus.style.background = '#555';
      if (serverShutdown) return;
      if (ctx.state.currentSessionPid !== sessionPidAtConnect) return;
      terminalReconnects++;
      if (terminalReconnects <= MAX_RECONNECT) {
        const delay = Math.min(2000 * Math.pow(2, terminalReconnects - 1), 30000);
        setTimeout(connectTerminalWs, delay);
      }
    };

    ws.onerror = () => {
      ctx.dom.wsStatus.style.background = '#f7768e';
    };
  }

  function connectCommentWs() {
    const currentSessionPid = ctx.state.currentSessionPid;
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
          if (msg.batchId && ctx.state.knownBatchIds.has(msg.batchId)) return;
          ctx.state.submitted.push(...msg.comments);
          ctx.renderCommentOverlays();
          ctx.updateBadge();
        }
      } catch {}
    };

    const sessionPidAtConnect = currentSessionPid;
    commentWs.onclose = () => {
      if (ctx.state.currentSessionPid !== sessionPidAtConnect) return;
      commentReconnects++;
      if (commentReconnects <= MAX_RECONNECT) {
        const delay = Math.min(2000 * Math.pow(2, commentReconnects - 1), 30000);
        setTimeout(connectCommentWs, delay);
      }
    };
  }

  function closeAll() {
    const terminalWs = ctx.state.terminalWs;
    if (terminalWs) {
      terminalWs.onclose = null;
      terminalWs.close();
      ctx.state.terminalWs = null;
    }
    if (commentWs) {
      commentWs.onclose = null;
      commentWs.close();
      commentWs = null;
    }
  }

  function resetCounters() {
    terminalReconnects = 0;
    commentReconnects = 0;
    serverShutdown = false;
  }

  return { init, connectTerminalWs, connectCommentWs, closeAll, resetCounters, stripTerminalNoise };
})();
