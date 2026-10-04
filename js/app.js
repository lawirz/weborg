/* weborg app — rendering + keymap on top of the text model.
 *
 * The buffer is doc.lines (raw org text). The cursor is (line, col) INSIDE
 * the raw line: columns count exactly the characters a .org file (and Emacs)
 * would see. Rendering slices each visible line into coloured spans covering
 * the same characters — nothing added, removed, or reordered — so the caret
 * and the textarea always line up with the true text. Insert mode edits the
 * entire raw line, stars included. Decorations are applied after the fact.
 */
(function () {
  'use strict';
  const O = window.Org;

  // ------------------------------------------------------------- state
  const LS_KEY = 'weborg' + '.buffer.v2';
  const state = {
    doc: null,          // {lines, folded} — THE document (text + view folds)
    line: 0,            // cursor: raw line index
    col: 0,             // cursor: column within the raw line
    goalCol: 0,
    mode: 'normal',     // 'normal' | 'insert'
    history: [], histIdx: -1,
  };
  let dirty = false;
  const tagHistory = [], colonHistory = [], searchHistory = [], dateHistory = [];
  let viewFilter = null;    // {groups: [[tag,...],...], label} — sparse tag view
  let searchState = null;   // {q}
  let killRing = null;      // array of raw lines — text, not objects
  function markDirty() { dirty = true; schedulePersist(); }
  function schedulePersist() {
    clearTimeout(schedulePersist._t);
    schedulePersist._t = setTimeout(persist, 400);
  }
  let storageOK = true;
  try { localStorage.setItem(LS_KEY + '.probe', '1'); localStorage.removeItem(LS_KEY + '.probe'); }
  catch (e) { storageOK = false; }

  function persist() {
    if (!storageOK) { dirty = false; return; }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        t: O.textOf(state.doc), f: Object.keys(state.doc.folded).map(Number),
      }));
      dirty = false;
    } catch (e) { /* storage full — keep going in memory */ }
  }

  const DEFAULT_DOC = [
    '#+TITLE: WEBORG',
    '',
    '* Welcome to weborg',
    '  The buffer IS plain org text — no shadow model.',
    '  Edit anything, stars included: press i anywhere.',
    '  What you see is exactly the .org file :q exports.',
    '',
    '** Try these',
    '*** TODO Read the keybindings        :intro:',
    '    - Press ? for the cheat sheet, i to edit the raw line.',
    '    - TAB folds, T cycles TODO, t d sets a DEADLINE by typed date.',
    '    - Org timestamps work as text: repeaters +1w, warning leads -5d.',
    '    - M-<arrows> move/demote/promote sections; / searches; \\ filters tags.',
    '*** DONE First steps',
    '',
    '** Deadlines & appointments',
    '*** TODO Submit taxes               :admin:urgent:',
    '    DEADLINE: <' + O.addDays(O.todayStr(), 5) + ' -3d>',
    '*** TODO Buy gift for Sam           :home:',
    '    DEADLINE: <' + O.addDays(O.todayStr(), 10) + '>',
    '*** Call the dentist',
    '    <' + O.addDays(O.todayStr(), -2) + ' 14:30-15:00>',
    '*** TODO Water the plants           :home:',
    '    <' + O.addDays(O.todayStr(), 2) + ' 08:00 +1w>',
    '',
    '** Parking lot',
    '*** TODO Fix the bike light',
    '*** STARTED Write the blog post     :writing:',
    '    note: idea struck [' + O.todayStr() + '] — inactive stamps stay off the agenda.',
    '',
  ].join('\n');

  function loadDoc() {
    let text = null, folds = [];
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const j = JSON.parse(raw);
        if (j && typeof j.t === 'string') { text = j.t; folds = j.f || []; }
        else if (typeof j === 'string') text = j;          // v1 plain-text blob
      }
    } catch (e) { text = null; }
    if (!text) {
      // migrate: v1 stored the serialized buffer as plain text
      try { const v1 = localStorage.getItem('weborg' + '.doc.v1'); if (v1 && v1.trim()) text = v1; } catch (e) {}
    }
    if (!text || !text.trim()) text = DEFAULT_DOC;
    state.doc = O.makeDoc(text);
    folds.forEach(function (i) { if (O.parseHeadingLine(state.doc.lines[i])) state.doc.folded[i] = true; });
    const vis = rows();
    state.line = vis.length ? vis[0] : 0;
    state.col = 0;
  }

  // ------------------------------------------------------------- DOM refs
  const $ = (sel) => document.querySelector(sel);
  const bufferEl = $('#org-buffer');
  const minibufferEl = $('#minibuffer');
  const modeBadge = $('#mode-badge');
  const cursorInfo = $('#cursor-info');
  const agendaPanel = $('#agenda-panel');
  const agendaBody = $('#agenda-body');

  // ------------------------------------------------------------- view
  function headingMatch(h) {
    if (!viewFilter) return true;
    const tags = h.tags.map(function (t) { return t.toLowerCase(); });
    return viewFilter.groups.every(function (g) { return g.some(function (t) { return tags.indexOf(t) >= 0; }); });
  }
  function rows() {
    if (viewFilter) return O.tagViewLines(state.doc, headingMatch);
    return O.visibleLines(state.doc);
  }
  function cursorRow(rs) { return (rs || rows()).indexOf(state.line); }

  // ------------------------------------------------------------- decoration
  // Each visible line becomes spans covering EXACTLY the characters of the
  // raw line, in order. Colors/classes are pure decoration.
  function esc(s) {
    return String(s).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function span(cls, text) { return text === '' ? '' : '<span class="' + cls + '">' + esc(text) + '</span>'; }

  // Decorate a run of text, wrapping any timestamps inside it in .ts spans.
  // `base` = offset of `text` within the full line (for later use; spans of
  // the result still concatenate to the same characters).
  function decorateTs(text, today) {
    const tsList = O.findTimestamps(text);
    if (!tsList.length) return esc(text);
    let html = '', pos = 0;
    tsList.forEach(function (ts) {
      html += esc(text.slice(pos, ts.start));
      const d = O.effectiveDate(ts, today);
      let cls = ts.active ? 'ts' : 'ts ts-inactive';
      if (ts.active && d < today) cls += ' ts-overdue';
      else if (ts.active && O.daysBetween(today, d) <= O.DEADLINE_WARNING_DAYS) cls += ' ts-soon';
      html += '<span class="' + cls + '">' + esc(ts.raw) + '</span>';
      pos = ts.end;
    });
    html += esc(text.slice(pos));
    return html;
  }

  function decorateLine(i, s, today) {
    const raw = state.doc.lines[i];
    const h = s.headings[i];
    if (h) {
      const sp = h.spans;
      let html = '', pos = 0;
      const emit = function (a, b, cls) {
        if (a > pos) html += esc(raw.slice(pos, a));
        const seg = raw.slice(Math.max(a, pos), b);
        html += cls ? span(cls, seg) : esc(seg);
        pos = Math.max(pos, b);
      };
      emit(sp.stars[0], sp.stars[1], 'stars');
      if (sp.state) emit(sp.state[0], sp.state[1], 'kw kw-' + h.state.toLowerCase());
      if (sp.priority) emit(sp.priority[0], sp.priority[1], 'prio');
      const titleEnd = sp.tags ? sp.tags[0] : raw.length;
      // title run (timestamp-decorated inside) — hl-text wraps it
      if (titleEnd > pos) {
        html += '<span class="hl-text">' + decorateTs(raw.slice(pos, titleEnd), today) + '</span>';
        pos = titleEnd;
      }
      if (sp.tags) emit(sp.tags[0], sp.tags[1], 'tags');
      if (pos < raw.length) html += esc(raw.slice(pos));
      const cls = 'line headline level-' + Math.min(h.level, 6) + (state.doc.folded[i] ? ' folded' : '');
      return { html: html, cls: cls };
    }
    const pm = O.PROP_RE.exec(raw);
    if (pm) {
      const keyStart = pm[1].length;
      let html = esc(raw.slice(0, keyStart)) +
        '<span class="prop-key">' + pm[2] + '</span>' +
        esc(raw.slice(keyStart + pm[2].length, pm[0].length - pm[3].length)) +
        decorateTs(pm[3], today);
      return { html: html, cls: 'line planning prop-' + pm[2].toLowerCase() };
    }
    return { html: decorateTs(raw, today) || '&nbsp;', cls: 'line content' };
  }

  function render() {
    const rs = rows();
    // cursor must sit on a visible line (e.g. after a fold/filter change)
    if (rs.indexOf(state.line) === -1 && rs.length) {
      let best = rs[0], bestDist = Infinity;
      rs.forEach(function (i) { const dd = Math.abs(i - state.line); if (dd < bestDist) { bestDist = dd; best = i; } });
      state.line = best;
    }
    if (state.doc.lines[state.line] === undefined) state.line = Math.max(0, state.doc.lines.length - 1);
    state.col = Math.min(state.col, (state.doc.lines[state.line] || '').length);

    const s = O.scan(state.doc);
    const today = O.todayStr();
    const q = searchState && searchState.q ? searchState.q.toLowerCase() : null;
    const frag = document.createDocumentFragment();

    rs.forEach(function (i) {
      let dec = decorateLine(i, s, today);
      if (q && state.doc.lines[i].toLowerCase().indexOf(q) >= 0) dec = { html: htmlWithSearch(i, q, s, today), cls: dec.cls + ' has-hit' };
      const div = document.createElement('div');
      div.className = dec.cls + (i === state.line ? ' cursor-line' : '');
      div.innerHTML = dec.html;
      div.dataset.line = i;
      if (i === state.line && state.mode !== 'insert') placeCaret(div, state.col);
      frag.appendChild(div);
    });
    if (!rs.length) {
      const div = document.createElement('div');
      div.className = 'line content empty-hint';
      div.textContent = viewFilter
        ? '(no headings carry those tags — Esc restores the full tree)'
        : '(empty buffer — i to type text, M-RET for a heading)';
      frag.appendChild(div);
    }

    bufferEl.innerHTML = '';
    bufferEl.appendChild(frag);
    bufferEl.appendChild(editTa); // survives re-render

    const curEl = bufferEl.querySelector('.cursor-line');
    if (curEl && curEl.scrollIntoView) curEl.scrollIntoView({ block: 'nearest' });

    const stats = O.countStats(state.doc);
    const meta = document.querySelector('#doc-meta');
    if (meta) meta.textContent = stats.done + '/' + stats.total + ' done' +
      (viewFilter ? '  ·  [' + viewFilter.label + ' — Esc for full tree]' : '');
    cursorInfo.textContent = 'L' + (state.line + 1) + ' C' + (state.col + 1) +
      (O.parseHeadingLine(state.doc.lines[state.line]) ? '  [heading]' : '  [body]');
  }

  // Search-highlight variant: wrap raw-text matches in .search-hit spans.
  // Characters still concatenate to the exact line (span-split only).
  function htmlWithSearch(i, q, s, today) {
    const raw = state.doc.lines[i];
    const lc = raw.toLowerCase();
    const marks = [];
    let from = 0, at;
    while ((at = lc.indexOf(q, from)) >= 0) { marks.push([at, at + q.length]); from = at + q.length; }
    const h = s.headings[i];
    if (!marks.length) return decorateLine(i, s, today).html;
    let html = '', pos = 0;
    marks.forEach(function (m) {
      html += esc(raw.slice(pos, m[0]));
      html += '<span class="search-hit">' + esc(raw.slice(m[0], m[1])) + '</span>';
      pos = m[1];
    });
    html += esc(raw.slice(pos));
    return h ? '<span class="hl-plain">' + html + '</span>' : html;
  }

  // Block cursor over the char at raw column `col`. The DOM text nodes of a
  // decorated line concatenate to exactly the raw line, so walking text
  // nodes and counting raw columns is exact — no exclude lists needed.
  function placeCaret(el, col) {
    const caret = document.createElement('span');
    caret.className = 'cursor-caret';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let tn;
    while ((tn = walker.nextNode())) {
      const len = tn.nodeValue.length;
      if (col <= len) {
        if (col === len) {
          caret.textContent = '\u00a0';
          tn.parentNode.insertBefore(caret, tn.nextSibling);
        } else {
          const after = tn.splitText(col);
          caret.textContent = after.nodeValue.charAt(0);
          after.nodeValue = after.nodeValue.slice(1);
          tn.parentNode.insertBefore(caret, after);
        }
        return;
      }
      col -= len;
    }
    caret.textContent = '\u00a0';
    el.appendChild(caret);
  }

  function updateModeBadge() {
    modeBadge.textContent = state.mode.toUpperCase();
    modeBadge.className = 'mode-' + state.mode;
    document.body.classList.toggle('mode-insert', state.mode === 'insert');
  }

  // ------------------------------------------------------------- minibuffer
  let promptActive = null;
  function minibufferPrompt(placeholder, onDone, opts) {
    opts = opts || {};
    closePrompt();
    const wrap = document.createElement('span');
    wrap.className = 'minibuffer-prompt';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'minibuffer-input';
    input.placeholder = placeholder;
    if (opts.value) input.value = opts.value;
    if (opts.prefix) {
      const pre = document.createElement('span');
      pre.className = 'prompt-prefix';
      pre.textContent = opts.prefix;
      wrap.appendChild(pre);
    }
    wrap.appendChild(input);
    minibufferEl.innerHTML = '';
    minibufferEl.appendChild(wrap);
    input.focus();
    const historyLocal = opts.history || tagHistory;
    let histIdx = historyLocal.length;
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = input.value;
        if (v && historyLocal[historyLocal.length - 1] !== v) historyLocal.push(v);
        closePrompt();
        onDone(v);
      } else if (e.key === 'Escape') {
        closePrompt();
        render(); updateModeBadge();
      } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        if (histIdx > 0) { histIdx--; input.value = historyLocal[histIdx] || ''; }
      } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        if (histIdx < historyLocal.length - 1) { histIdx++; input.value = historyLocal[histIdx]; }
        else { histIdx = historyLocal.length; input.value = ''; }
      }
    });
    promptActive = { el: input };
  }
  function closePrompt() { promptActive = null; minibufferEl.textContent = ''; }
  function flash(msg, cls) {
    minibufferEl.innerHTML = '<span class="flash ' + (cls || '') + '">' + esc(msg) + '</span>';
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { if (!promptActive) minibufferEl.textContent = ''; }, 2600);
  }

  // ------------------------------------------------------------- cursor
  function curLineText() { return state.doc.lines[state.line] || ''; }
  function goRow(i, keepCol) {
    const rs = rows();
    if (i < 0 || i >= rs.length) return;
    state.line = rs[i];
    state.col = keepCol ? Math.min(state.goalCol, curLineText().length) : 0;
  }
  function moveVis(delta) {
    const cur = cursorRow();
    if (cur === -1) return;
    goRow(Math.max(0, Math.min(rows().length - 1, cur + delta)), true);
  }
  function motionDown(n) { n = n || 1; state.goalCol = state.col; while (n--) moveVis(1); }
  function motionUp(n) { n = n || 1; state.goalCol = state.col; while (n--) moveVis(-1); }
  function moveCaret(delta) {
    state.col = Math.max(0, Math.min(curLineText().length, state.col + delta));
  }
  const WORD_RE = /[A-Za-z0-9_\u00c0-\u024f]/;
  function wordDelta(dir) {
    const t = curLineText(), col = state.col;
    if (dir > 0) {
      let i = col;
      if (i < t.length && WORD_RE.test(t[i])) while (i < t.length && WORD_RE.test(t[i])) i++;
      while (i < t.length && !WORD_RE.test(t[i])) i++;
      return i - col;
    }
    if (col <= 0) return 0;
    let i = col - 1;
    while (i > 0 && !WORD_RE.test(t[i])) i--;
    while (i > 0 && WORD_RE.test(t[i - 1])) i--;
    return i - col;
  }
  function gotoWord(dir, count) { count = count || 1; while (count--) moveCaret(wordDelta(dir)); }

  function headingLineUnderCursor() {
    const s = O.scan(state.doc);
    return O.headingLineOf(s, state.line);
  }
  function jumpToLine(i) {
    // expand ancestors of the target so it is actually visible
    const s = O.scan(state.doc);
    const h = s.headings[i];
    if (h) {
      let lvl = h.level;
      const k = s.pos[i];
      for (let m = k - 1; m >= 0 && lvl > 1; m--) {
        const a = s.headings[s.order[m]];
        if (a.level < lvl) { delete state.doc.folded[a.line]; lvl = a.level; }
      }
    }
    state.line = i; state.col = 0;
  }
  function gotoNextHeading(sameLevel) {
    const s = O.scan(state.doc);
    const h = O.parseHeadingLine(state.doc.lines[state.line]);
    const level = sameLevel && h ? h.level : 0;
    for (let i = state.line + 1; i < state.doc.lines.length; i++) {
      if (!s.headings[i]) continue;
      if (!sameLevel || s.headings[i].level <= level) { jumpToLine(i); return; }
    }
  }
  function gotoPrevHeading(sameLevel) {
    const s = O.scan(state.doc);
    const h = O.parseHeadingLine(state.doc.lines[state.line]);
    const level = sameLevel && h ? h.level : 0;
    for (let i = state.line - 1; i >= 0; i--) {
      if (!s.headings[i]) continue;
      if (!sameLevel || s.headings[i].level <= level) { jumpToLine(i); return; }
    }
  }

  // ------------------------------------------------------------- search & tag view
  function gotoSearchMatch(dir) {
    if (!searchState || !searchState.q) { flash('no search active — press / first'); return; }
    const rs = rows();
    if (!rs.length) { flash('nothing to search', 'warn'); return; }
    const q = searchState.q.toLowerCase();
    const lines = state.doc.lines;
    const start = Math.max(0, cursorRow());
    for (let step = 1; step <= rs.length; step++) {
      const j = ((start + dir * step) % rs.length + rs.length) % rs.length;
      const li = rs[j];
      if (lines[li].toLowerCase().indexOf(q) >= 0) {
        state.line = li;
        state.col = lines[li].toLowerCase().indexOf(q);
        render();
        flash('search: ' + searchState.q);
        return;
      }
    }
    flash('no match for: ' + searchState.q, 'warn');
  }
  function searchPrompt() {
    minibufferPrompt('search raw text, n / N repeat', function (v) {
      v = (v || '').trim();
      if (!v) { searchState = null; render(); return; }
      searchState = { q: v };
      gotoSearchMatch(+1);
    }, { history: searchHistory, prefix: '/' });
  }
  function tagViewPrompt() {
    minibufferPrompt('tags to show; space = AND, | = OR, empty = clear', function (v) {
      v = (v || '').trim();
      if (!v) { viewFilter = null; render(); return; }
      const groups = v.split(/\s+/).map(function (g) {
        return g.split('|').map(function (t) { return t.replace(/[^A-Za-z0-9_@#]/g, '').toLowerCase(); }).filter(Boolean);
      }).filter(function (g) { return g.length; });
      if (!groups.length) { viewFilter = null; render(); return; }
      viewFilter = { label: 'tags: ' + v, groups: groups };
      render();
      flash(viewFilter.label);
    }, { history: tagHistory, prefix: 'tags: ' });
  }

  // ------------------------------------------------------------- line editing
  const editTa = document.createElement('textarea');
  editTa.id = 'edit-area';
  editTa.spellcheck = false;
  bufferEl.appendChild(editTa);

  function startInsert(pos) {
    state.mode = 'insert';
    updateModeBadge();
    const text = curLineText();
    editTa.value = text;                         // THE RAW LINE — stars and all
    render();
    editTa.classList.remove('hidden');
    const cur = cursorRow();
    const el = bufferEl.children[cur];
    if (el) {
      editTa.style.left = (el.offsetLeft) + 'px';
      editTa.style.top = (el.offsetTop) + 'px';
      editTa.style.width = Math.max(200, bufferEl.clientWidth - el.offsetLeft - 10) + 'px';
      el.style.visibility = 'hidden';            // textarea shows identical raw text
    }
    editTa.style.height = '1.5em';
    editTa.focus();
    let caret = pos === 'start' ? 0 : pos === 'end' ? text.length :
      pos === 'after' ? Math.min(state.col + 1, text.length) : Math.min(state.col, text.length);
    editTa.setSelectionRange(caret, caret);
  }

  // Write the (possibly retyped) raw line back into the buffer; keep the
  // CLOSED stamp consistent when the TODO state changed while typing,
  // like org-todo does.
  function commitLine() {
    const v = String(editTa.value).replace(/\n/g, ' ');
    const i = state.line;
    const was = O.parseHeadingLine(state.doc.lines[i]);
    if (state.doc.lines[i] !== v) {
      state.doc.lines[i] = v;
      const now = O.parseHeadingLine(v);
      if (was && now) O.syncClosedOnHeadingEdit(state.doc, i, was.state, now.state);
      markDirty();
    }
  }

  function exitInsert(commit) {
    if (state.mode !== 'insert') return;
    if (commit !== false) {
      const caret = editTa.selectionStart;
      commitLine();
      state.col = Math.min(caret, curLineText().length);
      state.goalCol = state.col;
    }
    editTa.classList.add('hidden');
    editTa.blur();
    state.mode = 'normal';
    updateModeBadge();
    render(); renderAgenda();
    snapshotSoon();
  }

  // Enter = split the raw line at the caret (exactly what typing RET does
  // in a text file).
  function splitLine() {
    const caret = editTa.selectionStart;
    const v = editTa.value;
    const i = state.line;
    state.doc.lines[i] = v.slice(0, caret);
    O.insertLine(state.doc, i + 1, v.slice(caret));
    markDirty();
    state.line = i + 1; state.col = 0;
    editTa.value = '';
    render();
    startInsert('start');
  }

  editTa.addEventListener('input', function () { markDirty(); });
  editTa.addEventListener('keydown', function (e) {
    if (state.mode !== 'insert') return;
    if (e.key === 'k' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const pos = editTa.selectionStart;
      if (pos > 0 && editTa.value[pos - 1] === 'j') {   // jk -> Esc
        e.preventDefault();
        editTa.value = editTa.value.slice(0, pos - 1) + editTa.value.slice(pos);
        editTa.setSelectionRange(pos - 1, pos - 1);
        exitInsert(true);
        return;
      }
    }
    if (e.key === 'Escape') { e.preventDefault(); exitInsert(true); return; }
    if (e.key === 'Enter') { e.preventDefault(); splitLine(); return; }
    if (e.key === 'Tab') { e.preventDefault(); return; }
    e.stopPropagation();
  });

  // ------------------------------------------------------------- kill/yank (text lines)
  function sectionRange() {
    const i = state.line;
    const s = O.scan(state.doc);
    if (!s.headings[i]) return null;             // only when cursor is ON the heading
    return [i, O.blockEnd(s, state.doc, i)];
  }
  function dd() {
    const r = sectionRange();
    if (r) {
      killRing = state.doc.lines.slice(r[0], r[1]);
      O.deleteBlock(state.doc, r[0], r[1]);
      flash('killed ' + (r[1] - r[0]) + ' lines (section)');
    } else {
      killRing = [state.doc.lines[state.line]];
      O.deleteLine(state.doc, state.line);
    }
    if (state.line >= state.doc.lines.length) state.line = Math.max(0, state.doc.lines.length - 1);
    state.col = Math.min(state.col, curLineText().length);
    markDirty(); render(); renderAgenda(); snapshotSoon();
  }
  function yank() {
    const r = sectionRange();
    killRing = r ? state.doc.lines.slice(r[0], r[1]) : [state.doc.lines[state.line]];
    flash('yanked ' + killRing.length + ' lines');
  }
  function paste() {
    if (!killRing || !killRing.length) return;
    const r = sectionRange();
    const at = r ? r[1] : state.line + 1;
    O.insertBlock(state.doc, at, killRing.slice());
    state.line = at; state.col = 0;
    markDirty(); render(); renderAgenda(); snapshotSoon();
  }

  // ------------------------------------------------------------- folding
  function cycleFold() {
    const i = headingLineUnderCursor();
    const s = O.scan(state.doc);
    if (i == null || !s.headings[i]) return;
    if (state.doc.folded[i]) delete state.doc.folded[i];
    else state.doc.folded[i] = true;
    markDirty(); render();
  }
  function foldAll(on) {
    const s = O.scan(state.doc);
    state.doc.folded = {};
    if (on) for (const k in s.headings) {
      const i = Number(k);
      if (O.blockEnd(s, state.doc, i) > i + 1) state.doc.folded[i] = true;
    }
    render();
  }

  // ------------------------------------------------------------- dates (minibuffer)
  function datePrompt(field) {
    const i = headingLineUnderCursor();
    const s = O.scan(state.doc);
    if (i == null || !s.headings[i]) { flash('dates live on headings — cursor there', 'warn'); return; }
    const label = field === 'deadline' ? 'DEADLINE' : 'SCHEDULED';
    const rec = s.headings[i][field];
    minibufferPrompt('YYYY-MM-DD, today, +3d (empty clears)', function (v) {
      const r = O.parseDateInput(v);
      if (r === null) { flash('bad date: ' + v, 'warn'); return; }
      const dstr = r.clear ? null : r.date;
      O.setDate(state.doc, i, field, dstr);
      markDirty(); snapshotSoon();
      flash(label.toLowerCase() + (dstr ? ': <' + dstr + ' ' + O.dayName(dstr) + '>' : ' cleared'));
      render(); renderAgenda();
    }, { value: rec && rec.ts ? rec.ts.date : '', prefix: label + ': ', history: dateHistory });
  }

  // ------------------------------------------------------------- agenda panel
  function renderAgenda() {
    if (agendaPanel.classList.contains('hidden')) return;
    const items = O.agenda(state.doc, 14);
    agendaBody._items = items;
    if (!items.length) {
      agendaBody.innerHTML = '<div class="agenda-empty">Nothing due in the next 14 days.</div>';
      return;
    }
    let html = '', lastDate = null;
    items.forEach(function (it, idx) {
      if (it.date !== lastDate) {
        if (lastDate !== null) html += '<div class="agenda-gap"></div>';
        html += '<div class="agenda-date' + (it.overdue ? ' overdue' : '') + '">' +
          (it.overdue ? '!! OVERDUE ' : '') + esc(it.date + ' ' + O.dayName(it.date)) + '</div>';
        lastDate = it.date;
      }
      const kindLabel = it.kind === 'deadline' ? 'DL' : it.kind === 'scheduled' ? 'SC' : 'EV';
      const when = (it.ts.time ? ' ' + it.ts.time : '') + (it.ts.repeater ? ' +' + it.ts.repeater.n + it.ts.repeater.unit : '');
      html += '<div class="agenda-item' + (it.overdue ? ' overdue' : '') + '" data-idx="' + idx + '">' +
        '<span class="agenda-kind">' + kindLabel + '</span> ' +
        '<span class="agenda-state">' + esc(it.headline) + '</span>' +
        '<span class="agenda-when">' + esc(when) + '</span>' +
        '</div>';
    });
    agendaBody.innerHTML = html;
  }
  agendaBody.addEventListener('click', function (e) {
    const el = e.target.closest('.agenda-item');
    if (!el) return;
    const it = agendaBody._items[Number(el.dataset.idx)];
    if (it) { jumpToLine(it.line); render(); }
  });
  function toggleAgenda() {
    agendaPanel.classList.toggle('hidden');
    if (!agendaPanel.classList.contains('hidden')) renderAgenda();
  }

  // ------------------------------------------------------------- tags/priority
  function tagPrompt() {
    const i = headingLineUnderCursor();
    const s = O.scan(state.doc);
    if (i == null || !s.headings[i]) { flash('tags live on headings', 'warn'); return; }
    const existing = s.headings[i].tags.join(':');
    minibufferPrompt('Tags (colon-separated)', function (v) {
      O.setTags(state.doc, i, v.split(':').map(function (x) { return x.trim(); }));
      markDirty(); snapshotSoon(); render();
    }, { value: existing ? ':' + existing + ':' : '', prefix: 'TAGS: ', history: tagHistory });
  }
  function setPriorityCycle(dir) {
    const i = headingLineUnderCursor();
    const s = O.scan(state.doc);
    if (i == null || !s.headings[i]) return;
    const order = ['A', 'B', 'C'];
    const cur = s.headings[i].priority;
    let next;
    if (!cur) next = dir > 0 ? 'A' : 'C';
    else next = order[Math.max(0, Math.min(2, order.indexOf(cur) + dir))];
    O.editHeading(state.doc, i, function (f) { f.priority = next; });
    markDirty(); snapshotSoon(); render();
  }

  // ------------------------------------------------------------- help
  const HELP = [
    ['CURSOR', [
      ['h / l / ← / →', 'left / right in the RAW line'],
      ['j / k / ↓ / ↑', 'up / down over visible lines'],
      ['w / b', 'next / prev word'],
      ['W / B', 'next / prev heading'],
      ['g g / G', 'top / bottom'],
      ['0 / $', 'line start / end'],
      ['(count)', 'works on j k h l w b W B'],
      ['`', 'toggle agenda panel'],
    ]],
    ['EDITING = TEXT', [
      ['i / a', 'edit the whole raw line (stars too)'],
      ['I / A', 'raw line start / end'],
      ['Enter (insert)', 'split the line at the caret'],
      ['o / O', 'empty line below / above'],
      ['x / dd', 'delete line — on a heading: subtree'],
      ['y / p', 'yank line/subtree · paste below section'],
      ['Esc / jk', 'back to normal (commits text)'],
      ['u / Ctrl-R', 'undo / redo'],
    ]],
    ['FOLDING', [
      ['TAB', 'fold/unfold this heading'],
      ['zo / zc', 'open / close'],
      ['zm / zr', 'fold all / unfold all'],
    ]],
    ['ORG KEYWORDS', [
      ['T', 'cycle TODO → STARTED → WAITING → DONE'],
      ['D', 'straight to DONE (+CLOSED stamp)'],
      ['t t', 'tags prompt — rewrites :tags: in the line'],
      ['t d / t s', 'DEADLINE / SCHEDULED (typed date)'],
      ['t x', 'clear both planning lines'],
      ['+ / -', 'nudge DEADLINE ±n days (count works)'],
      ['[ / ]', 'priority [#A]/[#B]/[#C]'],
    ]],
    ['STRUCTURE', [
      ['M-Enter / C-Enter', 'new heading after section (M-RET)'],
      ['C-S-Enter', 'new child heading at section end'],
      ['M-↓ / M-↑ (M-j/k)', 'move section among siblings'],
      ['M-→ / M-← (M-l/h)', 'demote / promote subtree (stars ±1)'],
      ['>> / <<', 'same as M-→ / M-←'],
      ['J / K', 'move section down / up'],
    ]],
    ['SEARCH & VIEWS', [
      ['/', 'search raw text; n / N repeat'],
      ['\\', 'sparse tag view (space=AND, |=OR)'],
      ['Esc', 'leave tag view'],
    ]],
    ['FILES', [
      [':e', 'import .org file (replaces buffer)'],
      [':q', 'export buffer as .org'],
      [':w', 'save to browser storage (auto anyway)'],
      ['?', 'this help'],
    ]],
  ];
  function showHelp(on) {
    const el = $('#help-overlay');
    if (on === undefined) on = el.classList.contains('hidden');
    if (on) {
      const cols = $('#help-cols');
      cols.innerHTML = HELP.map(function (sec) {
        return '<div class="help-col"><div class="help-sec">' + sec[0] + '</div>' +
          sec[1].map(function (kv) {
            return '<div class="help-row"><span class="help-k">' + esc(kv[0]) + '</span><span class="help-v">' + esc(kv[1]) + '</span></div>';
          }).join('') + '</div>';
      }).join('');
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  // ------------------------------------------------------------- undo (text snapshots)
  function snapshot() {
    const s = JSON.stringify({ t: O.textOf(state.doc), f: Object.keys(state.doc.folded).map(Number) });
    if (state.history[state.histIdx] === s) return;
    state.history = state.history.slice(0, state.histIdx + 1);
    state.history.push(s);
    if (state.history.length > 100) state.history.shift();
    state.histIdx = state.history.length - 1;
  }
  let snapTimer = null;
  function snapshotSoon() { clearTimeout(snapTimer); snapTimer = setTimeout(snapshot, 500); }
  // 'u' right after a keystroke must undo THAT change: flush the debounce
  // (pushes the just-committed state) before stepping back.
  function flushSnapshot() { if (snapTimer) { clearTimeout(snapTimer); snapTimer = null; snapshot(); } }
  function undo() { flushSnapshot(); if (state.histIdx > 0) { state.histIdx--; restore(state.history[state.histIdx]); } else flash('already at oldest change'); }
  function redo() { flushSnapshot(); if (state.histIdx < state.history.length - 1) { state.histIdx++; restore(state.history[state.histIdx]); } else flash('nothing to redo'); }
  function restore(s) {
    const j = JSON.parse(s);
    state.doc = O.makeDoc(j.t);
    (j.f || []).forEach(function (i) { state.doc.folded[i] = true; });
    state.line = Math.min(state.line, state.doc.lines.length - 1);
    state.col = Math.min(state.col, curLineText().length);
    persist(); render(); renderAgenda();
  }

  // ------------------------------------------------------------- keymap
  let countBuf = '';
  function takeCount() {
    if (!countBuf) return 0;
    const n = parseInt(countBuf, 10);
    countBuf = '';
    return n;
  }

  let pendingG = false, pendingZ = false, pendingMap = null, pendingOp = null, pendingD = false;

  function onKeyDown(e) {
    if (!$('#help-overlay').classList.contains('hidden')) {
      if (e.key === 'Escape' || e.key === 'q' || e.key === '?') {
        showHelp(false);
        if (promptActive) closePrompt();
        e.preventDefault();
      }
      return;
    }
    if (promptActive) return;
    if (e.key === 'Escape' && viewFilter && state.mode === 'normal') { e.preventDefault(); viewFilter = null; render(); return; }

    if (e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'r') { e.preventDefault(); redo(); return; }
      if (k === '[') { e.preventDefault(); if (state.mode === 'insert') exitInsert(true); return; }
    }
    if (e.altKey) return;  // M-keys handled in capture phase below

    if (state.mode === 'insert') {
      if (e.key === 'Escape') { e.preventDefault(); exitInsert(true); }
      return;  // textarea edits natively otherwise
    }

    if (document.activeElement === editTa) editTa.blur();
    e.preventDefault();
    const k = e.key;

    if (/[0-9]/.test(k) && (countBuf || k !== '0')) { countBuf += k; cursorInfo.textContent = countBuf + ' ×'; return; }
    if (k === '0' && !countBuf) { state.col = 0; render(); return; }
    const count = takeCount();

    if (pendingD) {
      pendingD = false;
      if (k === 'd') dd();
      return;
    }
    if (pendingMap === 't') {
      pendingMap = null;
      if (k === 'd') datePrompt('deadline');
      else if (k === 's') datePrompt('scheduled');
      else if (k === 't') tagPrompt();
      else if (k === 'x') {
        const i = headingLineUnderCursor();
        if (i != null && O.clearDates(state.doc, i)) { markDirty(); snapshotSoon(); flash('dates cleared'); }
        render(); renderAgenda();
      } else flash('t-map: d s t x', 'warn');
      return;
    }
    if (pendingG) {
      pendingG = false;
      if (k === 'g') { const rs = rows(); if (rs.length) goRow(0); render(); }
      return;
    }
    if (pendingZ) {
      pendingZ = false;
      const i = headingLineUnderCursor();
      if (k === 'o' && i != null) { delete state.doc.folded[i]; render(); }
      else if (k === 'c' && i != null) { state.doc.folded[i] = true; render(); }
      else if (k === 'm') foldAll(true);
      else if (k === 'r') foldAll(false);
      return;
    }

    switch (k) {
      case 'ArrowDown': case 'j': motionDown(count || 1); break;
      case 'ArrowUp': case 'k': motionUp(count || 1); break;
      case 'ArrowLeft': case 'h': moveCaret(-(count || 1)); break;
      case 'ArrowRight': case 'l': moveCaret(count || 1); break;
      case 'w': gotoWord(+1, count || 1); break;
      case 'b': gotoWord(-1, count || 1); break;
      case 'W': gotoNextHeading(false); break;
      case 'B': gotoPrevHeading(false); break;
      case 'g': pendingG = true; return;
      case 'G': { const rs = rows(); if (rs.length) goRow(rs.length - 1); break; }
      case '$': state.col = curLineText().length; break;
      case '^': { const t = curLineText(); const m = /^[*\s]+/.exec(t); state.col = Math.min(m[0].length, t.length); break; }
      case 'i': startInsert('caret'); return;
      case 'I': startInsert('start'); return;
      case 'a': startInsert('after'); return;
      case 'A': startInsert('end'); return;
      case 'o': case 'O': {
        const at = k === 'o' ? state.line + 1 : state.line;
        O.insertLine(state.doc, at, '');
        state.line = at; state.col = 0;
        markDirty(); render(); startInsert('start'); return;
      }
      case 'x': dd(); break;
      case 'd': pendingD = true; flash('d…', 'hint'); return;
      case 'y': yank(); break;
      case 'p': paste(); break;
      case 'Tab': {
        const i = headingLineUnderCursor();
        if (e.shiftKey) {
          if (i != null) { const st = O.cycleState(state.doc, i); markDirty(); snapshotSoon(); flash(st || 'no state'); render(); renderAgenda(); }
        } else cycleFold();
        break;
      }
      case 'T': {
        const i = headingLineUnderCursor();
        if (i != null) { const st = O.cycleState(state.doc, i); markDirty(); snapshotSoon(); flash(st || 'no state'); render(); renderAgenda(); }
        break;
      }
      case 'D': {
        const i = headingLineUnderCursor();
        const s = O.scan(state.doc);
        if (i != null && s.headings[i]) {
          if (s.headings[i].state !== 'DONE') O.editHeading(state.doc, i, function (f) { f.state = 'DONE'; });
          O.stampClosed(state.doc, i);
          markDirty(); snapshotSoon(); render(); renderAgenda();
        }
        break;
      }
      case '`': toggleAgenda(); break;
      case 't': pendingMap = 't'; flash('t: d=deadline s=scheduled t=tags x=clear', 'hint'); return;
      case 'J': case 'K': {
        const i = headingLineUnderCursor();
        if (i != null && O.moveSection(state.doc, i, k === 'J' ? 1 : -1)) { markDirty(); snapshotSoon(); }
        else flash('section move blocked (edge of buffer)', 'hint');
        render();
        break;
      }
      case '>': pendingOp = '>'; handleLevel(count); return;
      case '<': pendingOp = '<'; handleLevel(count); return;
      case '[': setPriorityCycle(-1); break;
      case ']': setPriorityCycle(+1); break;
      case '+': case '-': {
        const i = headingLineUnderCursor();
        const s = O.scan(state.doc);
        if (i != null && s.headings[i] && s.headings[i].deadline) {
          if (O.nudgeDate(state.doc, i, 'deadline', (k === '+' ? 1 : -1) * (count || 1))) {
            markDirty(); snapshotSoon(); render(); renderAgenda();
          }
        } else flash('no DEADLINE here — t d sets one', 'hint');
        break;
      }
      case '?': showHelp(true); break;
      case '/': searchPrompt(); break;
      case '\\': tagViewPrompt(); break;
      case 'n': gotoSearchMatch(+1); break;
      case 'N': gotoSearchMatch(-1); break;
      case 'u': undo(); break;
      case ':': startColon(); break;
      case 'z': pendingZ = true; flash('z: o/c/m/r', 'hint'); return;
      default: countBuf = '';
    }
    if (state.mode !== 'insert') render();
  }

  function handleLevel(count) {
    const i = headingLineUnderCursor();
    const dir = pendingOp === '>' ? 1 : -1;
    pendingOp = null;
    if (i == null) { flash('structure keys work on headings', 'hint'); return; }
    let done = false;
    for (let c = 0; c < (count || 1); c++) if (O.changeLevel(state.doc, i, dir)) done = true; else break;
    if (done) { markDirty(); snapshotSoon(); render(); }
    else flash(dir > 0 ? 'nothing to hang it under' : 'already top level', 'hint');
  }

  // ------------------------------------------------------------- capture-phase: Enter combos & M-keys
  document.addEventListener('keydown', function (e) {
    if (promptActive) return;
    if (!$('#help-overlay').classList.contains('hidden')) return;

    if (e.key === 'Enter' && (e.altKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      if (state.mode === 'insert') exitInsert(true);
      const i = headingLineUnderCursor();
      let at;
      if (i == null) {
        O.insertLine(state.doc, state.line + 1, '* ');
        at = state.line + 1;
      } else {
        at = O.insertHeadingBelow(state.doc, i, false);
      }
      state.line = at; state.col = 0;
      markDirty(); snapshotSoon(); render(); startInsert('start');
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (state.mode === 'insert') exitInsert(true);
      const i = headingLineUnderCursor();
      let at;
      if (i == null) {
        O.insertLine(state.doc, state.line + 1, '* ');
        at = state.line + 1;
      } else {
        at = O.insertHeadingBelow(state.doc, i, true);
      }
      state.line = at; state.col = 0;
      markDirty(); snapshotSoon(); render(); startInsert('start');
      return;
    }
    if (e.altKey && !e.ctrlKey) {
      const k = e.key;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'h', 'j', 'k', 'l'].indexOf(k) < 0) return;
      e.preventDefault(); e.stopPropagation();
      if (state.mode === 'insert') exitInsert(true);
      const i = headingLineUnderCursor();
      let ok = false;
      if (i != null) {
        if (k === 'ArrowDown' || k === 'j') ok = O.moveSection(state.doc, i, +1);
        else if (k === 'ArrowUp' || k === 'k') ok = O.moveSection(state.doc, i, -1);
        else if (k === 'ArrowRight' || k === 'l') ok = O.changeLevel(state.doc, i, +1);
        else if (k === 'ArrowLeft' || k === 'h') ok = O.changeLevel(state.doc, i, -1);
      }
      if (ok) { markDirty(); snapshotSoon(); render(); renderAgenda(); }
      else if (i != null) flash('section move blocked', 'hint');
      return;
    }
  }, true);

  // ------------------------------------------------------------- colon commands
  function downloadText(name, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  }
  function startColon() {
    minibufferPrompt('w · q · e · help', function (cmd) {
      cmd = cmd.trim().toLowerCase();
      if (cmd === 'w' || cmd === 'wq' || cmd === 'x') { persist(); flash('saved to browser storage'); }
      else if (cmd === 'q') {
        persist();
        const tm = /^#\+TITLE:\s*(.*)$/i.exec(state.doc.lines[0] || '');
        const name = (tm ? tm[1] : 'weborg').trim().toLowerCase().replace(/\s+/g, '-') + '.org';
        downloadText(name, O.textOf(state.doc));
        flash('exported ' + name);
      }
      else if (cmd === 'e') { $('#import-input').click(); flash('choose .org file'); }
      else if (cmd === 'help') showHelp(true);
      else flash('unknown command: ' + cmd, 'warn');
      render();
    }, { history: colonHistory, prefix: ':' });
  }

  $('#import-input').addEventListener('change', function (e) {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = function () {
      state.doc = O.makeDoc(r.result);
      state.line = 0; state.col = 0;
      state.history = []; state.histIdx = -1;
      snapshot();
      persist(); render(); renderAgenda();
      flash('imported ' + f.name + ' — the buffer is the file');
    };
    r.readAsText(f);
    e.target.value = '';
  });

  // ------------------------------------------------------------- click
  bufferEl.addEventListener('click', function (e) {
    if (state.mode === 'insert') return;
    const el = e.target.closest('.line');
    if (!el) return;
    const li = Number(el.dataset.line);
    if (isNaN(li)) return;
    state.line = li;
    // caret column from the click point, counting raw characters
    let col = curLineText().length;
    if (document.caretRangeFromPoint) {
      const rng = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (rng && el.contains(rng.startContainer)) {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let n, acc = 0;
        while ((n = w.nextNode())) {
          if (n === rng.startContainer) { acc += rng.startOffset; break; }
          acc += n.nodeValue.length;
        }
        col = acc;
      }
    }
    state.col = Math.min(col, curLineText().length);
    render();
    if (window.getSelection) window.getSelection().removeAllRanges();
  });

  // ------------------------------------------------------------- boot
  window.addEventListener('beforeunload', function () { if (dirty) persist(); });

  loadDoc();
  snapshot();
  updateModeBadge();
  render();

  document.addEventListener('keydown', onKeyDown);

  // expose for tests/debugging
  window.__weborg = {
    state, O, render, rows,
    debug: function () {
      return { pendingD: pendingD, pendingMap: pendingMap, pendingG: pendingG,
               pendingZ: pendingZ, pendingOp: pendingOp, countBuf: countBuf,
               mode: state.mode, promptActive: !!promptActive };
    },
  };
})();
