/* weborg core: org parsing, tree model, serialization, date helpers.
 * Pure logic — no DOM. Works in browser (window.Org) and Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Org = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TODO_STATES = ['TODO', 'STARTED', 'WAITING', 'DONE'];

  // ---------------------------------------------------------------- dates
  // All dates are 'YYYY-MM-DD' strings; local-midnight arithmetic only.
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function parseDate(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]) - 1, da = Number(m[3]);
    const d = new Date(y, mo, da);
    if (isNaN(d)) return null;
    // round-trip check: new Date(2026,1,30) silently rolls to Mar 2
    if (d.getFullYear() !== y || d.getMonth() !== mo || d.getDate() !== da) return null;
    return d;
  }
  function dateToStr(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function addDays(s, n) {
    const d = parseDate(s); if (!d) return null;
    d.setDate(d.getDate() + n);
    return dateToStr(d);
  }
  function daysBetween(a, b) {
    const da = parseDate(a), db = parseDate(b);
    if (!da || !db) return null;
    return Math.round((db - da) / 86400000);
  }
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  function dayName(s) { const d = parseDate(s); return d ? WEEKDAYS[d.getDay()] : ''; }
  function humanDate(s) {
    const d = parseDate(s); if (!d) return s;
    return dayName(s) + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear();
  }

  // Free-form date entry (minibuffer): 'YYYY-MM-DD', 'DD.MM.YYYY', 'today',
  // '+3d'/'-1w' relative. Returns {date}, {clear:true}, or null if garbage.
  function parseDateInput(s) {
    s = String(s == null ? '' : s).trim().toLowerCase();
    if (!s || s === 'clear' || s === 'none') return { clear: true };
    if (s === 'today' || s === 't' || s === '.') return { date: todayStr() };
    let m = /^([+-])\s*(\d+)\s*(d|w)?$/.exec(s);
    if (m) {
      const n = Number(m[2]) * (m[3] === 'w' ? 7 : 1) * (m[1] === '-' ? -1 : 1);
      return { date: addDays(todayStr(), n) };
    }
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return parseDate(s) ? { date: s } : null;
    m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(s);
    if (m) {
      const y = m[3] ? Number(m[3]) : new Date().getFullYear();
      const cand = y + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[1]));
      return parseDate(cand) ? { date: cand } : null;
    }
    return null;
  }

  // ---------------------------------------------------------------- model
  let _id = 1;
  function nextId() { return _id++; }

  function makeNode(props) {
    return Object.assign({
      id: nextId(),
      level: 1,
      state: null,           // 'TODO'|'STARTED'|'WAITING'|'DONE'|null
      headline: '',
      tags: [],              // ['phone', ...] — no ':' chars
      priority: null,        // 'A'|'B'|'C'|null
      deadline: null,        // 'YYYY-MM-DD'|null
      scheduled: null,
      closed: null,
      content: [],           // body lines (strings, no leading '*')
      collapsed: false,
      children: [],          // child nodes
      line: 0,               // filled by parser (visual line index)
    }, props || {});
  }

  const HEADLINE_RE = /^(\*+) (?:([A-Z]+) )?(?:\[#([ABC])\] )?(.*?)(?::((?:[A-Za-z0-9_@#]+:)+))?\s*$/;
  const DEADLINE_RE = /^[ \t]*(DEADLINE|SCHEDULED):\s*<?(\d{4}-\d{2}-\d{2})/;
  const CLOSED_RE = /^[ \t]*CLOSED:\s*<?(\d{4}-\d{2}-\d{2})/;

  function parseHeadlineLine(line) {
    const m = HEADLINE_RE.exec(line);
    if (!m) return null;
    const stars = m[1].length;
    let state = m[2] || null;
    let rest = m[4] || '';
    let priority = m[3] || null;
    const tags = m[5] ? m[5].split(':').filter(Boolean) : [];
    if (state && !TODO_STATES.includes(state)) {
      // Not a known keyword — fold it back into the headline text.
      rest = state + (rest ? ' ' + rest : '');
      state = null;
      // 'FOO [#A] bar' — the [#A] was in group 3 already; re-scan for one in text.
      const pm = /^\[#([ABC])\]\s+(.*)$/.exec(rest);
      if (pm) { priority = pm[1]; rest = pm[2]; }
    }
    return { level: stars, state: state, priority: priority, headline: rest.trim(), tags: tags };
  }

  function parse(text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const root = makeNode({ level: 0 });       // virtual root
    const stack = [root];
    let docTitle = null;
    let pendingNode = null;   // node whose property lines we may still consume
    let preface = [];         // lines before the first heading
    let sawHeading = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];

      // file-level title line: #+TITLE: foo
      const tm = /^#\+TITLE:\s*(.*)$/i.exec(raw);
      if (tm) { docTitle = tm[1].trim(); continue; }

      const hl = parseHeadlineLine(raw);
      if (hl) {
        const node = makeNode(Object.assign({ line: i }, hl));
        while (stack.length > 1 && stack[stack.length - 1].level >= node.level) stack.pop();
        const parent = stack[stack.length - 1];
        parent.children.push(node);
        stack.push(node);
        pendingNode = node;
        sawHeading = true;
        continue;
      }

      const pm = DEADLINE_RE.exec(raw);
      if (pm && pendingNode) {
        if (pm[1] === 'DEADLINE') pendingNode.deadline = pm[2];
        else pendingNode.scheduled = pm[2];
        continue;
      }
      const cm = CLOSED_RE.exec(raw);
      if (cm && pendingNode) { pendingNode.closed = cm[1]; continue; }

      // body line (blank lines included so paragraph breaks survive)
      if (sawHeading) {
        stack[stack.length - 1].content.push(raw);
      } else {
        preface.push(raw);
      }
    }

    renumber(root, 0);
    // strip trailing blank content lines (usually just the file's final newline)
    (function strip(n) {
      n.children.forEach(strip);
      while (n.content.length && /^\s*$/.test(n.content[n.content.length - 1])) n.content.pop();
    })(root);
    const keptPreface = preface.some(function (l) { return !/^\s*$/.test(l); }) ? preface : null;
    return { root: root, docTitle: docTitle || null, preface: keptPreface };
  }

  function renumber(node, depth) {
    // assign visual line numbers for the flattened visible view; ids stay stable
    node.children.forEach(function (c) { renumber(c, depth + 1); });
  }

  // Flatten tree into rows: [{node, kind:'headline'} | {node, kind:'content', line, index}]
  // Hidden = collapsed ancestor's content+children omitted (like org cycle visibility).
  function flatten(root, includeHiddenContent) {
    const rows = [];
    function walk(node) {
      for (const child of node.children) {
        rows.push({ kind: 'headline', node: child });
        const showBody = includeHiddenContent || !child.collapsed;
        if (showBody) {
          child.content.forEach(function (ln, idx) {
            rows.push({ kind: 'content', node: child, text: ln, index: idx });
          });
        }
        if (!child.collapsed) walk(child);
      }
    }
    walk(root);
    return rows;
  }

  function serialize(root, docTitle, preface) {
    const out = [];
    if (docTitle) out.push('#+TITLE: ' + docTitle);
    if (preface && preface.length) {
      preface.forEach(function (l) { out.push(l); });
      if (out.length && !/^\s*$/.test(out[out.length - 1])) out.push('');
    }
    function emit(node) {
      let s = '*'.repeat(node.level) + ' ';
      if (node.state) s += node.state + ' ';
      if (node.priority) s += '[#' + node.priority + '] ';
      s += node.headline;
      if (node.tags.length) s += '  :' + node.tags.join(':') + ':';
      out.push(s);
      const props = [];
      if (node.scheduled) props.push('SCHEDULED: <' + node.scheduled + '>');
      if (node.deadline) props.push('DEADLINE: <' + node.deadline + '>');
      if (node.closed) props.push('CLOSED: <' + node.closed + '>');
      props.forEach(function (p) { out.push('  ' + p); });
      node.content.forEach(function (ln) { out.push(ln); });
      node.children.forEach(emit);
    }
    root.children.forEach(emit);
    return out.join('\n') + '\n';
  }

  // ---------------------------------------------------------------- ops
  function toggleCollapsed(node) { node.collapsed = !node.collapsed; }

  function cycleState(node) {
    const order = [null].concat(TODO_STATES);
    let i = order.indexOf(node.state);
    i = (i + 1) % order.length;
    const prev = node.state;
    node.state = order[i];
    if (node.state === 'DONE') {
      node.closed = todayStr();
      if (prev !== 'DONE') node.collapsed = false;
    } else if (prev === 'DONE') {
      node.closed = null;
    }
    return node.state;
  }

  function setDeadline(node, date) { node.deadline = date; }
  function setScheduled(node, date) { node.scheduled = date; }

  function addTag(node, tag) {
    tag = String(tag).trim().replace(/:/g, '');
    if (!tag) return false;
    if (!node.tags.includes(tag)) node.tags.push(tag);
    return true;
  }
  function removeTag(node, tag) {
    const i = node.tags.indexOf(tag);
    if (i >= 0) { node.tags.splice(i, 1); return true; }
    return false;
  }

  function insertSiblingAfter(node) {
    const parent = node.__parent;
    const idx = parent.children.indexOf(node);
    const sib = makeNode({ level: node.level, headline: '' });
    parent.children.splice(idx + 1, 0, sib);
    sib.__parent = parent;
    return sib;
  }
  function insertSiblingBefore(node) {
    const parent = node.__parent;
    const idx = parent.children.indexOf(node);
    const sib = makeNode({ level: node.level, headline: '' });
    parent.children.splice(idx, 0, sib);
    sib.__parent = parent;
    return sib;
  }
  function insertChildEnd(node) {
    const child = makeNode({ level: node.level + 1, headline: '' });
    child.__parent = node;
    node.children.push(child);
    node.collapsed = false;
    return child;
  }
  function linkParents(root) {
    root.__parent = null;
    (function walk(n) {
      n.children.forEach(function (c) { c.__parent = n; walk(c); });
    })(root);
  }
  function removeNode(node) {
    const p = node.__parent;
    if (!p) return false;
    const idx = p.children.indexOf(node);
    p.children.splice(idx, 1);
    return true;
  }

  // ------------------------------------------------- structural moves
  // Org-style M-arrow section operations. All work on __parent links
  // (linkParents is called defensively so callers never have to).
  function relevelFrom(node, level) {
    node.level = level;
    node.children.forEach(function (c) { relevelFrom(c, level + 1); });
  }
  // M-down / M-up: swap with next/prev sibling (subtree moves as a unit)
  function moveNodeAmongSiblings(root, node, dir) {
    linkParents(root);
    const p = node.__parent;
    if (!p) return false;
    const i = p.children.indexOf(node);
    const j = i + dir;
    if (j < 0 || j >= p.children.length) return false;
    p.children.splice(i, 1);
    p.children.splice(j, 0, node);
    return true;
  }
  // M-right / >>: hang under previous sibling (outliner demote)
  function demoteNode(root, node) {
    linkParents(root);
    const p = node.__parent;
    if (!p) return false;
    const idx = p.children.indexOf(node);
    if (idx === 0) return false;          // nothing to hang under
    const prev = p.children[idx - 1];
    p.children.splice(idx, 1);
    prev.children.push(node);
    prev.collapsed = false;
    relevelFrom(node, prev.level + 1);
    return true;
  }
  // M-left / <<: move up next to parent (outliner promote)
  function promoteNode(root, node) {
    linkParents(root);
    const p = node.__parent;
    if (!p || p === root || node.level <= 1) return false;
    const gp = p.__parent;
    if (!gp) return false;
    const idx = p.children.indexOf(node);
    p.children.splice(idx, 1);
    gp.children.splice(gp.children.indexOf(p) + 1, 0, node);
    relevelFrom(node, p.level);
    return true;
  }

  // ---------------------------------------------------------------- agenda
  // Returns [{node, kind:'deadline'|'scheduled', date, overdue}] sorted by date.
  function agenda(root, days) {
    days = days || 14;
    const today = todayStr();
    const items = [];
    linkParents(root);
    (function walk(n) {
      n.children.forEach(function (c) {
        ['deadline', 'scheduled'].forEach(function (kind) {
          const d = c[kind];
          if (!d) return;
          const delta = daysBetween(today, d);
          if (delta === null) return;
          if (delta >= 0 && delta <= days) {
            items.push({ node: c, kind: kind, date: d, overdue: false, daysOut: delta });
          } else if (delta < 0 && c.state !== 'DONE') {
            items.push({ node: c, kind: kind, date: d, overdue: true, daysOut: delta });
          }
        });
        walk(c);
      });
    })(root);
    items.sort(function (a, b) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });
    return items;
  }

  function findNodeById(root, id) {
    let found = null;
    (function walk(n) {
      if (found) return;
      n.children.forEach(function (c) { if (c.id === id) found = c; else walk(c); });
    })(root);
    return found;
  }

  function countStats(root) {
    let total = 0, done = 0;
    (function walk(n) {
      n.children.forEach(function (c) {
        total++;
        if (c.state === 'DONE') done++;
        walk(c);
      });
    })(root);
    return { total: total, done: done };
  }

  return {
    TODO_STATES: TODO_STATES,
    todayStr: todayStr, parseDate: parseDate, dateToStr: dateToStr,
    addDays: addDays, daysBetween: daysBetween, dayName: dayName, humanDate: humanDate,
    parseDateInput: parseDateInput,
    WEEKDAYS: WEEKDAYS, MONTHS: MONTHS,
    makeNode: makeNode, parseHeadlineLine: parseHeadlineLine,
    parse: parse, serialize: serialize, flatten: flatten,
    toggleCollapsed: toggleCollapsed, cycleState: cycleState,
    setDeadline: setDeadline, setScheduled: setScheduled,
    addTag: addTag, removeTag: removeTag,
    insertSiblingAfter: insertSiblingAfter, insertSiblingBefore: insertSiblingBefore,
    insertChildEnd: insertChildEnd,
    linkParents: linkParents, removeNode: removeNode,
    moveNodeAmongSiblings: moveNodeAmongSiblings,
    demoteNode: demoteNode, promoteNode: promoteNode,
    agenda: agenda, findNodeById: findNodeById, countStats: countStats,
  };
});
