/* weborg app: DOM rendering, vim-style keymap, minibuffer prompts, typed dates. */
(function () {
  'use strict';
  const O = window.Org;

  // ------------------------------------------------------------- state
  const LS_KEY = 'weborg' + '.doc.v1';
  const state = {
    doc: null,           // {root, docTitle}
    cursorId: null,      // node id under cursor
    cursorContentIdx: null, // null => on headline, else content line index
    caretCol: 0,
    mode: 'normal',      // 'normal' | 'insert' | 'operator'
    operator: null,      // 'd' | 'c' | '>' | '<'
    pending: '',         // partial operator args
    goalCol: 0,          // for j/k vertical alignment
    history: [], histIdx: -1,
  };

  let dirty = false;
  const tagHistory = [];   // tag-entry history
  const colonHistory = []; // :command history
  function markDirty() { dirty = true; schedulePersist(); }

  function schedulePersist() {
    clearTimeout(schedulePersist._t);
    schedulePersist._t = setTimeout(persist, 400);
  }
  // Storage may be unavailable (file:// in some browsers, private mode).
  // The app keeps working from memory either way; the user is told once.
  let storageOK = true;
  try { localStorage.setItem(LS_KEY + '.probe', '1'); localStorage.removeItem(LS_KEY + '.probe'); }
  catch (e) { storageOK = false; }

  function persist() {
    if (!storageOK) { dirty = false; return; }   // memory-only buffer; export with :q
    try {
      localStorage.setItem(LS_KEY, O.serialize(state.doc.root, state.doc.docTitle, state.doc.preface));
      dirty = false;
    } catch (e) { /* storage full — keep going in memory */ }
  }

  const DEFAULT_DOC = [
    '#+TITLE: WEBORG',
    '',
    '* Welcome to weborg',
    '  A tiny org-mode clone that lives entirely in your browser.',
    '  No backend, no server — just the index.html file you opened.',
    '  localStorage is your buffer; :q exports it as a .org file.',
    '',
    '** Try these',
    '*** TODO Read the keybindings       :intro:',
    '    SCHEDULED: <' + O.todayStr() + '>',
    '    - Press ? to show the full cheat sheet.',
    '    - Press i on a heading: edit it as plain org text —',
    '      TODO, [#A] and :tags: all typed inline.',
    '    - hjkl / arrows move the cursor; TAB folds; T cycles TODO.',
    '    - M-<arrows> (or M-hjkl) move/demote/promote sections, like org.',
    '*** DONE First steps                 :done:',
    '    CLOSED: <' + O.todayStr() + '>',
    '',
    '** Deadlines',
    '*** TODO Submit taxes               :admin:urgent:',
    '    DEADLINE: <' + O.addDays(O.todayStr(), 3) + '>',
    '*** TODO Buy gift for Sam           :home:',
    '    DEADLINE: <' + O.addDays(O.todayStr(), 10) + '>',
    '*** TODO Call the dentist           :health:',
    '    DEADLINE: <' + O.addDays(O.todayStr(), -2) + '>',
    '',
    '** Parking lot',
    '*** TODO Fix the bike light',
    '*** STARTED Write the blog post     :writing:',
    '',
  ].join('\n');

  function loadDoc() {
    let text = null;
    try { text = localStorage.getItem(LS_KEY); } catch (e) {}
    state.doc = O.parse(text && text.trim() ? text : DEFAULT_DOC);
    O.linkParents(state.doc.root);
    const first = O.flatten(state.doc.root)[0];
    state.cursorId = first ? first.node.id : null;
    state.cursorContentIdx = null;
  }

  // ------------------------------------------------------------- DOM refs
  const $ = (sel) => document.querySelector(sel);
  const bufferEl = $('#org-buffer');
  const minibufferEl = $('#minibuffer');
  const modeBadge = $('#mode-badge');
  const cursorInfo = $('#cursor-info');
  const agendaPanel = $('#agenda-panel');
  const agendaBody = $('#agenda-body');

  // ------------------------------------------------------------- rendering
  function rows() { return O.flatten(state.doc.root); }
  function cursorRow() {
    const rs = rows();
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      if (r.node.id === state.cursorId) {
        if (r.kind === 'headline' && state.cursorContentIdx === null) return i;
        if (r.kind === 'content' && r.index === state.cursorContentIdx) return i;
      }
    }
    return -1;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // The editable org text of a headline (level stars excluded — those are
  // structural): TODO [#A] headline text  :tags:
  function headlineEditable(n) {
    let s = '';
    if (n.state) s += n.state + ' ';
    if (n.priority) s += '[#' + n.priority + '] ';
    s += n.headline;
    if (n.tags.length) s += ' :' + n.tags.join(':') + ':';
    return s;
  }
  // Org text of the line under the cursor (headline or body line).
  function curLineText() {
    const n = curNode();
    if (!n) return '';
    return state.cursorContentIdx === null ? headlineEditable(n) : (n.content[state.cursorContentIdx] || '');
  }

  // Write edited org text back: re-parse like the real parser so TODO
  // keyword, [#A] priority and :tags: typed inline all take effect.
  function applyHeadlineEdit(n, v) {
    v = v.replace(/\n/g, ' ');
    const prev = n.state;
    const parsed = O.parseHeadlineLine('*'.repeat(n.level) + ' ' + v);
    if (parsed) {
      n.state = parsed.state; n.priority = parsed.priority;
      n.headline = parsed.headline; n.tags = parsed.tags;
    } else {
      n.headline = v; n.state = null; n.priority = null; n.tags = [];
    }
    if (n.state === 'DONE' && prev !== 'DONE') n.closed = O.todayStr();
    else if (n.state !== 'DONE') n.closed = null;
  }

  // Normal-mode block cursor: wrap the char at column `col` in .cursor-caret.
  // Text nodes inside `exclude` elements (stars, date badges, foldmarks)
  // don't count toward the column.
  function placeCaret(el, col, exclude) {
    exclude = exclude || [];
    const caret = document.createElement('span');
    caret.className = 'cursor-caret';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let tn;
    while ((tn = walker.nextNode())) {
      if (exclude.some(function (x) { return x.contains(tn); })) continue;
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
    caret.textContent = '\u00a0'; // past end of line
    el.appendChild(caret);
  }

  function render() {
    const rs = rows();
    const cur = cursorRow();
    const today = O.todayStr();
    const frag = document.createDocumentFragment();

    rs.forEach(function (r, i) {
      const div = document.createElement('div');
      const n = r.node;
      if (r.kind === 'headline') {
        div.className = 'line headline level-' + Math.min(n.level, 6);
        let html = '<span class="stars">' + '*'.repeat(n.level) + '</span> ';
        if (n.state) html += '<span class="kw kw-' + n.state.toLowerCase() + '">' + n.state + '</span> ';
        if (n.priority) html += '<span class="prio">[#' + n.priority + ']</span> ';
        html += '<span class="hl-text">' + esc(n.headline) + '</span>';
        const badges = [];
        if (n.tags.length) badges.push('<span class="tags">:' + n.tags.map(esc).join(':') + ':</span>');
        if (n.deadline) {
          const overdue = n.deadline < today && n.state !== 'DONE';
          badges.push('<span class="dl ' + (overdue ? 'dl-overdue' : 'dl-soon') + '">DL ' + O.humanDate(n.deadline) + '</span>');
        }
        if (n.scheduled) badges.push('<span class="sch">SC ' + O.humanDate(n.scheduled) + '</span>');
        if (badges.length) html += ' <span class="trail">' + badges.join(' ') + '</span>';
        if (n.collapsed && n.children.length) html += ' <span class="foldmark">...</span>';
        div.innerHTML = html;
        div.dataset.nodeId = n.id;
        div.dataset.kind = 'headline';
      } else {
        div.className = 'line content';
        div.innerHTML = '<span class="content-text">' + (esc(r.text) || '&nbsp;') + '</span>';
        div.dataset.nodeId = n.id;
        div.dataset.kind = 'content';
        div.dataset.index = r.index;
      }
      if (i === cur) {
        div.classList.add('cursor-line');
        if (state.mode !== 'insert') {
          state.caretCol = Math.min(state.caretCol, curLineText().length);
          placeCaret(div, state.caretCol,
            [div.querySelector('.stars'), div.querySelector('.trail'), div.querySelector('.foldmark')].filter(Boolean));
        }
      }
      frag.appendChild(div);
    });

    bufferEl.innerHTML = '';
    bufferEl.appendChild(frag);
    bufferEl.appendChild(editTa); // survives re-render; positioning happens in startInsert

    // keep cursor visible
    const curEl = bufferEl.querySelector('.cursor-line');
    if (curEl && curEl.scrollIntoView) curEl.scrollIntoView({ block: 'nearest' });

    // statusline
    const stats = O.countStats(state.doc.root);
    const n_ = rows().length;
    const meta = document.querySelector('#doc-meta');
    if (meta) meta.textContent = (state.doc.docTitle || 'UNTITLED') + '  ·  ' +
      stats.done + '/' + stats.total + ' done';
    cursorInfo.textContent = 'lines:' + n_ + '  tasks:' + stats.total + ' done:' + stats.done +
      (state.cursorContentIdx === null ? '  [H]' : '  [B' + (state.cursorContentIdx + 1) + ']');
  }

  function updateModeBadge() {
    modeBadge.textContent = state.mode === 'operator' ? (state.operator === 'd' ? 'DELETE' : state.operator === 'c' ? 'CHANGE' : 'INDENT') :
      state.mode.toUpperCase();
    modeBadge.className = 'mode-' + (state.mode === 'operator' ? 'op' : state.mode);
    document.body.classList.toggle('mode-insert', state.mode === 'insert');
  }

  // cursor path: sibling-index list from root, survives reparse (undo/import)
  function cursorPath() {
    const n = curNode();
    if (!n) return null;
    const path = [];
    let cur = n;
    while (cur && cur.__parent) {
      path.unshift(cur.__parent.children.indexOf(cur));
      cur = cur.__parent;
    }
    return path;
  }
  function nodeByPath(path) {
    let n = state.doc.root;
    for (const idx of path) {
      if (!n.children[idx]) return null;
      n = n.children[idx];
    }
    return n;
  }

  // ------------------------------------------------------------- minibuffer prompts
  let promptActive = null; // {el, onDone}
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
    let historyLocal = opts.history || tagHistory;
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = input.value;
        closePrompt();
        onDone(v);
      } else if (e.key === 'Escape') {
        closePrompt();
        render(); updateModeBadge();
      } else if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        historyPush(input.value);
      } else if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        historyPop(input);
      }
    });
    promptActive = { el: input, onDone: onDone };
    function historyPush(v) { if (v && historyLocal[historyLocal.length - 1] !== v) { historyLocal.push(v); state.histIdx = historyLocal.length; } }
    function historyPop(inp) {
      if (!historyLocal.length) return;
      state.histIdx = Math.max(0, state.histIdx - 1);
      inp.value = historyLocal[state.histIdx];
    }
  }
  function closePrompt() {
    promptActive = null;
    minibufferEl.textContent = '';
  }
  function flash(msg, cls) {
    minibufferEl.innerHTML = '<span class="flash ' + (cls || '') + '">' + esc(msg) + '</span>';
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { if (!promptActive) minibufferEl.textContent = ''; }, 2600);
  }

  // ------------------------------------------------------------- current node helpers
  function curNode() {
    if (state.cursorId == null) return null;
    return O.findNodeById(state.doc.root, state.cursorId);
  }
  function selectRow(i, keepCol) {
    const rs = rows();
    if (i < 0 || i >= rs.length) return;
    const r = rs[i];
    state.cursorId = r.node.id;
    state.cursorContentIdx = r.kind === 'content' ? r.index : null;
    if (keepCol) state.caretCol = Math.min(state.goalCol, curLineText().length);
    else state.caretCol = 0;
  }

  // ------------------------------------------------------------- cursor movement (normal)
  function moveVis(rowsDelta) {
    const cur = cursorRow();
    const target = Math.max(0, Math.min(rows().length - 1, cur + rowsDelta));
    selectRow(target, true);
  }
  function motionDown(n) { n = n || 1; state.goalCol = state.caretCol; while (n--) moveVis(1); }
  function motionUp(n) { n = n || 1; state.goalCol = state.caretCol; while (n--) moveVis(-1); }
  function moveCaret(delta) {
    const len = curLineText().length;
    state.caretCol = Math.max(0, Math.min(len, state.caretCol + delta));
  }

  function nextSiblingNode() {
    const n = curNode(); if (!n || !n.__parent) return null;
    const sibs = n.__parent.children;
    const i = sibs.indexOf(n);
    return sibs[i + 1] || null;
  }
  function prevSiblingNode() {
    const n = curNode(); if (!n || !n.__parent) return null;
    const sibs = n.__parent.children;
    const i = sibs.indexOf(n);
    return sibs[i - 1] || null;
  }

  function gotoNextHeading(count, sameLevel) {
    const n = curNode(); if (!n) return;
    let level = sameLevel ? n.level : 1;
    // search flattened rows for next headline with level <= (level if !same: any)
    const rs = rows();
    let i = cursorRow();
    for (let j = i + 1; j < rs.length; j++) {
      if (rs[j].kind === 'headline' && (!sameLevel || rs[j].node.level <= level)) { selectRow(j); return; }
    }
  }
  function gotoPrevHeading(count, sameLevel) {
    const n = curNode(); if (!n) return;
    let level = sameLevel ? n.level : 1;
    const rs = rows();
    let i = cursorRow();
    for (let j = i - 1; j >= 0; j--) {
      if (rs[j].kind === 'headline' && (!sameLevel || rs[j].node.level <= level)) { selectRow(j); return; }
    }
  }

  // ------------------------------------------------------------- cycle visibility (TAB)
  function cycleVisible(node) {
    // org-like: if has children: collapsed? -> expand children too (show subtree) : -> collapse subtree content?
    if (!node.children.length && !node.content.length) return;
    if (node.collapsed) {
      node.collapsed = false;
      // expand first-level of subtree only (like SHOW_CHILDREN)
      node.children.forEach(function (c) { c.collapsed = false; });
    } else {
      node.collapsed = true;
    }
  }

  function indentNode(node, dir) {
    const p = node.__parent;
    if (!p) return;
    const idx = p.children.indexOf(node);
    if (dir > 0) { // deeper: last previous sibling becomes parent
      if (idx === 0) return;
      const prev = p.children[idx - 1];
      p.children.splice(idx, 1);
      prev.children.push(node);
      prev.collapsed = false;
      node.level = prev.level + 1;
      relevel(node);
    } else {
      if (node.level <= 1 || p === state.doc.root) return;
      // move up to grandparent, after p
      const gp = p.__parent;
      p.children.splice(idx, 1);
      const at = gp.children.indexOf(p) + 1;
      gp.children.splice(at, 0, node);
      node.level = p.level;
      relevel(node);
    }
    function relevel(n) {
      n.children.forEach(function (c) { c.level = n.level + 1; relevel(c); });
    }
    O.linkParents(state.doc.root);
  }

  // ------------------------------------------------------------- insert-mode editing
  // In insert mode a hidden textarea receives keystrokes for the current line.
  const editTa = document.createElement('textarea');
  editTa.id = 'edit-area';
  editTa.spellcheck = false;
  bufferEl.appendChild(editTa);

  function startInsert(pos) {
    state.mode = 'insert';
    updateModeBadge();
    const n = curNode();
    if (!n) return;
    // Headlines are edited as their full org text — TODO keyword,
    // [#A] priority and :tags: included — so it's just plain text.
    let text;
    if (state.cursorContentIdx === null) text = headlineEditable(n);
    else text = n.content[state.cursorContentIdx] || '';
    editTa.value = text;
    editTa.classList.remove('hidden');
    render();
    // position at the left edge of the editable text
    const cur = cursorRow();
    const el = bufferEl.children[cur];
    if (el) {
      let left = '1em';
      if (state.cursorContentIdx === null) {
        const stars = el.querySelector('.stars');
        if (stars) left = (stars.offsetLeft + stars.offsetWidth) + 'px';
      }
      editTa.style.left = left;
      editTa.style.top = (el.offsetTop) + 'px';
      editTa.style.width = Math.max(200, bufferEl.clientWidth - 60) + 'px';
    }
    editTa.style.height = '1.5em';
    editTa.focus();
    const caret = pos === 'start' ? 0 : pos === 'end' ? text.length :
      pos === 'after' ? Math.min(state.caretCol + 1, text.length) : Math.min(state.caretCol, text.length);
    editTa.setSelectionRange(caret, caret);
    renderLive();
  }

  function exitInsert(commit) {
    if (state.mode !== 'insert') return;
    const n = curNode();
    if (n) {
      const v = editTa.value;
      if (commit !== false) {
        if (state.cursorContentIdx === null) {
          applyHeadlineEdit(n, v);
          state.caretCol = headlineEditable(n).length;
        } else {
          n.content[state.cursorContentIdx] = v.replace(/\n/g, ' ');
          state.caretCol = Math.min(state.caretCol, (n.content[state.cursorContentIdx] || '').length);
        }
        markDirty();
      }
    }
    editTa.classList.add('hidden');
    editTa.blur();
    state.mode = 'normal';
    updateModeBadge();
    render();
  }

  function renderLive() {
    // hide the underlying rendered line while the textarea covers it
    const cur = cursorRow();
    const el = bufferEl.children[cur];
    if (el) {
      el.querySelectorAll('.kw, .prio, .hl-text, .tags, .trail, .foldmark, .content-text').forEach(function (t) { t.style.visibility = 'hidden'; });
    }
  }

  editTa.addEventListener('input', function () { markDirty(); });
  editTa.addEventListener('keydown', function (e) {
    if (state.mode !== 'insert') return;
    if (e.key === 'k' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // jk → Esc (vim-ish): if char before caret is 'j', remove it and leave insert
      const pos = editTa.selectionStart;
      if (pos > 0 && editTa.value[pos - 1] === 'j') {
        e.preventDefault();
        editTa.value = editTa.value.slice(0, pos - 1) + editTa.value.slice(pos);
        editTa.setSelectionRange(pos - 1, pos - 1);
        exitInsert(true);
        return;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      exitInsert(true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const n = curNode();
      if (!n) return;
      const v = editTa.value;
      if (state.cursorContentIdx === null) {
        // Enter inside a headline: org adds a body line below it
        applyHeadlineEdit(n, v);
        n.content.unshift('');
        state.cursorContentIdx = 0;
        markDirty();
        startInsert('start');
      } else {
        n.content[state.cursorContentIdx] = v;
        n.content.splice(state.cursorContentIdx + 1, 0, '');
        state.cursorContentIdx++;
        markDirty();
        startInsert('start');
      }
      render();
      return;
    }
    if (e.key === 'Tab') { e.preventDefault(); return; }
    // keep live render of rest of buffer stable: only hide current line
    e.stopPropagation();
  });

  // ------------------------------------------------------------- operators
  function runOperator(op, motion) {
    const n = curNode();
    if (!n) return;
    if (motion === 'd') { // line
      if (op === 'd') {
        if (state.cursorContentIdx === null) {
          // delete whole subtree under cursor node (save to kill ring)
          if (n.__parent) {
            killRing = cloneSubtree(n);
            const idx = cursorRow();
            O.removeNode(n);
            markDirty(); flash('subtree killed');
            // re-anchor cursor at the same visual position (vim dd behavior)
            state.cursorId = null; state.cursorContentIdx = null;
            if (rows().length) selectRow(Math.min(idx, rows().length - 1));
          }
        } else {
          killRing = null;
          n.content.splice(state.cursorContentIdx, 1);
          if (state.cursorContentIdx >= n.content.length) state.cursorContentIdx = null;
          markDirty();
        }
        state.mode = 'normal'; state.operator = null; updateModeBadge();
        render();
      } else if (op === 'c') {
        state.mode = 'normal'; state.operator = null; // startInsert below flips to insert
        if (state.cursorContentIdx === null) { startInsert('start'); }
        else { n.content[state.cursorContentIdx] = ''; startInsert('start'); }
        return; // stay in insert mode
      } else if (op === '>') {
        if (state.cursorContentIdx === null) { indentNode(n, 1); markDirty(); render(); }
      } else if (op === '<') {
        if (state.cursorContentIdx === null) { indentNode(n, -1); markDirty(); render(); }
      }
    } else if (motion === 'i') {
      runOperator(op, 'd');
      return;
    }
    state.mode = 'normal';
    state.operator = null;
    updateModeBadge();
  }

  // ------------------------------------------------------------- dates (minibuffer)
  // Org-style: dates are typed at a prompt, no calendar widget.
  // Accepts YYYY-MM-DD, DD.MM[.YYYY], today, +3d, -1w (empty/clear removes).
  const dateHistory = [];
  function datePrompt(field) {
    const n = curNode();
    if (!n) return;
    const label = field === 'deadline' ? 'DEADLINE' : 'SCHEDULED';
    const cur = n[field];
    minibufferPrompt('YYYY-MM-DD, today, +3d (empty clears)', function (v) {
      const r = O.parseDateInput(v);
      if (r === null) { flash('bad date: ' + v, 'warn'); return; }
      const dstr = r.clear ? null : r.date;
      n[field] = dstr;
      markDirty();
      flash(label.toLowerCase() + (dstr ? ': ' + O.humanDate(dstr) : ' cleared'));
      render(); renderAgenda();
    }, { value: cur || '', prefix: label + ': ', history: dateHistory });
  }

  // ------------------------------------------------------------- agenda
  function renderAgenda() {
    if (agendaPanel.classList.contains('hidden')) return;
    const items = O.agenda(state.doc.root, 14);
    if (!items.length) {
      agendaBody.innerHTML = '<div class="agenda-empty">Nothing due in the next 14 days.</div>';
      return;
    }
    let html = '';
    let lastDate = null;
    items.forEach(function (it, i) {
      if (it.date !== lastDate) {
        if (lastDate !== null) html += '<div class="agenda-gap"></div>';
        html += '<div class="agenda-date' + (it.overdue ? ' overdue' : '') + '">' +
          (it.overdue ? '!! OVERDUE ' : '') + O.humanDate(it.date) + '</div>';
        lastDate = it.date;
      }
      html += '<div class="agenda-item' + (it.overdue ? ' overdue' : '') + '" data-idx="' + i + '">' +
        '<span class="agenda-kind">' + (it.kind === 'deadline' ? 'DL' : 'SC') + '</span> ' +
        '<span class="agenda-state">' + (it.node.state || '-') + '</span> ' +
        esc(it.node.headline) +
        '</div>';
    });
    agendaBody.innerHTML = html;
    agendaBody._items = items;
  }
  agendaBody.addEventListener('click', function (e) {
    const t = e.target.closest('.agenda-item');
    if (!t) return;
    const it = agendaBody._items[Number(t.dataset.idx)];
    if (it) jumpToNode(it.node);
  });
  function jumpToNode(node) {
    // expand ancestors
    let p = node.__parent;
    while (p && p !== state.doc.root) { p.collapsed = false; p = p.__parent; }
    state.cursorId = node.id;
    state.cursorContentIdx = null;
    state.caretCol = 0;
    render();
  }
  function toggleAgenda() {
    agendaPanel.classList.toggle('hidden');
    if (!agendaPanel.classList.contains('hidden')) {
      renderAgenda();
      agendaPanel.classList.add('open');
    } else {
      agendaPanel.classList.remove('open');
    }
  }

  // ------------------------------------------------------------- tag entry
  function tagPrompt() {
    const n = curNode();
    if (!n || state.cursorContentIdx !== null) { flash('tags live on headlines', 'warn'); return; }
    const existing = n.tags.join(':');
    minibufferPrompt('Tags (colon-separated): ' + (existing || 'none'), function (v) {
      const tags = v.split(':').map(s => s.trim().replace(/:/g, '')).filter(Boolean);
      n.tags = Array.from(new Set(tags));
      markDirty();
      flash('tags: ' + (n.tags.join(':') || '(none)'));
      render();
    }, { value: existing, history: tagHistory });
  }

  // ------------------------------------------------------------- priority
  function setPriority(p) {
    const n = curNode();
    if (!n || state.cursorContentIdx !== null) return;
    n.priority = n.priority === p ? null : p;
    markDirty();
    flash(n.priority ? 'priority #' + n.priority : 'priority cleared');
    render();
  }

  // ------------------------------------------------------------- export / import
  function downloadText(name, text) {
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  }

  // ------------------------------------------------------------- help overlay
  const HELP = [
    ['CURSOR', [
      ['h / l / ← / →', 'left / right on the line'],
      ['j / k / ↓ / ↑', 'down / up (body lines too)'],
      ['w / b', 'next / prev heading'],
      ['W / B', 'next / prev same-level heading'],
      ['g g / G', 'top / bottom'],
      ['`', 'toggle agenda view'],
      ['(count) j/k/h/l', 'e.g. 5j jumps down 5 rows'],
    ]],
    ['FOLDING', [
      ['TAB', 'cycle visibility of subtree'],
      ['zo / zc', 'open / close fold'],
      ['zm / zr', 'collapse all / show all'],
      ['zA', 'show entire subtree'],
    ]],
    ['EDITING', [
      ['i / I', 'insert at caret / line start'],
      ['a / A', 'insert after caret / line end'],
      ['i on a heading', 'edits the org line: TODO, [#A], :tags:'],
      ['Esc / jk / Ctrl-[', 'back to normal'],
      ['x', 'delete body line'],
      ['dd', 'kill subtree (headlines) / line'],
      ['cc', 'change line (insert)'],
      ['y / p', 'yank subtree / paste below'],
      ['o / O', 'new heading below / above'],
      ['u / Ctrl-R', 'undo / redo'],
    ]],
    ['STRUCTURE', [
      ['>> / <<', 'indent / outdent subtree'],
      ['J / K', 'move subtree down / up'],
      ['M-up / M-down (M-k / M-j)', 'move section up / down'],
      ['M-left / M-right (M-h / M-l)', 'promote / demote section'],
      ['T / S-TAB', 'cycle TODO→STARTED→WAITING→DONE'],
      ['D', 'mark DONE'],
      ['M-Enter', 'new heading below (in insert)'],
    ]],
    ['TAGS & DATES', [
      ['t t', 'set tags (minibuffer, colon-separated)'],
      ['t d', 'deadline (typed date)'],
      ['t s', 'scheduled (typed date)'],
      ['t x', 'clear both dates'],
      ['+ / -', 'deadline +1 / -1 day'],
      ['[ / ]', 'priority up / down (A B C)'],
    ]],
    ['FILES & MISC', [
      ['gg a', 'toggle agenda view'],
      ['?', 'this help'],
      [':w', 'save (auto-saved anyway)'],
      [':e', 'import .org file'],
      [':q', 'export .org download'],
      [':t', 'cycle TODO state'],
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

  // ------------------------------------------------------------- clipboard & history
  let killRing = null; // {node clone} or line
  function yankSubtree() {
    const n = curNode();
    if (!n || state.cursorContentIdx !== null) return;
    killRing = cloneSubtree(n);
    flash('yanked subtree: ' + (n.headline || '(untitled)'));
  }
  function cloneSubtree(n) {
    // makeNode assigns a fresh id on every call — clones never share ids with the tree
    const c = O.makeNode({ level: n.level, state: n.state, headline: n.headline, tags: n.tags.slice(), priority: n.priority, deadline: n.deadline, scheduled: n.scheduled, closed: n.closed, content: n.content.slice(), collapsed: n.collapsed });
    c.children = n.children.map(cloneSubtree);
    return c;
  }
  function pasteBelow() {
    if (!killRing) return;
    const n = curNode(); if (!n) return;
    const clone = cloneSubtree(killRing);
    const p = n.__parent;
    const i = p.children.indexOf(n);
    clone.level = n.level;
    p.children.splice(i + 1, 0, clone);
    // fix levels of pasted subtree
    (function fix(m) { m.children.forEach(function (k) { k.level = m.level + 1; fix(k); }); })(clone);
    O.linkParents(state.doc.root);
    state.cursorId = clone.id; state.cursorContentIdx = null;
    markDirty(); render();
  }

  // undo stack
  function snapshot() {
    const s = O.serialize(state.doc.root, state.doc.docTitle, state.doc.preface);
    if (state.history[state.histIdx] === s) return;
    state.history = state.history.slice(0, state.histIdx + 1);
    state.history.push(s);
    if (state.history.length > 100) state.history.shift();
    state.histIdx = state.history.length - 1;
  }
  let snapTimer = null;
  function snapshotSoon() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(snapshot, 500);
  }

  function undo() {
    if (state.histIdx <= 0) { flash('already at oldest change'); return; }
    state.histIdx--;
    restore(state.history[state.histIdx]);
  }
  function redo() {
    if (state.histIdx >= state.history.length - 1) { flash('nothing to redo'); return; }
    state.histIdx++;
    restore(state.history[state.histIdx]);
  }
  function restore(text) {
    const path = cursorPath();
    const contentIdx = state.cursorContentIdx;
    state.doc = O.parse(text);
    O.linkParents(state.doc.root);
    let restored = path ? nodeByPath(path) : null;
    if (restored) {
      // make sure ancestors are expanded so the cursor is visible
      let p = restored.__parent;
      while (p && p !== state.doc.root) { p.collapsed = false; p = p.__parent; }
      state.cursorId = restored.id;
      const n = restored;
      state.cursorContentIdx = (contentIdx != null && contentIdx < n.content.length) ? contentIdx : null;
    } else {
      const first = O.flatten(state.doc.root)[0];
      state.cursorId = first ? first.node.id : null;
      state.cursorContentIdx = null;
    }
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

  function onKeyDown(e) {
    // global overrides
    if (!$('#help-overlay').classList.contains('hidden')) {
      if (e.key === 'Escape' || e.key === 'q' || e.key === '?') {
        showHelp(false);
        if (promptActive) { closePrompt(); render(); }  // don't strand the minibuffer
        e.preventDefault();
      }
      return;
    }
    if (promptActive) return; // input focused, stopPropagation handles it

    // ctrl combos in any mode
    if (e.ctrlKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'r') { e.preventDefault(); redo(); return; }
      return;
    }
    if (e.altKey) return; // M-keys handled by the capture-phase listener

    if (state.mode === 'insert') {
      if (e.key === 'Escape') { e.preventDefault(); exitInsert(true); return; }
      // Ctrl-[ acts as Esc
      if (e.key === '[' && e.ctrlKey) { e.preventDefault(); exitInsert(true); return; }
      return; // textarea edits natively
    }

    // ---- NORMAL / OPERATOR MODE ----
    if (document.activeElement === editTa) editTa.blur();
    e.preventDefault();

    const k = e.key;

    // operator pending
    if (state.mode === 'operator') {
      const op = state.operator;
      state.mode = 'normal'; state.operator = null; updateModeBadge();
      if (k === 'd' || k === 'x') runOperator(op, 'd');
      else if (k === 'i') runOperator(op, 'i');
      else if (k === '>' || k === '<') runOperator(op === '>' ? '>' : '<', 'd');
      else if (k === 's') { // operator s + deadline/scheduled handled via t map; ignore
      }
      return;
    }

    // numbers build count
    if (/[0-9]/.test(k) && (countBuf || k !== '0')) { countBuf += k; updateCountHint(); return; }
    if (k === '0' && !countBuf) { state.caretCol = 0; render(); return; }

    const count = takeCount();
    clearCountHint();

    // two-step 't' tag/deadline map and ':' commands handled with pendingMap
    if (pendingMap === 't') {
      pendingMap = null;
      handleTMap(k); return;
    }

    switch (k) {
      // arrows: h/l move the caret on the line; j/k move between lines
      case 'ArrowDown': motionDown(count || 1); break;
      case 'ArrowUp': motionUp(count || 1); break;
      case 'ArrowLeft': moveCaret(-(count || 1)); break;
      case 'ArrowRight': moveCaret(count || 1); break;
      case 'h': moveCaret(-(count || 1)); break;
      case 'j': motionDown(count || 1); break;
      case 'k': motionUp(count || 1); break;
      case 'l': moveCaret(count || 1); break;
      case 'w': gotoNextHeading(count || 1, false); break;
      case 'b': gotoPrevHeading(count || 1, false); break;
      case 'W': gotoNextHeading(count || 1, true); break;
      case 'B': gotoPrevHeading(count || 1, true); break;
      case 'g': pendingG = true; return; // wait for second g
      case 'G': { const rs = rows(); selectRow(rs.length - 1); render(); break; }
      // mode switches
      case 'i': startInsert('caret'); break;
      case 'I': startInsert('start'); break;
      case 'a': startInsert('after'); break;
      case 'A': startInsert('end'); break;
      case 'o': {
        const n = curNode();
        if (!n) break;
        if (state.cursorContentIdx === null) {
          // open a new sibling heading below (org M-RET style)
          if (!n.__parent) { flash('no parent for sibling', 'warn'); break; }
          const sib = O.insertSiblingAfter(n);
          state.cursorId = sib.id; state.cursorContentIdx = null;
          markDirty(); render(); startInsert('start');
        } else {
          n.content.splice(state.cursorContentIdx + 1, 0, '');
          state.cursorContentIdx++;
          markDirty(); render(); startInsert('start');
        }
        break;
      }
      case 'O': {
        const n = curNode();
        if (!n) break;
        if (state.cursorContentIdx === null) {
          if (!n.__parent) { flash('no parent for sibling', 'warn'); break; }
          const sib = O.insertSiblingBefore(n);
          state.cursorId = sib.id; state.cursorContentIdx = null;
          markDirty(); render(); startInsert('start');
        } else {
          n.content.splice(state.cursorContentIdx, 0, '');
          markDirty(); render(); startInsert('start');
        }
        break;
      }
      // fold
      case 'Tab': {
        const n = curNode();
        if (!n) break;
        if (e.shiftKey) {
          if (state.cursorContentIdx === null) { snapshotSoon(); O.cycleState(n); markDirty(); flash(n.state || 'no state'); render(); renderAgenda(); }
        } else {
          cycleVisible(n); markDirty(); render();
        }
        break;
      }
      // state cycle via explicit S-TAB handled above
      case 'D': { const n = curNode(); if (n && state.cursorContentIdx === null) { snapshotSoon(); n.state = 'DONE'; n.closed = O.todayStr(); markDirty(); render(); renderAgenda(); } break; }
      // simple TODO cycle: T (no S-TAB gymnastics needed)
      case 'T': { const n = curNode(); if (n && state.cursorContentIdx === null) { snapshotSoon(); O.cycleState(n); markDirty(); flash(n.state || 'no state'); render(); renderAgenda(); } break; }
      // agenda view
      case '`': toggleAgenda(); break;
      // edit
      case 'x': {
        const n = curNode();
        if (n && state.cursorContentIdx !== null) {
          n.content.splice(state.cursorContentIdx, 1);
          if (state.cursorContentIdx >= n.content.length) state.cursorContentIdx = null;
          markDirty();
        } else {
          flash('x deletes body lines; use dd on headlines', 'warn');
        }
        break;
      }
      case 'd': state.mode = 'operator'; state.operator = 'd'; updateModeBadge(); break;
      case 'c': state.mode = 'operator'; state.operator = 'c'; updateModeBadge(); break;
      case 'y': yankSubtree(); break;
      case 'p': pasteBelow(); break;
      // indent
      case '>': pendingOp = k; handleIndent(count); break;
      case '<': pendingOp = k; handleIndent(count); break;
      // move subtree
      case 'J': { const n = curNode(); if (n) { const sib = nextSiblingNode(); if (sib && n.__parent === sib.__parent) { const p = n.__parent; p.children.splice(p.children.indexOf(n), 1); p.children.splice(p.children.indexOf(sib) + 1, 0, n); O.linkParents(state.doc.root); markDirty(); render(); } } break; }
      case 'K': { const n = curNode(); if (n) { const sib = prevSiblingNode(); if (sib && n.__parent === sib.__parent) { const p = n.__parent; p.children.splice(p.children.indexOf(n), 1); p.children.splice(p.children.indexOf(sib), 0, n); O.linkParents(state.doc.root); markDirty(); render(); } } break; }
      // tags/dates map
      case 't': pendingMap = 't'; flash('t: d=deadline s=scheduled t=tags x=clear', 'hint'); break;
      // priority
      case '[': { const n = curNode(); if (n && state.cursorContentIdx === null) { const order = ['A', 'B', 'C']; if (!n.priority) n.priority = 'A'; else { const i = order.indexOf(n.priority); n.priority = order[Math.max(0, i - 1)]; } markDirty(); flash('priority #' + n.priority); render(); } break; }
      case ']': { const n = curNode(); if (n && state.cursorContentIdx === null) { const order = ['A', 'B', 'C']; if (!n.priority) n.priority = 'C'; else { const i = order.indexOf(n.priority); n.priority = order[Math.min(2, i + 1)]; } markDirty(); flash('priority #' + n.priority); render(); } break; }
      // deadline nudges
      case '+': { const n = curNode(); if (n && n.deadline) { n.deadline = O.addDays(n.deadline, (count || 1)); markDirty(); flash('deadline ' + O.humanDate(n.deadline)); render(); renderAgenda(); } break; }
      case '-': { const n = curNode(); if (n && n.deadline) { n.deadline = O.addDays(n.deadline, -(count || 1)); markDirty(); flash('deadline ' + O.humanDate(n.deadline)); render(); renderAgenda(); } break; }
      // agenda (g a handled in capture-phase g-map)
      // help
      case '?': showHelp(true); break;
      // undo
      case 'u': undo(); break;
      // colon commands
      case ':': startColon(); break;
      case 'z': pendingZ = true; flash('z: o/c/m/r/A', 'hint'); break;
      default:
        // 'g' second key
        if (pendingG) {
          pendingG = false;
          if (k === 'g') { const rs = rows(); selectRow(0); render(); }
          return;
        }
        countBuf = '';
    }
    if (state.mode !== 'insert') render();
    snapshotSoon();
  }

  let pendingG = false, pendingZ = false, pendingMap = null, pendingOp = null;

  function handleIndent(count) {
    const n = curNode();
    if (!n || state.cursorContentIdx !== null) { flash('indent applies to headlines', 'warn'); return; }
    for (let i = 0; i < (count || 1); i++) indentNode(n, pendingOp === '>' ? 1 : -1);
    markDirty(); render();
    pendingOp = null;
  }

  function handleTMap(k) {
    if (k === 'd' || k === 's') {
      datePrompt(k === 'd' ? 'deadline' : 'scheduled');
    } else if (k === 't') {
      tagPrompt();
    } else if (k === 'x') {
      const n = curNode();
      if (n) { n.deadline = null; n.scheduled = null; markDirty(); flash('dates cleared'); render(); renderAgenda(); }
    } else {
      flash('t-map: d s t x', 'warn');
    }
  }

  // ------------------------------------------------------------- org section moves
  // M-up/down: move section among siblings · M-left/right: promote/demote.
  // Mirrors org-mode's M-<arrows>. From a body line, moves that heading.
  function handleAltKey(k) {
    const n = curNode();
    if (!n) return;
    let ok = false;
    if (k === 'ArrowDown' || k === 'j') ok = O.moveNodeAmongSiblings(state.doc.root, n, +1);
    else if (k === 'ArrowUp' || k === 'k') ok = O.moveNodeAmongSiblings(state.doc.root, n, -1);
    else if (k === 'ArrowRight' || k === 'l') ok = O.demoteNode(state.doc.root, n);
    else if (k === 'ArrowLeft' || k === 'h') ok = O.promoteNode(state.doc.root, n);
    else return; // not one of ours; let it bubble
    if (!ok) { flash('section move blocked (edge of list / already top level)', 'hint'); return; }
    snapshotSoon();
    markDirty(); render(); renderAgenda();
  }

  // z-map: second key
  function handleZ(k) {
    const n = curNode();
    pendingZ = false;
    if (!n) return;
    if (k === 'o') { n.collapsed = false; render(); }
    else if (k === 'c') { n.collapsed = true; render(); }
    else if (k === 'm') { O.flatten(state.doc.root).forEach(function (r) { if (r.kind === 'headline' && r.node.children.length) r.node.collapsed = true; }); render(); }
    else if (k === 'r') { O.flatten(state.doc.root).forEach(function (r) { if (r.kind === 'headline') r.node.collapsed = false; }); render(); }
    else if (k === 'A') { // expand subtree fully
      (function exp(m) { m.collapsed = false; m.children.forEach(exp); })(n); render();
    }
  }

  function alignTags() {
    // pad headlines so tags right-align — a light org-org-alignTags
    markDirty();
    render();
  }

  // Capture phase: M-keys (org section moves), M-Enter, and g/z pending maps.
  // Runs before every other keydown handler so Alt+arrows can't trigger the
  // browser's back/forward navigation.
  document.addEventListener('keydown', function (e) {
    if (promptActive) return; // minibuffer has focus; keys belong to it
    if (!$('#help-overlay').classList.contains('hidden')) return;

    if (e.altKey && !e.ctrlKey) {
      const k = e.key;
      if (k === 'Enter') {
        // M-RET: new sibling heading below (org-native), both modes
        e.preventDefault(); e.stopPropagation();
        if (state.mode === 'insert') exitInsert(true);
        const n = curNode();
        if (!n || !n.__parent) return;
        const sib = O.insertSiblingAfter(n);
        state.cursorId = sib.id; state.cursorContentIdx = null;
        snapshotSoon();
        markDirty(); render(); startInsert('start');
        return;
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'h', 'j', 'k', 'l'].indexOf(k) >= 0) {
        e.preventDefault(); e.stopPropagation();
        if (state.mode === 'insert') exitInsert(true); // commit, then move (normal mode)
        handleAltKey(k);
        return;
      }
      return; // other M-keys: fall through to normal handling
    }

    if (e.ctrlKey && e.shiftKey && e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (state.mode === 'insert') exitInsert(true);
      const n = curNode();
      if (!n) return;
      const child = O.insertChildEnd(n);
      state.cursorId = child.id; state.cursorContentIdx = null;
      snapshotSoon();
      markDirty(); render(); startInsert('start');
      return;
    }

    if (state.mode === 'insert') return;
    // g-map: gg = top. (agenda is on backtick, kept separate to avoid shadowing)
    if (pendingG) {
      pendingG = false;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'g') { selectRow(0); render(); }
      return;
    }
    if (pendingZ) {
      pendingZ = false;
      e.preventDefault(); e.stopPropagation();
      handleZ(e.key);
      render();
      return;
    }
  }, true); // capture phase handles M-keys and g/z first

  function startColon() {
    // simple command line in minibuffer
    minibufferPrompt(':', function (cmd) {
      cmd = cmd.trim().toLowerCase();
      if (cmd === 'w') { persist(); flash('saved to browser storage'); }
      else if (cmd === 'q') { downloadText((state.doc.docTitle || 'weborg').toLowerCase().replace(/\s+/g, '-') + '.org', O.serialize(state.doc.root, state.doc.docTitle, state.doc.preface)); flash('exported .org'); }
      else if (cmd === 'e') { $('#import-input').click(); flash('choose file'); }
      else if (cmd === 'wq' || cmd === 'x') { persist(); flash('saved'); }
      else if (cmd === 't') { const n = curNode(); if (n) { O.cycleState(n); markDirty(); render(); } }
      else if (cmd === 'help') showHelp(true);
      else if (cmd === 'a') toggleAgenda();
      else flash('unknown command: ' + cmd, 'warn');
      render();
    }, { history: colonHistory, prefix: ':' });
  }

  $('#import-input').addEventListener('change', function (e) {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = function () {
      state.doc = O.parse(r.result);
      O.linkParents(state.doc.root);
      const first = O.flatten(state.doc.root)[0];
      state.cursorId = first ? first.node.id : null;
      state.cursorContentIdx = null;
      state.history = []; state.histIdx = -1;
      snapshot();
      persist(); render(); renderAgenda();
      flash('imported ' + f.name);
    };
    r.readAsText(f);
    e.target.value = '';
  });

  function updateCountHint() {
    cursorInfo.textContent = countBuf + ' ×';
  }
  function clearCountHint() {}

  // click-to-focus: let users click a line to move cursor (still keyboard-edit)
  bufferEl.addEventListener('click', function (e) {
    const el = e.target.closest('.line');
    if (!el) return;
    const i = Array.prototype.indexOf.call(bufferEl.children, el);
    selectRow(i);
    render();
    editTa.blur();
  });

  // ------------------------------------------------------------- boot
  window.addEventListener('beforeunload', function () {
    if (dirty) persist();
  });

  loadDoc();
  snapshot();
  updateModeBadge();
  render();

  document.addEventListener('keydown', onKeyDown);

  // expose for tests/debugging
  window.__weborg = { state, O, render };
})();
